import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import {
    clearQueuedDismissals,
    getQueuedDismissalClearFailed,
    persistQueuedDismissal,
    QueueDismissalStorageError,
    restoreQueuedDismissals,
    subscribeQueuedDismissalClearFailure,
} from './queued-dismissals'

// AUD-16 regression suite: a dismissal cleanup that could not be performed
// (or could not be observed) must stay visible instead of being swallowed.
//
// Every test owns a unique session id on purpose. The module keeps the
// unfinished cleanups in memory only, so unique ids are what isolates the
// tests from each other; every subscription created here is cancelled again.

const baseRow: DecryptedMessage = {
    id: 'server-held', localId: 'local-held', createdAt: 1000, seq: 1,
    invokedAt: null, deliveryState: 'indeterminate',
    content: { role: 'user', content: { type: 'text', text: 'private body' } },
}

function rowFor(localId: string, id = `server-${localId}`): DecryptedMessage {
    return { ...baseRow, id, localId }
}

// The original implementation is captured before any spy is installed so a
// partial failure can let the other removals succeed.
const originalRemoveItem = Storage.prototype.removeItem

interface RemovalFault {
    failing: boolean
    failingKeys?: (storageKey: string) => boolean
}

function mockRemovals(fault: RemovalFault) {
    return vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, storageKey: string) {
        if (fault.failing && (!fault.failingKeys || fault.failingKeys(storageKey))) {
            throw new DOMException('Storage removal denied', 'SecurityError')
        }
        originalRemoveItem.call(this, storageKey)
    })
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear() })

