/**
 * Native resource retirement for the thread a provider switch leaves behind.
 *
 * A provider switch forks the running conversation into a new native thread and
 * rebinds the HAPI session to it. The retired native thread stays loaded in the
 * Codex app-server, which keeps its HAPI MCP child process alive for the rest
 * of the runtime's life. The supported way to release those resources is one
 * native `thread/archive` on the retired thread, issued through the owning
 * runtime's own native control connection.
 *
 * The archive is a native side effect, so this module is at-most-once by
 * construction:
 *
 *   1. the intent ("requested") is written durably before the side effect, so a
 *      crash can never hide that an archive was in flight;
 *   2. the archive is attempted exactly once. A definite rejection and an
 *      unknown outcome are both terminal here: nothing in this module retries
 *      them and nothing asks anybody else to retry them;
 *   3. every failure is reported honestly, in a user-readable notice and in a
 *      durable status. A cleanup problem never turns an already committed
 *      provider switch into a failed switch, and a confirmed archive is never
 *      downgraded because the final save, the log or the notice failed.
 *   4. failure text is redacted before it is shown or stored, so a quoted
 *      header or key never reaches a notice or a runtime record.
 *
 * Deliberately out of scope: archiving through the Hub, deleting a rollout,
 * rewriting history, touching an alias, changing permissions, restarting
 * anything, and scanning older sessions for threads that still need an archive.
 * Only the thread that this very switch retired is archived, and only once.
 */

export const RETIREMENT_STATUSES = ['not-started', 'requested', 'archived', 'unconfirmed', 'failed'] as const;

export type RetirementStatus = (typeof RETIREMENT_STATUSES)[number];

export type ProviderRetirementRecord = {
    threadId: string;
    sessionId: string;
    status: RetirementStatus;
    requestedAt?: number;
    completedAt?: number;
    error?: string;
};

export type RetirementRecordMap = Record<string, ProviderRetirementRecord>;

export type ProviderRetirementOutcome = {
    threadId: string;
    sessionId: string;
    /** The readable retirement status of this thread. */
    status: RetirementStatus;
    /** The engine confirmed the native archive. */
    archived: boolean;
    /** This call issued the archive request. */
    attempted: boolean;
    /** This call stored the final status durably. */
    persisted: boolean;
    detail?: string;
    error?: string;
};

export type ProviderRetirementStore = {
    read(threadId: string): ProviderRetirementRecord | undefined;
    write(threadId: string, record: ProviderRetirementRecord | undefined): void;
};

/** `rejected` means the engine refused the archive, `unconfirmed` means unknown. */
export type ProviderRetirementFailureKind = 'rejected' | 'unconfirmed';

export type ProviderRetirementOptions = {
    /** The native thread this very switch retired. */
    threadId: string;
    /** The HAPI session that owns the retired thread. */
    sessionId: string;
    /** Durable cleanup state, stored on the runtime record. */
    store: ProviderRetirementStore;
    /** Persist the runtime record. A rejection means nothing is durable yet. */
    persist: () => Promise<void>;
    /** One native `thread/archive` through the runtime's own native control. */
    archive: (threadId: string) => Promise<void>;
    /** Optional guard. A false result skips the retirement without side effects. */
    precondition?: () => boolean | Promise<boolean>;
    /** Tells a definite rejection from an unknown outcome. */
    classifyFailure?: (error: unknown) => ProviderRetirementFailureKind;
    now?: () => number;
    /** Honest user-facing notice about a cleanup problem. */
    notify?: (message: string) => void;
    log?: (message: string, error?: unknown) => void;
};

/**
 * Adapter for the runtime record's durable cleanup map. The map is mirrored
 * into the runtime record on every change so `persist()` can write it out.
 */
export function createRetirementStore(initial: RetirementRecordMap | undefined,
    apply: (records: RetirementRecordMap | undefined) => void): ProviderRetirementStore {
    let records: RetirementRecordMap = { ...(initial ?? {}) };
    return {
        read: threadId => records[threadId],
        write: (threadId, record) => {
            const next: RetirementRecordMap = { ...records };
            if (record) next[threadId] = record; else delete next[threadId];
            records = next;
            apply(Object.keys(records).length ? records : undefined);
        }
    };
}

