import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { clearQueuedDismissals, persistQueuedDismissal, QueueDismissalStorageError, restoreQueuedDismissals } from './queued-dismissals'

const row: DecryptedMessage = {
    id: 'server-held', localId: 'local-held', createdAt: 1000, seq: 1,
    invokedAt: null, deliveryState: 'indeterminate',
    content: { role: 'user', content: { type: 'text', text: 'private body' } },
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear() })

describe('durable queued card dismissal', () => {
    it('survives a fresh module and an empty transcript cache without changing delivery state', async () => {
        persistQueuedDismissal('session-a', row)
        vi.resetModules()
        const store = await import('./message-window-store')
        store.ingestIncomingMessages('session-a', [row])
        const held = store.getMessageWindowState('session-a').messages[0]
        expect(held).toMatchObject({ queueDismissed: true, invokedAt: null, deliveryState: 'indeterminate' })
        expect(JSON.stringify(localStorage)).not.toContain('private body')
        store.clearMessageWindow('session-a')
        store.ingestIncomingMessages('session-a', [row])
        expect(store.getMessageWindowState('session-a').messages[0].queueDismissed).toBe(true)
    })

    it('does not hide another session or a different server message with the same local ID', () => {
        persistQueuedDismissal('session-a', row)
        expect(restoreQueuedDismissals('session-b', [row])[0].queueDismissed).toBeUndefined()
        expect(restoreQueuedDismissals('session-a', [{ ...row, id: 'different' }])[0].queueDismissed).toBeUndefined()
    })

    it('does not copy a source session dismissal when seeding a new session', async () => {
        persistQueuedDismissal('seed-from', row)
        const store = await import('./message-window-store')
        store.ingestIncomingMessages('seed-from', [row])
        store.seedMessageWindowFromSession('seed-from', 'seed-to')
        expect(store.getMessageWindowState('seed-from').messages[0].queueDismissed).toBe(true)
        expect(store.getMessageWindowState('seed-to').messages[0].queueDismissed).toBeUndefined()
    })

    it('clears on an explicit requeue even when the message is outside the window', async () => {
        persistQueuedDismissal('off-window', row)
        const store = await import('./message-window-store')
        store.markMessagesRequeued('off-window', [row.localId!])
        expect(restoreQueuedDismissals('off-window', [row])[0].queueDismissed).toBeUndefined()
    })

    it('clears on a consumed acknowledgement even outside the window', async () => {
        persistQueuedDismissal('consumed', row)
        const store = await import('./message-window-store')
        store.markMessagesConsumed('consumed', [row.localId!], 2000)
        expect(restoreQueuedDismissals('consumed', [row])[0].queueDismissed).toBeUndefined()
    })

    it('clears when the server returns the authoritative consumed row', () => {
        persistQueuedDismissal('session-a', row)
        const sent = { ...row, invokedAt: 2000 }
        expect(restoreQueuedDismissals('session-a', [sent])[0]).toEqual(sent)
        expect(restoreQueuedDismissals('session-a', [row])[0].queueDismissed).toBeUndefined()
    })

    it('does not hide an ordinary queued row or erase the hold on a stale queued snapshot', () => {
        persistQueuedDismissal('session-a', row)
        const queued = { ...row, deliveryState: undefined }
        expect(restoreQueuedDismissals('session-a', [queued])[0].queueDismissed).toBeUndefined()
        expect(restoreQueuedDismissals('session-a', [row])[0].queueDismissed).toBe(true)
        clearQueuedDismissals('session-a', [row.localId!])
        expect(restoreQueuedDismissals('session-a', [row])[0].queueDismissed).toBeUndefined()
    })

    it('rejects a failed durable write and leaves the row visible', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota') })
        expect(() => persistQueuedDismissal('session-a', row)).toThrow(QueueDismissalStorageError)
        expect(restoreQueuedDismissals('session-a', [row])[0].queueDismissed).toBeUndefined()
    })

    it('does not record a dismissal for an unconfirmed ordinary cancel', () => {
        persistQueuedDismissal('session-a', { ...row, deliveryState: undefined })
        expect(localStorage.length).toBe(0)
    })

    it('keeps the original requeue-to-unknown counterexample visible after cleanup fails', async () => {
        const sessionId = 'aud16-original-requeue'
        // A previous test resets modules; use the same live instance as the store.
        const dismissal = await import('./queued-dismissals')
        const store = await import('./message-window-store')
        dismissal.persistQueuedDismissal(sessionId, row)
        store.ingestIncomingMessages(sessionId, [row])
        expect(store.getMessageWindowState(sessionId).messages[0].queueDismissed).toBe(true)
        const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
            throw new Error('storage removal denied')
        })
        expect(() => store.markMessagesRequeued(sessionId, [row.localId!])).not.toThrow()
        expect(dismissal.getQueuedDismissalClearFailed(sessionId)).toBe(true)
        remove.mockRestore()
        store.markMessagesIndeterminate(sessionId, [row.localId!])
        expect(store.getMessageWindowState(sessionId).messages[0]).toMatchObject({
            invokedAt: null, deliveryState: 'indeterminate',
        })
        expect(store.getMessageWindowState(sessionId).messages[0].queueDismissed).toBeUndefined()
        dismissal.clearQueuedDismissals(sessionId, [row.localId!])
        expect(dismissal.getQueuedDismissalClearFailed(sessionId)).toBe(false)
        store.clearMessageWindow(sessionId)
    })
})
