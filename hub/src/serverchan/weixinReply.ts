import { extractAssistantPlainText, unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { Session } from '../sync/syncEngine'
import type { Store } from '../store'

/** Suppress only a correlated WeChat reply, never every event in a session. */
export function isWeixinReply(session: Session, store: Pick<Store, 'messages'>): boolean {
    try {
        const turns = session.metadata?.conversationHistoryTurns
        if (!turns) return false
        const messages = store.messages.getMessages(session.id, 40)
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const message = messages[i]
            const record = unwrapRoleWrappedRecordEnvelope(message.content)
            // A later invoked prompt invalidates an earlier answer. Merely queued
            // messages must not change the origin of the answer being completed.
            if (record?.role === 'user' && message.invokedAt !== null) return false
            if (record?.role !== 'agent' || !extractAssistantPlainText(record.content)?.trim()) continue
            const identity = /^codex:([^:]+):([^:]+):([^:]+):agent_message$/.exec(message.localId ?? '')
            if (!identity) return false
            const localIds = Object.entries(turns).filter(([, turn]) => turn === identity[2]).map(([id]) => id)
            // Mixed-origin steered turns and missing evidence stay eligible for
            // notifications. Never infer source from message text or chat name.
            return localIds.length > 0 && localIds.every(id => /^weixin:[a-f0-9]{32}$/.test(id))
        }
    } catch {
        // Source lookup failure must not hide a notification.
    }
    return false
}