/** A readable sentence for every status, including the ones that are not clean. */
export function describeRetirementStatus(status: RetirementStatus): string {
    switch (status) {
        case 'archived': return 'the retired native thread was archived and its native resources were released';
        case 'requested': return 'the archive of the retired native thread was requested but never confirmed';
        case 'unconfirmed': return 'the archive of the retired native thread is unconfirmed and will not be retried automatically';
        case 'failed': return 'the engine rejected the archive of the retired native thread and it will not be retried automatically';
        case 'not-started': return 'the retired native thread was not archived';
        default: return 'the retirement status is unknown';
    }
}

/** Longest failure text that is ever shown to a user or stored durably. */
export const MAX_FAILURE_TEXT = 300;

/**
 * Removes credentials from a failure text.
 *
 * An upstream failure can quote a request header, an API key or an
 * authenticated URL. This text ends up in a user-facing notice and in a
 * durable runtime record, so it must never carry a secret. Redacting too much
 * is harmless here; leaking a credential is not.
 */
export function redactSensitive(text: string): string {
    return text
        // URL userinfo first: a credential inside a URL must be removed before
        // the key/value rule can mistake `secret:` inside it for a key.
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
        // A sensitive key with any quoting style: JSON ("key":"value"), a
        // single-quoted value, or a bare value. The key may be quoted, the
        // value may contain spaces when it is quoted, and the value is
        // replaced in place so the surrounding structure stays readable.
        // This rule runs before the token shapes so a whole value such as
        // `Authorization: Bearer <secret>` is replaced as one value instead
        // of leaving a half-redacted value behind.
        .replace(/(["']?)\b(authorization|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|pwd|token|credentials?)\b(["']?)(\s*[:=]\s*)(?:(["'])([\s\S]*?)\5|([^\n,;}\]]+?)(\s*)(?=[,;}\]\n]|$))/gi,
            (_match, keyQuote: string, key: string, keyClose: string, separator: string,
                valueQuote: string | undefined, quotedValue: string | undefined,
                bareValue: string | undefined, trailingSpace: string | undefined) => {
                const quote = valueQuote ?? '';
                const tail = valueQuote ? '' : (trailingSpace ?? '');
                return `${keyQuote}${key}${keyClose}${separator}${quote}[redacted]${quote}${tail}`;
            })
        // Standalone token shapes that carry no key name.
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]')
        .replace(/\b(?:sk|rk|pk|xox[baprs])[-_][A-Za-z0-9_-]{6,}/gi, '[redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, '[redacted]')
        .replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted]')
}

export function describeRetirementFailure(error: unknown): string {
    const raw = error instanceof Error
        ? (error.message.trim() || error.name)
        : typeof error === 'string'
            ? error
            : (() => { try { const encoded = JSON.stringify(error); return encoded ? encoded : String(error); } catch { return String(error); } })();
    const redacted = redactSensitive(raw);
    return redacted.length > MAX_FAILURE_TEXT ? `${redacted.slice(0, MAX_FAILURE_TEXT)}…` : redacted;
}

/**
 * Retire one native thread that a provider switch left behind.
 *
 * The call never throws: a cleanup problem is reported through the outcome and
 * through `notify`, because the provider switch it follows has already been
 * committed and must stay committed.
 */
