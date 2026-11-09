import { describe, expect, it } from 'vitest'
import type { SessionProject } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'
import { groupSessionsByProjectOrDirectory } from './groupSessions'

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return { id, active: false, thinking: false, activeAt: 0, updatedAt: 1, metadataVersion: 1, agentStateVersion: 0,
        todosUpdatedAt: 0, todoProgress: null, pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
        futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null,
        metadata: { path: '/repo', machineId: 'm1' }, ...overrides }
}
const project: SessionProject = { id: 'FF', name: '家庭记账', directory: '/workspace/family-finance', controllerSessionId: 'ctrl', role: 'controller' }

describe('session project and legacy directory groups', () => {
    it('keeps empty input empty', () => expect(groupSessionsByProjectOrDirectory([])).toEqual([]))
    it('preserves legacy keys, worktree base paths, pinned groups and active row priority', () => {
        const rows = [session('a', { updatedAt: 20, metadata: { path: '/repo/tree', machineId: 'm1', worktree: {
            basePath: '/repo', branch: 'feature', name: 'tree', worktreePath: '/repo/tree', createdAt: 1
        } } }), session('b', { updatedAt: 10, active: true, pendingRequestsCount: 1 }), session('c', {
            updatedAt: 30, pinned: true, metadata: { path: '/other', machineId: 'm1' }
        })]
        const before = JSON.stringify(rows)
        const groups = groupSessionsByProjectOrDirectory(rows)
        expect(groups.map(group => group.key)).toEqual(['m1::/other', 'm1::/repo'])
        expect(groups[1].sessions.map(row => row.id)).toEqual(['b', 'a'])
        expect(groups[1].displayName).toBe('repo')
        expect(groups[1].project).toBeUndefined()
        expect(JSON.stringify(rows)).toBe(before)
    })
    it('keeps the controller and research in one project while retaining their different actual directories', () => {
        const rows = [session('a', { active: true, globalPinned: true, updatedAt: 100, metadata: { path: project.directory, machineId: 'm1',
            project: { ...project, role: 'research', createdFromSessionId: 'ctrl' } } }), session('ctrl', { metadata: { path: '/workspace', machineId: 'm1', project } })]
        const before = JSON.stringify(rows)
        const groups = groupSessionsByProjectOrDirectory(rows)
        expect(groups).toHaveLength(1)
        expect(groups[0]).toMatchObject({ displayName: '家庭记账', directory: project.directory, machineId: 'm1', sourceProjectSessionId: 'ctrl', hasPinnedSession: true })
        expect(groups[0].sessions.map(row => row.id)).toEqual(['ctrl', 'a'])
        expect(groups[0].sessions[0].metadata?.path).toBe('/workspace')
        expect(groups[0].project?.role).toBe('controller')
        expect(JSON.stringify(rows)).toBe(before)
    })
    it('separates machines, projects and an unknown machine even when paths coincide', () => {
        const rows = [session('a', { metadata: { path: '/same', machineId: 'm1', project } }),
            session('b', { metadata: { path: '/same', machineId: 'm2', project } }),
            session('c', { metadata: { path: '/same', machineId: 'm1', project: { ...project, id: 'OTHER' } } }),
            session('d', { metadata: { path: '/same', project } })]
        const groups = groupSessionsByProjectOrDirectory(rows)
        expect(groups).toHaveLength(4)
        expect(new Set(groups.map(group => group.key)).size).toBe(4)
        expect(groups.find(group => group.machineId === null)?.sourceProjectSessionId).toBe('d')
    })
    it('uses an actual visible member when the controller is not in the filtered set', () => {
        const rows = [session('a', { metadata: { path: project.directory, machineId: 'm1', project: { ...project, role: 'research' } } })]
        expect(groupSessionsByProjectOrDirectory(rows)[0].sourceProjectSessionId).toBe('a')
    })
})
