import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import { composeInputRequestNotification, getFirstPendingRequest } from '../notifications/inputRequest'

function buildSessionUrl(baseUrl: string, sessionId: string): string {
    try {
        return new URL(`/sessions/${sessionId}`, baseUrl).toString()
    } catch {
        const normalized = baseUrl.replace(/\/+$/, '')
        return `${normalized}/sessions/${sessionId}`
    }
}

export class ServerChanChannel implements NotificationChannel {
    constructor(
        private readonly sendKey: string,
        private readonly publicUrl: string,
        private readonly visibilityTracker: VisibilityTracker | null = null,
        private readonly backgroundOnly = false,
        private readonly isDirectWeixinReply: (session: Session) => boolean = () => false
    ) {}

    async sendReady(session: Session): Promise<void> {
        if (!session.active || this.shouldSuppress(session) || this.isDirectWeixinReply(session)) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send('HAPI Ready for input', `${agentName} 正在等待输入\n\n会话：${name}\n\n${url}`)
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active || this.shouldSuppress(session)) {
            return
        }

        const name = getSessionName(session)
        const pending = getFirstPendingRequest(session)
        const request = pending?.request
        const inputNotification = composeInputRequestNotification(session, pending)
        const toolName = request?.tool ? ` (${request.tool})` : ''
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send(
            inputNotification ? `HAPI ${inputNotification.title}` : 'HAPI Permission Request',
            `${inputNotification?.body ?? `${name}${toolName}`}\n\n${url}`
        )
    }

    async sendTaskNotification(session: Session, notification: TaskNotification): Promise<void> {
        if (!session.active || this.shouldSuppress(session)) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const status = notification.status?.trim().toLowerCase()
        const isFailure = status === 'failed' || status === 'error' || status === 'killed' || status === 'aborted'
        if (!isFailure) {
            return
        }
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send('HAPI Task failed', `${agentName} · ${name}\n\n${notification.summary}\n\n${url}`)
    }

    async sendSessionCompletion(session: Session, _reason: SessionEndReason): Promise<void> {
        if (this.shouldSuppress(session)) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send('HAPI Session completed', `${agentName} · ${name}\n\n会话已结束。\n\n${url}`)
    }

    private async send(title: string, desp: string): Promise<void> {
        const url = `https://sctapi.ftqq.com/${this.sendKey}.send`
        const body = new URLSearchParams({
            title,
            desp
        })

        let response: Response
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded'
                },
                body,
                signal: AbortSignal.timeout(10000),
                redirect: 'error'
            })
        } catch {
            // fetch errors can contain the URL, whose path holds the SendKey.
            // The provider may have accepted the POST before a timeout; never retry here.
            throw new Error('Server酱请求超时或网络失败，发送结果未知')
        }

        if (!response.ok) {
            throw new Error(`Server酱发送失败: HTTP ${response.status}`)
        }
        const result: unknown = await response.json().catch(() => null)
        if (!result || typeof result !== 'object' || !('code' in result) || typeof result.code !== 'number') {
            throw new Error('Server酱回执无有效业务码，发送结果未知')
        }
        if (result.code !== 0) {
            // Do not echo provider messages/bodies, which may contain sensitive request data.
            throw new Error(`Server酱未接受消息: 业务码 ${result.code}`)
        }
    }

    private shouldSuppress(session: Session): boolean {
        return this.backgroundOnly
            && this.visibilityTracker !== null
            && this.visibilityTracker.hasVisibleConnection(session.namespace)
    }
}
