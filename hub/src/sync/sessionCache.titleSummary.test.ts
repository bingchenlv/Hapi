import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => events.push(event)
    } as unknown as EventPublisher
}

describe('SessionCache.updateSessionSummary', () => {
    it('syncs numbered titles, persists across reload and respects explicit manual renaming', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const created = cache.getOrCreateSession('numbered', {
            path: '/tmp', host: 'localhost', flavor: 'codex', name: 'Codex-03', codexAutoNameSequence: 3
        }, null, 'default')
        const originalUpdatedAt = store.sessions.getSession(created.id)?.updatedAt
        await cache.updateSessionSummary(created.id, 'First task')
        await cache.updateSessionSummary(created.id, 'Second task')
        expect(cache.getSession(created.id)?.metadata).toMatchObject({
            name: 'Second task', codexAutoNameTitle: 'Second task', codexAutoNameSequence: 3
        })
        expect(store.sessions.getSession(created.id)?.updatedAt).toBe(originalUpdatedAt)
        const reloaded = new SessionCache(store, createPublisher([]))
        expect(reloaded.refreshSession(created.id)?.metadata?.name).toBe('Second task')
        await cache.renameSession(created.id, 'Second task')
        await cache.updateSessionSummary(created.id, 'Third task')
        expect(cache.getSession(created.id)?.metadata?.name).toBe('Second task')
        expect(cache.getSession(created.id)?.metadata?.summary?.text).toBe('Third task')
        expect(events.some(event => event.type === 'session-updated')).toBe(true)
    })

    it('backfills stored titles on load and does not overwrite titles arriving before numbering', async () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const stored = store.sessions.getOrCreateSession('legacy', {
            path: '/tmp', host: 'localhost', flavor: 'codex', name: 'Codex-02', summary: { text: 'Historical task', updatedAt: 1 }
        }, null, 'default')
        expect(cache.refreshSession(stored.id)?.metadata).toMatchObject({ name: 'Historical task', codexAutoNameSequence: 2 })
        const created = cache.getOrCreateSession('early-title', {
            path: '/tmp', host: 'localhost', flavor: 'codex', summary: { text: 'Fast title', updatedAt: 1 }
        }, null, 'default')
        await cache.assignCodexAutoName(created.id, 4, 'Codex-04')
        expect(cache.getSession(created.id)?.metadata).toMatchObject({ name: 'Fast title', codexAutoNameSequence: 4 })
        const native = cache.getOrCreateSession('early-native-title', {
            path: '/tmp', host: 'localhost', flavor: 'codex', name: 'Native title'
        }, null, 'default')
        await cache.assignCodexAutoName(native.id, 5, 'Codex-05')
        expect(cache.getSession(native.id)?.metadata).toMatchObject({
            name: 'Native title', codexAutoNameSequence: 5, codexAutoNameTitle: 'Native title'
        })
    })

    it('preserves metadata.name while stamping the generated summary timestamp', async () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const created = cache.getOrCreateSession(
            'summary-session',
            { path: '/tmp', host: 'localhost', name: 'Manual name' },
            null,
            'default'
        )

        await cache.updateSessionSummary(created.id, 'Generated title')

        const updated = cache.getSession(created.id)
        expect(updated?.metadata?.name).toBe('Manual name')
        expect(updated?.metadata?.summary?.text).toBe('Generated title')
        expect(updated?.metadata?.summary?.updatedAt).toBeGreaterThan(0)

        const stored = store.sessions.getSession(created.id)
        expect(stored?.metadata).toMatchObject({
            name: 'Manual name',
            summary: { text: 'Generated title' }
        })
    })
})