export async function retireProviderThread(options: ProviderRetirementOptions): Promise<ProviderRetirementOutcome> {
    const { threadId, sessionId, store, persist, archive } = options;
    const now = options.now ?? (() => Date.now());
    // A failing log or notice callback must never change the outcome of a
    // cleanup that already happened, and must never throw into the switch.
    const rawLog = options.log ?? (() => { });
    const log = (message: string) => { try { rawLog(message); } catch { } };
    const rawNotify = options.notify ?? (() => { });
    const notify = (message: string) => {
        try { rawNotify(message); }
        catch (error) { log(`[Codex shared] retirement notice could not be delivered: ${describeRetirementFailure(error)}`); }
    };
    const classify = options.classifyFailure ?? (() => 'unconfirmed' as const);
    const base = { threadId, sessionId, archived: false, attempted: false, persisted: false };

    if (!threadId || !sessionId) {
        return { ...base, status: 'not-started', error: 'A retirement needs both a native thread ID and a HAPI session ID' };
    }

    try {
        // The retired thread must be the one this switch released. Nothing else
        // is ever archived, and the new thread is never touched.
        if (options.precondition && !(await options.precondition())) {
            return { ...base, status: 'not-started', detail: 'The retired thread is still in use' };
        }

        // A durable record already exists: this archive was requested before.
        // Unknown outcomes and rejections are never replayed.
        const existing = store.read(threadId);
        if (existing) {
            return { ...base, status: existing.status, archived: existing.status === 'archived',
                detail: 'A retirement record already exists for this thread; the archive is never replayed', error: existing.error };
        }

        // 1. The intent becomes durable before any side effect runs.
        const requested: ProviderRetirementRecord = { threadId, sessionId, status: 'requested', requestedAt: now() };
        store.write(threadId, requested);
        try {
            await persist();
        } catch (error) {
            // The intent never reached durable storage, so no side effect may run.
            // The guard record stays in place: a later attempt in this process
            // must not turn a lost intent into a second archive.
            const reason = describeRetirementFailure(error);
            const guard: ProviderRetirementRecord = { threadId, sessionId, status: 'not-started', requestedAt: requested.requestedAt, completedAt: now(), error: reason };
            store.write(threadId, guard);
            let persisted = false;
            try { await persist(); persisted = true; }
            catch (persistError) { log(`[Codex shared] retirement guard not persisted for ${threadId}: ${describeRetirementFailure(persistError)}`); }
            log(`[Codex shared] retirement intent not persisted for ${threadId}: ${reason}`);
            notify(`The previous native thread ${threadId} was not archived: the cleanup request could not be saved (${reason}). No archive was attempted and the model provider switch itself succeeded.`);
            return { ...base, status: 'not-started', persisted,
                detail: 'The cleanup request was not saved, so no archive was attempted and none will be attempted automatically',
                error: reason };
        }

        // 2. Exactly one archive attempt. It is never repeated.
        try {
            await archive(threadId);
        } catch (error) {
            const reason = describeRetirementFailure(error);
            const kind = classify(error);
            const status: RetirementStatus = kind === 'rejected' ? 'failed' : 'unconfirmed';
            const record: ProviderRetirementRecord = { threadId, sessionId, status, requestedAt: requested.requestedAt, completedAt: now(), error: reason };
            store.write(threadId, record);
            let persisted = false;
            try { await persist(); persisted = true; }
            catch (persistError) { log(`[Codex shared] retirement failure status not persisted for ${threadId}: ${describeRetirementFailure(persistError)}`); }
            notify(kind === 'rejected'
                ? `The previous native thread ${threadId} could not be archived: the engine rejected the request (${reason}). The model provider switch succeeded and the archive will not be retried automatically.`
                : `The archive of the previous native thread ${threadId} is unconfirmed (${reason}). The model provider switch succeeded and the archive will not be retried automatically; inspect the runtime before acting.`);
            return { ...base, status, attempted: true, persisted, error: reason };
        }

        // 3. The engine confirmed the archive. A failed final save is reported,
        // but the confirmed archive is never replayed.
        const record: ProviderRetirementRecord = { threadId, sessionId, status: 'archived', requestedAt: requested.requestedAt, completedAt: now() };
        store.write(threadId, record);
        let persisted = false;
        try { await persist(); persisted = true; }
        catch (error) {
            // The archive is confirmed: the cleanup happened. Only the record
            // is missing, and that is reported honestly instead of silently.
            const reason = describeRetirementFailure(error);
            log(`[Codex shared] retirement status not persisted for ${threadId}: ${reason}; the confirmed archive must not be replayed`);
            notify(`The previous native thread ${threadId} was archived and its native resources were released, but the cleanup record could not be saved (${reason}). The archive is confirmed and it will not be repeated.`);
        }
        return { ...base, status: 'archived', archived: true, attempted: true, persisted,
            detail: persisted ? undefined : 'The archive was confirmed but the final status could not be saved; it must not be replayed' };
    } catch (error) {
        // Cleanup must never break an already committed provider switch.
        const reason = describeRetirementFailure(error);
        log(`[Codex shared] retirement failed for ${threadId}: ${reason}`);
        notify(`The previous native thread ${threadId} could not be released (${reason}). The model provider switch succeeded.`);
        return { ...base, status: 'unconfirmed', error: reason };
    }
}
