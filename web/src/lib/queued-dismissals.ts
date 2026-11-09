import type { DecryptedMessage } from '@/types/api'

// Independent of the evictable transcript cache. Only opaque identifiers are
// stored, never message text or a claim that the native task was cancelled.
const PREFIX = 'hapi:queued-dismissal:v1:'

function key(sessionId: string, localId: string): string {
    return `${PREFIX}${encodeURIComponent(sessionId)}:${encodeURIComponent(localId)}`
}

export class QueueDismissalStorageError extends Error {
    constructor() {
        super('Could not persist queued-message dismissal')
        this.name = 'QueueDismissalStorageError'
    }
}

export type QueuedDismissalClearFailureListener = () => void

// AUD-16: a dismissal cleanup that did not complete (the removal threw, or the
// removal could not be observed afterwards) must never be reported as a
// success. Such a cleanup is remembered per session and per local id.
//
// The record is deliberately kept in memory only. It describes this page load
// and is never written to localStorage or sessionStorage, so there is no new
// durable protocol, no replay and no cross-tab protocol attached to it. A
// reload starts from a clean slate; a stale durable dismissal can therefore
// hide the row again after a refresh (see the limits section of the handoff).
const pendingClearFailures = new Map<string, Set<string>>()

// One subscriber set per session: a failure in one session never notifies the
// subscribers of another session.
const clearFailureSubscribers = new Map<string, Set<QueuedDismissalClearFailureListener>>()

export function persistQueuedDismissal(sessionId: string, message: DecryptedMessage): void {
    if (message.deliveryState !== 'indeterminate' || message.invokedAt !== null) return
    const dismissalId = message.localId ?? message.id
    try {
        const storageKey = key(sessionId, dismissalId)
        localStorage.setItem(storageKey, message.id)
        if (localStorage.getItem(storageKey) !== message.id) throw new Error('Write not retained')
    } catch {
        // The caller restores the visible row; a transient hide is not success.
        // A rejected write leaves an earlier cleanup failure untouched: the
        // row may not be hideable again until a write is accepted.
        throw new QueueDismissalStorageError()
    }
    // The user asked for a fresh dismissal and the write was read back, so the
    // row may be hidden again and the previous cleanup failure is resolved.
    resolvePendingClearFailure(sessionId, dismissalId)
}

export function clearQueuedDismissals(sessionId: string, localIds: string[]): void {
    if (localIds.length === 0) return
    const failed: string[] = []
    for (const localId of localIds) {
        let removed = false
        try {
            const storageKey = key(sessionId, localId)
            localStorage.removeItem(storageKey)
            // A removal that cannot be observed is not a removal: some engines
            // fail silently and a patched storage can ignore the call.
            removed = localStorage.getItem(storageKey) === null
        } catch {
            removed = false
        }
        // Every id is attempted; one failing removal never stops the batch and
        // never throws, so the SSE pump and the consumption path keep running.
        if (!removed) failed.push(localId)
    }
    applyClearOutcome(sessionId, localIds, failed)
}

export function restoreQueuedDismissals(sessionId: string, messages: DecryptedMessage[]): DecryptedMessage[] {
    let changed = false
    const restored = messages.map((message) => {
        const dismissalId = message.localId ?? message.id
        if (message.invokedAt != null) {
            // A consumed row is authoritative: the durable record is dropped so
            // the next render cannot resurrect a stale hold. The cleanup is
            // still attempted, and a failed cleanup stays visible to the user.
            clearQueuedDismissals(sessionId, [dismissalId])
            const consumedPending = pendingClearFailures.get(sessionId)
            if (consumedPending?.has(dismissalId) && message.queueDismissed !== undefined) {
                changed = true
                return withoutDismissal(message)
            }
            return message
        }
        const pending = pendingClearFailures.get(sessionId)
        if (pending?.has(dismissalId)) {
            // AUD-16: the cleanup of this dismissal never completed, so neither
            // the stale durable entry nor a cached flag may hide the row. Only
            // the dismissal flag is stripped; the business state is untouched.
            if (message.queueDismissed !== undefined) {
                changed = true
                return withoutDismissal(message)
            }
            return message
        }
        if (message.deliveryState !== 'indeterminate' || message.queueDismissed) return message
        try {
            if (localStorage.getItem(key(sessionId, dismissalId)) === message.id) {
                changed = true
                return { ...message, queueDismissed: true }
            }
        } catch { /* Keep the row visible if storage cannot be read. */ }
        return message
    })
    return changed ? restored : messages
}

// Reports whether a dismissal cleanup for this session is still unfinished.
// The value is a plain boolean so it can be used as a useSyncExternalStore
// snapshot.
export function getQueuedDismissalClearFailed(sessionId: string): boolean {
    const pending = pendingClearFailures.get(sessionId)
    return pending !== undefined && pending.size > 0
}

// Notifies the session subscribers when a cleanup fails and when it is
// resolved again. The returned function cancels the subscription.
export function subscribeQueuedDismissalClearFailure(
    sessionId: string,
    listener: QueuedDismissalClearFailureListener,
): () => void {
    let listeners = clearFailureSubscribers.get(sessionId)
    if (!listeners) {
        listeners = new Set<QueuedDismissalClearFailureListener>()
        clearFailureSubscribers.set(sessionId, listeners)
    }
    listeners.add(listener)
    let active = true
    return () => {
        if (!active) return
        active = false
        const current = clearFailureSubscribers.get(sessionId)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) clearFailureSubscribers.delete(sessionId)
    }
}

function withoutDismissal(message: DecryptedMessage): DecryptedMessage {
    const { queueDismissed: _queueDismissed, ...rest } = message
    return rest
}

function resolvePendingClearFailure(sessionId: string, localId: string): void {
    const pending = pendingClearFailures.get(sessionId)
    if (!pending) return
    if (!pending.delete(localId)) return
    if (pending.size === 0) pendingClearFailures.delete(sessionId)
    notifyClearFailureSubscribers(sessionId)
}

function applyClearOutcome(sessionId: string, attempted: string[], failed: string[]): void {
    const failedSet = new Set(failed)
    let pending = pendingClearFailures.get(sessionId)
    let changed = false
    for (const localId of attempted) {
        if (failedSet.has(localId)) continue
        if (pending?.delete(localId)) changed = true
    }
    if (failed.length > 0) {
        if (!pending) {
            pending = new Set<string>()
            pendingClearFailures.set(sessionId, pending)
            changed = true
        }
        for (const localId of failed) {
            if (!pending.has(localId)) {
                pending.add(localId)
                changed = true
            }
        }
    }
    if (pending && pending.size === 0) {
        pendingClearFailures.delete(sessionId)
        changed = true
    }
    if (changed) notifyClearFailureSubscribers(sessionId)
}

function notifyClearFailureSubscribers(sessionId: string): void {
    const listeners = clearFailureSubscribers.get(sessionId)
    if (!listeners || listeners.size === 0) return
    // The snapshot keeps a subscriber that unsubscribes during the
    // notification from skipping the others.
    for (const listener of Array.from(listeners)) {
        if (!listeners.has(listener)) continue
        try {
            listener()
        } catch (error) {
            // A broken subscriber is never reported as a storage failure and
            // never stops the remaining subscribers.
            reportSubscriberError(error)
        }
    }
}

function reportSubscriberError(error: unknown): void {
    try {
        const target = globalThis.console
        if (target && typeof target.error === 'function') {
            target.error('[queued-dismissals] clear failure subscriber threw', error)
        }
    } catch { /* Reporting a subscriber failure must never throw either. */ }
}
