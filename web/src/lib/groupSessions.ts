import type { SessionProject } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'
import { getPathDisplayName } from '@/utils/path'

export type SessionGroup = {
    key: string
    directory: string
    displayName: string
    machineId: string | null
    sessions: SessionSummary[]
    latestUpdatedAt: number
    hasActiveSession: boolean
    hasPinnedSession: boolean
    project?: SessionProject
    sourceProjectSessionId?: string
}

/** The group directory is a creation target; member metadata.path remains its real cwd. */
export function groupSessionsByProjectOrDirectory(sessions: SessionSummary[]): SessionGroup[] {
    const groups = new Map<string, { directory: string; machineId: string | null; sessions: SessionSummary[]; project?: SessionProject }>()
    for (const session of sessions) {
        const project = session.metadata?.project
        const path = project?.directory ?? session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
        const machineId = session.metadata?.machineId ?? null
        const key = project ? 'project::' + JSON.stringify([machineId ?? '__unknown__', project.id]) : (machineId ?? '__unknown__') + '::' + path
        let group = groups.get(key)
        if (!group) {
            group = { directory: path, machineId, sessions: [], ...(project ? { project } : {}) }
            groups.set(key, group)
        }
        if (project && session.id === project.controllerSessionId) {
            group.project = project
            group.directory = project.directory
        }
        group.sessions.push(session)
    }
    return [...groups.entries()].map(([key, group]): SessionGroup => {
        const project = group.project
        const sorted = [...group.sessions].sort((a, b) => {
            if (project && (a.id === project.controllerSessionId) !== (b.id === project.controllerSessionId)) return a.id === project.controllerSessionId ? -1 : 1
            const pinA = Boolean(a.pinned || (project && a.globalPinned))
            const pinB = Boolean(b.pinned || (project && b.globalPinned))
            if (pinA !== pinB) return pinA ? -1 : 1
            const rankA = a.active ? (a.pendingRequestsCount > 0 ? 0 : 1) : 2
            const rankB = b.active ? (b.pendingRequestsCount > 0 ? 0 : 1) : 2
            return rankA - rankB || b.updatedAt - a.updatedAt
        })
        return {
            key, directory: group.directory,
            displayName: project?.name ?? (group.directory === '/home/ubuntu/workspace' ? '系统通用' : getPathDisplayName(group.directory)),
            machineId: group.machineId,
            sessions: sorted, latestUpdatedAt: sorted.reduce((max, session) => Math.max(max, session.updatedAt), -Infinity),
            hasActiveSession: sorted.some(session => session.active),
            hasPinnedSession: sorted.some(session => session.pinned || (project && session.globalPinned)),
            ...(project ? { project, sourceProjectSessionId: sorted.find(session => session.id === project.controllerSessionId)?.id ?? sorted[0].id } : {})
        }
    }).sort((a, b) => Number(b.hasPinnedSession) - Number(a.hasPinnedSession)
        || Number(b.hasActiveSession) - Number(a.hasActiveSession) || b.latestUpdatedAt - a.latestUpdatedAt)
}
