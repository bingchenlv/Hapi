import { describe, expect, it, vi } from 'vitest';
import { createRetirementStore, describeRetirementFailure, describeRetirementStatus, redactSensitive, retireProviderThread,
    type ProviderRetirementRecord, type ProviderRetirementStore, type RetirementRecordMap } from './providerRetirement';

const THREAD = 'retired-native-thread';
const SESSION = 'hapi-session-1';

const createHarness = (overrides: { persist?: () => Promise<void>; archive?: (threadId: string) => Promise<void> } = {}) => {
    const calls: string[] = [];
    const records = new Map<string, ProviderRetirementRecord>();
    const store: ProviderRetirementStore = {
        read: threadId => records.get(threadId),
        write: (threadId, record) => {
            calls.push(`write:${threadId}:${record?.status ?? 'none'}`);
            if (record) records.set(threadId, record); else records.delete(threadId);
        }
    };
    // The overrides stay spies: a caller-supplied implementation must still be
    // observable through `toHaveBeenCalledTimes` and friends.
    const persist = vi.fn(overrides.persist ?? (async () => { calls.push('persist'); }));
    const archive = vi.fn(overrides.archive ?? (async (threadId: string) => { calls.push(`archive:${threadId}`); }));
    const notify = vi.fn();
    const log = vi.fn();
    return { calls, records, store, persist, archive, notify, log };
};