describe('queued dismissal cleanup failures', () => {
    it('reports a removal that throws and keeps the row visible', () => {
        const session = 'aud16-remove-throws'
        persistQueuedDismissal(session, baseRow)
        const listener = vi.fn()
        const unsubscribe = subscribeQueuedDismissalClearFailure(session, listener)

        mockRemovals({ failing: true })

        expect(() => clearQueuedDismissals(session, [baseRow.localId!])).not.toThrow()
        expect(getQueuedDismissalClearFailed(session)).toBe(true)
        expect(listener).toHaveBeenCalledTimes(1)

        // The stale durable dismissal must not hide the row again.
        expect(restoreQueuedDismissals(session, [baseRow])[0].queueDismissed).toBeUndefined()
        // The failure record is page local: no new storage protocol is added.
        expect(sessionStorage.length).toBe(0)
        expect(localStorage.length).toBe(1)

        unsubscribe()
    })

    it('treats a silent no-op removal as a failure', () => {
        const session = 'aud16-silent-noop'
        persistQueuedDismissal(session, baseRow)
        const listener = vi.fn()
        const unsubscribe = subscribeQueuedDismissalClearFailure(session, listener)

        // The removal "succeeds" but the entry is still readable.
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { /* silently ignored */ })

        expect(() => clearQueuedDismissals(session, [baseRow.localId!])).not.toThrow()
        expect(getQueuedDismissalClearFailed(session)).toBe(true)
        expect(listener).toHaveBeenCalledTimes(1)
        expect(restoreQueuedDismissals(session, [baseRow])[0].queueDismissed).toBeUndefined()

        unsubscribe()
    })

    it('tries every id after one removal fails and only keeps the failed id pending', () => {
        const session = 'aud16-partial-batch'
        const ok = rowFor('local-ok')
        const bad = rowFor('local-bad')
        persistQueuedDismissal(session, ok)
        persistQueuedDismissal(session, bad)

        const removeItem = mockRemovals({ failing: true, failingKeys: (storageKey) => storageKey.endsWith('local-bad') })
        expect(() => clearQueuedDismissals(session, [bad.localId!, ok.localId!])).not.toThrow()

        // The failing removal did not stop the batch: both ids were attempted.
        expect(removeItem).toHaveBeenCalledTimes(2)
        expect(getQueuedDismissalClearFailed(session)).toBe(true)

        // The successful removal really happened.
        expect(localStorage.length).toBe(1)
        expect(restoreQueuedDismissals(session, [ok])[0].queueDismissed).toBeUndefined()

        // The failed removal kept its stale entry but may not hide the row.
        expect(restoreQueuedDismissals(session, [bad])[0].queueDismissed).toBeUndefined()

        // A successful cleanup of the failed id resolves the failure state.
        removeItem.mockRestore()
        clearQueuedDismissals(session, [bad.localId!])
        expect(getQueuedDismissalClearFailed(session)).toBe(false)
    })

    it('notifies on failure and on recovery and stays silent after unsubscribe', () => {
        const session = 'aud16-notify'
        const fault: RemovalFault = { failing: true }
        mockRemovals(fault)
        const listener = vi.fn()
        const unsubscribe = subscribeQueuedDismissalClearFailure(session, listener)

        clearQueuedDismissals(session, ['local-x'])
        expect(listener).toHaveBeenCalledTimes(1)
        expect(getQueuedDismissalClearFailed(session)).toBe(true)

        // The same id failing again is not a new state change.
        clearQueuedDismissals(session, ['local-x'])
        expect(listener).toHaveBeenCalledTimes(1)

        fault.failing = false
        clearQueuedDismissals(session, ['local-x'])
        expect(listener).toHaveBeenCalledTimes(2)
        expect(getQueuedDismissalClearFailed(session)).toBe(false)

        unsubscribe()
        fault.failing = true
        clearQueuedDismissals(session, ['local-x'])
        expect(listener).toHaveBeenCalledTimes(2)
        expect(getQueuedDismissalClearFailed(session)).toBe(true)
    })

    it('isolates sessions from each other', () => {
        const sessionA = 'aud16-isolation-a'
        const sessionB = 'aud16-isolation-b'
        const listenerA = vi.fn()
        const listenerB = vi.fn()
        const unsubscribeA = subscribeQueuedDismissalClearFailure(sessionA, listenerA)
        const unsubscribeB = subscribeQueuedDismissalClearFailure(sessionB, listenerB)

        mockRemovals({ failing: true })
        clearQueuedDismissals(sessionA, ['local-x'])

        expect(listenerA).toHaveBeenCalledTimes(1)
        expect(listenerB).not.toHaveBeenCalled()
        expect(getQueuedDismissalClearFailed(sessionA)).toBe(true)
        expect(getQueuedDismissalClearFailed(sessionB)).toBe(false)

        unsubscribeA()
        unsubscribeB()
    })

    it('keeps a throwing subscriber from breaking the cleanup or the other subscribers', () => {
        const session = 'aud16-subscriber-throws'
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { /* keep the output clean */ })
        const broken = vi.fn(() => { throw new Error('subscriber exploded') })
        const healthy = vi.fn()
        const unsubscribeBroken = subscribeQueuedDismissalClearFailure(session, broken)
        const unsubscribeHealthy = subscribeQueuedDismissalClearFailure(session, healthy)

        mockRemovals({ failing: true })
        expect(() => clearQueuedDismissals(session, ['local-x'])).not.toThrow()
        expect(healthy).toHaveBeenCalledTimes(1)
        expect(getQueuedDismissalClearFailed(session)).toBe(true)
        // The subscriber failure is reported as a subscriber failure, never as a
        // storage failure of the cleanup.
        expect(consoleError).toHaveBeenCalled()

        unsubscribeBroken()
        unsubscribeHealthy()
    })

    it('resolves the failure when a new explicit dismissal is persisted', () => {
        const session = 'aud16-new-dismiss'
        persistQueuedDismissal(session, baseRow)
        mockRemovals({ failing: true })
        clearQueuedDismissals(session, [baseRow.localId!])
        expect(getQueuedDismissalClearFailed(session)).toBe(true)
        expect(restoreQueuedDismissals(session, [baseRow])[0].queueDismissed).toBeUndefined()

        // The user dismisses the row again: the write is confirmed, so the row
        // may be hidden once more and the failure state is gone.
        expect(() => persistQueuedDismissal(session, baseRow)).not.toThrow()
        expect(getQueuedDismissalClearFailed(session)).toBe(false)
        expect(restoreQueuedDismissals(session, [baseRow])[0].queueDismissed).toBe(true)
    })

    it('keeps the failure pending when the new dismissal cannot be persisted', () => {
        const session = 'aud16-persist-fails'
        mockRemovals({ failing: true })
        clearQueuedDismissals(session, [baseRow.localId!])
        expect(getQueuedDismissalClearFailed(session)).toBe(true)

        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
        expect(() => persistQueuedDismissal(session, baseRow)).toThrow(QueueDismissalStorageError)
        expect(getQueuedDismissalClearFailed(session)).toBe(true)
    })

    it('strips a cached dismissal flag after a failed cleanup without touching the business state', () => {
        const session = 'aud16-cached-flag'
        persistQueuedDismissal(session, baseRow)
        mockRemovals({ failing: true })
        clearQueuedDismissals(session, [baseRow.localId!])

        const cached = { ...baseRow, queueDismissed: true }
        const restored = restoreQueuedDismissals(session, [cached])
        expect(restored[0].queueDismissed).toBeUndefined()
        expect(restored[0].id).toBe(baseRow.id)
        expect(restored[0].localId).toBe(baseRow.localId)
        expect(restored[0].deliveryState).toBe('indeterminate')
        expect(restored[0].invokedAt).toBeNull()
        expect(restored[0].createdAt).toBe(baseRow.createdAt)
    })

    it('clears a consumed row even when the removal fails and never hides it', () => {
        const session = 'aud16-consumed'
        persistQueuedDismissal(session, baseRow)
        mockRemovals({ failing: true })

        const consumed = { ...baseRow, invokedAt: 2000 }
        const restored = restoreQueuedDismissals(session, [consumed])
        expect(restored[0].invokedAt).toBe(2000)
        expect(restored[0].queueDismissed).toBeUndefined()
        // The cleanup of the authoritative row was attempted and failed.
        expect(getQueuedDismissalClearFailed(session)).toBe(true)
    })

    it('does not let an off-window cleanup failure hide an unrelated row', () => {
        const session = 'aud16-off-window'
        const visible = rowFor('local-visible')
        persistQueuedDismissal(session, visible)
        mockRemovals({ failing: true })

        // The store clears a row that is not part of the visible window.
        clearQueuedDismissals(session, ['local-off-window'])
        expect(getQueuedDismissalClearFailed(session)).toBe(true)

        // Another id of the same session is not affected by that record.
        expect(restoreQueuedDismissals(session, [visible])[0].queueDismissed).toBe(true)
    })

    it('does not hide a row that was never dismissed', () => {
        const session = 'aud16-unknown-row'
        const unknown = rowFor('local-unknown')
        expect(restoreQueuedDismissals(session, [unknown])[0].queueDismissed).toBeUndefined()

        // Not even when another row of the same session failed to clear.
        mockRemovals({ failing: true })
        clearQueuedDismissals(session, ['local-other'])
        expect(getQueuedDismissalClearFailed(session)).toBe(true)
        expect(restoreQueuedDismissals(session, [unknown])[0].queueDismissed).toBeUndefined()
    })

    it('does not break the consumption path when the durable cleanup fails', async () => {
        // A fresh module registry keeps the store and the assertions on the
        // same instance of the module under test.
        vi.resetModules()
        const mod = await import('./queued-dismissals')
        const store = await import('./message-window-store')
        const session = 'aud16-store-consumed'

        mod.persistQueuedDismissal(session, baseRow)
        store.ingestIncomingMessages(session, [baseRow])
        expect(store.getMessageWindowState(session).messages[0].queueDismissed).toBe(true)

        mockRemovals({ failing: true })
        expect(() => store.markMessagesConsumed(session, [baseRow.localId!], 2000)).not.toThrow()
        expect(mod.getQueuedDismissalClearFailed(session)).toBe(true)
        const state = store.getMessageWindowState(session)
        expect(state.messages[0].queueDismissed).toBeUndefined()
        store.clearMessageWindow(session)
    })
})