describe('provider retirement', () => {
    it('archives the retired thread once, only after the intent is durable', async () => {
        const h = createHarness();
        const outcome = await retireProviderThread({
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive,
            now: () => 1000, notify: h.notify, log: h.log
        });
        expect(h.calls).toEqual(['write:retired-native-thread:requested', 'persist', 'archive:retired-native-thread', 'write:retired-native-thread:archived', 'persist']);
        expect(h.archive).toHaveBeenCalledTimes(1);
        expect(h.archive).toHaveBeenCalledWith(THREAD);
        expect(outcome).toMatchObject({ threadId: THREAD, sessionId: SESSION, status: 'archived', archived: true, attempted: true, persisted: true });
        expect(h.records.get(THREAD)).toMatchObject({ threadId: THREAD, sessionId: SESSION, status: 'archived', requestedAt: 1000 });
        expect(h.notify).not.toHaveBeenCalled();
    });

    it('archives only the thread it was given', async () => {
        const archived: string[] = [];
        const h = createHarness({ archive: async (threadId: string) => { archived.push(threadId); } });
        await retireProviderThread({
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive
        });
        expect(archived).toEqual([THREAD]);
    });

    it('never archives when the intent cannot be persisted', async () => {
        const h = createHarness({ persist: async () => { throw new Error('disk full'); } });
        const outcome = await retireProviderThread({
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive,
            notify: h.notify, log: h.log
        });
        expect(h.archive).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ status: 'not-started', archived: false, attempted: false });
        expect(outcome.error).toContain('disk full');
        expect(h.notify).toHaveBeenCalledTimes(1);
        expect(String(h.notify.mock.calls[0][0])).toContain('No archive was attempted');
        // The switch itself is not reported as failed by a cleanup problem.
        expect(String(h.notify.mock.calls[0][0])).toContain('switch itself succeeded');
    });

    it('keeps a guard record after a lost intent so the archive is never retried', async () => {
        const h = createHarness({ persist: async () => { throw new Error('disk full'); } });
        const options = {
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive,
            notify: h.notify, log: h.log
        };
        const first = await retireProviderThread(options);
        expect(first.status).toBe('not-started');
        // The record survives in memory even though the intent was never saved.
        expect(h.records.get(THREAD)).toMatchObject({ status: 'not-started' });
        const second = await retireProviderThread(options);
        expect(second.status).toBe('not-started');
        expect(second.attempted).toBe(false);
        expect(h.archive).not.toHaveBeenCalled();
    });

    it('reports an unknown archive outcome as unconfirmed and never replays it', async () => {
        const h = createHarness({ archive: async () => { throw new Error('socket hang up'); } });
        const options = {
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive,
            classifyFailure: () => 'unconfirmed' as const, notify: h.notify, log: h.log
        };
        const outcome = await retireProviderThread(options);
        expect(outcome).toMatchObject({ status: 'unconfirmed', archived: false, attempted: true });
        expect(h.records.get(THREAD)).toMatchObject({ status: 'unconfirmed', error: 'socket hang up' });
        expect(String(h.notify.mock.calls[0][0])).toContain('will not be retried automatically');
        const again = await retireProviderThread(options);
        expect(again.status).toBe('unconfirmed');
        expect(h.archive).toHaveBeenCalledTimes(1);
    });

    it('reports a definite rejection as failed without replaying it', async () => {
        const h = createHarness({ archive: async () => { throw new Error('engine said no'); } });
        const options = {
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive,
            classifyFailure: () => 'rejected' as const, notify: h.notify, log: h.log
        };
        const outcome = await retireProviderThread(options);
        expect(outcome).toMatchObject({ status: 'failed', archived: false, attempted: true });
        expect(h.records.get(THREAD)).toMatchObject({ status: 'failed', error: 'engine said no' });
        expect(String(h.notify.mock.calls[0][0])).toContain('switch succeeded');
        const again = await retireProviderThread(options);
        expect(again.status).toBe('failed');
        expect(h.archive).toHaveBeenCalledTimes(1);
    });

    it('keeps a confirmed archive even when the final status cannot be saved', async () => {
        const h = createHarness();
        let failPersist = false;
        const persist = vi.fn(async () => { if (failPersist) throw new Error('write failed'); });
        const outcome = await retireProviderThread({
            threadId: THREAD, sessionId: SESSION, store: h.store, persist, archive: h.archive,
            notify: h.notify, log: h.log
        });
        expect(outcome).toMatchObject({ status: 'archived', archived: true, attempted: true, persisted: true });
        failPersist = true;
        const confirmed = createHarness();
        confirmed.records.set(THREAD, { threadId: THREAD, sessionId: SESSION, status: 'requested' });
        const replay = await retireProviderThread({
            threadId: THREAD, sessionId: SESSION, store: confirmed.store, persist: confirmed.persist, archive: confirmed.archive,
            notify: confirmed.notify, log: confirmed.log
        });
        expect(replay.status).toBe('requested');
        expect(replay.attempted).toBe(false);
        expect(confirmed.archive).not.toHaveBeenCalled();
        expect(confirmed.persist).not.toHaveBeenCalled();
    });

    it('skips a thread that is still in use', async () => {
        const h = createHarness();
        const outcome = await retireProviderThread({
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive,
            precondition: () => false, notify: h.notify, log: h.log
        });
        expect(h.persist).not.toHaveBeenCalled();
        expect(h.archive).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ status: 'not-started', attempted: false });
        expect(h.records.has(THREAD)).toBe(false);
    });

    it('never throws when the runtime misbehaves', async () => {
        const h = createHarness({ persist: async () => { throw new Error('nope'); }, archive: async () => { throw 'string failure'; } });
        await expect(retireProviderThread({
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive,
            notify: h.notify, log: h.log
        })).resolves.toMatchObject({ status: 'not-started' });
        const other = createHarness({ archive: async () => { throw 'string failure'; } });
        const outcome = await retireProviderThread({
            threadId: THREAD, sessionId: SESSION, store: other.store, persist: other.persist, archive: other.archive,
            notify: other.notify, log: other.log
        });
        expect(outcome.status).toBe('unconfirmed');
        expect(outcome.error).toBe('string failure');
    });

    it('requires both a thread ID and a session ID', async () => {
        const h = createHarness();
        const withoutThread = await retireProviderThread({
            threadId: '', sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive
        });
        const withoutSession = await retireProviderThread({
            threadId: THREAD, sessionId: '', store: h.store, persist: h.persist, archive: h.archive
        });
        expect(withoutThread.status).toBe('not-started');
        expect(withoutSession.status).toBe('not-started');
        expect(h.persist).not.toHaveBeenCalled();
        expect(h.archive).not.toHaveBeenCalled();
    });

    it('mirrors the cleanup state into the runtime record map', () => {
        let applied: RetirementRecordMap | undefined = { other: { threadId: 'other', sessionId: 's', status: 'archived' } };
        const store = createRetirementStore(applied, records => { applied = records; });
        expect(store.read('other')?.status).toBe('archived');
        store.write(THREAD, { threadId: THREAD, sessionId: SESSION, status: 'requested' });
        expect(Object.keys(applied ?? {}).sort()).toEqual(['other', THREAD]);
        store.write('other', undefined);
        expect(Object.keys(applied ?? {})).toEqual([THREAD]);
        store.write(THREAD, undefined);
        expect(applied).toBeUndefined();
    });

    it('describes every status in readable words', () => {
        expect(describeRetirementStatus('archived')).toContain('archived');
        expect(describeRetirementStatus('requested')).toContain('never confirmed');
        expect(describeRetirementStatus('unconfirmed')).toContain('not be retried');
        expect(describeRetirementStatus('failed')).toContain('not be retried');
        expect(describeRetirementStatus('not-started')).toContain('not archived');
    });

    it('notifies the user when a confirmed archive could not be saved, and never repeats it', async () => {
        let saves = 0;
        const h = createHarness({ persist: async () => { saves += 1; if (saves > 1) throw new Error('disk full'); } });
        const options = {
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive,
            notify: h.notify, log: h.log
        };
        const outcome = await retireProviderThread(options);
        // The archive was confirmed, so the cleanup happened.
        expect(outcome).toMatchObject({ status: 'archived', archived: true, attempted: true, persisted: false });
        expect(h.archive).toHaveBeenCalledTimes(1);
        // The missing record is reported, not swallowed.
        expect(h.notify).toHaveBeenCalledTimes(1);
        const notice = String(h.notify.mock.calls[0][0]);
        expect(notice).toContain('archived');
        expect(notice).toContain('will not be repeated');
        expect(notice).toContain('disk full');
        // The confirmed archive is never replayed, not even in this process.
        const replay = await retireProviderThread(options);
        expect(replay).toMatchObject({ status: 'archived', attempted: false });
        expect(h.archive).toHaveBeenCalledTimes(1);
        expect(h.notify).toHaveBeenCalledTimes(1);
    });

    it('a failing notice cannot turn a confirmed archive into an unconfirmed one', async () => {
        let saves = 0;
        const h = createHarness({ persist: async () => { saves += 1; if (saves > 1) throw new Error('disk full'); } });
        const outcome = await retireProviderThread({
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive,
            notify: () => { throw new Error('the session is gone'); }, log: h.log
        });
        expect(outcome).toMatchObject({ status: 'archived', archived: true, attempted: true });
        expect(h.records.get(THREAD)).toMatchObject({ status: 'archived' });
    });

    it('a failing notice cannot turn a rejected archive into an unconfirmed one', async () => {
        const h = createHarness({ archive: async () => { throw new Error('engine refused'); } });
        const outcome = await retireProviderThread({
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive,
            classifyFailure: () => 'rejected', notify: () => { throw new Error('the session is gone'); }, log: h.log
        });
        expect(outcome.status).toBe('failed');
        expect(h.records.get(THREAD)).toMatchObject({ status: 'failed' });
    });

    it('a failing log callback cannot break the cleanup', async () => {
        const h = createHarness({ persist: async () => { throw new Error('disk full'); } });
        const outcome = await retireProviderThread({
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive,
            log: () => { throw new Error('the logger is gone'); }
        });
        expect(outcome).toMatchObject({ status: 'not-started', attempted: false });
        expect(h.archive).not.toHaveBeenCalled();
    });

    it('never exposes a credential in a reported failure', async () => {
        const secret = 'sk-live-0123456789abcdef';
        const h = createHarness({ archive: async () => { throw new Error(`upstream refused: Authorization: Bearer ${secret}`); } });
        const outcome = await retireProviderThread({
            threadId: THREAD, sessionId: SESSION, store: h.store, persist: h.persist, archive: h.archive,
            notify: h.notify, log: h.log
        });
        expect(outcome.status).toBe('unconfirmed');
        expect(outcome.error).not.toContain(secret);
        expect(outcome.error).toContain('[redacted]');
        expect(h.records.get(THREAD)?.error).not.toContain(secret);
        expect(String(h.notify.mock.calls[0][0])).not.toContain(secret);
    });

    it('redacts the credential shapes that reach a failure text', () => {
        expect(redactSensitive('Authorization: Bearer abcdef0123456789')).not.toContain('abcdef0123456789');
        expect(redactSensitive('api_key=abcdef0123456789')).not.toContain('abcdef0123456789');
        expect(redactSensitive('https://user:secret@example.com/v1')).not.toContain('user:secret');
        expect(redactSensitive('token: abcdef0123456789')).not.toContain('abcdef0123456789');
        expect(redactSensitive('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef')).not.toContain('eyJhbGciOiJIUzI1NiJ9');
        // Ordinary diagnostics stay readable.
        expect(redactSensitive('the engine refused the archive')).toBe('the engine refused the archive');
    });

    it('redacts a structured, quoted or spaced credential before it is stored or shown', () => {
        // A JSON object with a quoted key and a quoted value.
        expect(describeRetirementFailure({ api_key: 'SYNTHETIC_PRIVATE_VALUE' })).not.toContain('SYNTHETIC_PRIVATE_VALUE');
        // A JSON payload quoted inside a failure message.
        expect(describeRetirementFailure(new Error('{"access_token":"SYNTHETIC_PRIVATE_VALUE"}'))).not.toContain('SYNTHETIC_PRIVATE_VALUE');
        // A single-quoted value that contains spaces.
        expect(describeRetirementFailure(new Error("password='SYNTHETIC PRIVATE VALUE'"))).not.toContain('SYNTHETIC PRIVATE VALUE');
        // The redacted text keeps its structure, so a failure stays readable.
        expect(describeRetirementFailure({ api_key: 'SYNTHETIC_PRIVATE_VALUE' })).toContain('[redacted]');
        expect(describeRetirementFailure(new Error("password='SYNTHETIC PRIVATE VALUE'"))).toContain('[redacted]');
        // A value that is already redacted is not re-redacted into broken text.
        expect(redactSensitive('Authorization: Bearer abcdef0123456789')).toBe('Authorization: [redacted]');
        // Ordinary diagnostics stay readable.
        expect(redactSensitive('the engine refused the archive')).toBe('the engine refused the archive');
    });
});
