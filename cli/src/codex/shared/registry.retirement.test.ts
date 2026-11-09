import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ home: '' }));
vi.mock('@/configuration', () => ({ configuration: { get happyHomeDir() { return state.home; }, apiUrl: 'local-test', cliApiToken: 'synthetic-token' } }));
import { findColdBinding, readRuntimes, runtimeAuthHash } from './registry';
afterEach(async () => { if (state.home) await rm(state.home, { recursive: true, force: true }); });
describe('retirement metadata cannot hide a runtime owner', () => {
    it('rejects retired IDs across generations before accepting an older direct binding', async () => {
        state.home = await mkdtemp('/tmp/hapi-registry-cold-');
        const directory = join(state.home, 'codex-runtimes'); await mkdir(directory);
        const base = { pid: process.pid, marker: 'not-current-generation', command: 'codex', args: [],
            endpoint: 'unix:///unused', codexHome: '/isolated-home', hub: 'local-test', authHash: runtimeAuthHash() };
        await writeFile(join(directory, 'a-old.json'), JSON.stringify({ ...base, id: 'old',
            sessions: { session: { threadId: 'retired', namespace: 'test', active: false } } }));
        await writeFile(join(directory, 'z-new.json'), JSON.stringify({ ...base, id: 'new', retiredProviderThreads: { retired: 'session' },
            sessions: { session: { threadId: 'current', namespace: 'test', active: false } } }));
        await expect(findColdBinding('/isolated-home', 'retired')).rejects.toThrow('Use hapi resume session');
        await expect(findColdBinding('/isolated-home', 'current')).resolves.toBe('session');
        await expect(findColdBinding('/different-home', 'retired')).resolves.toBeUndefined();
        await expect(findColdBinding('/isolated-home', 'unknown')).resolves.toBeUndefined();
        // Foreign namespace/credentials cannot suppress a valid local binding.
        await writeFile(join(directory, 'foreign.json'), JSON.stringify({ ...base, id: 'foreign', authHash: 'foreign-auth',
            retiredProviderThreads: { current: 'foreign-session' }, sessions: {} }));
        await expect(findColdBinding('/isolated-home', 'current')).resolves.toBe('session');
    });
    it.each([undefined, 'archived', 'future-retirement-status'])('preserves ownership with %s cleanup status', async status => {
        state.home = await mkdtemp('/tmp/hapi-registry-retirement-');
        const directory = join(state.home, 'codex-runtimes'); await mkdir(directory);
        const owner = { id: 'runtime', pid: process.pid, marker: 'test', command: 'codex', args: [],
            endpoint: 'unix:///unused', codexHome: '/unused', hub: 'local-test', authHash: 'synthetic',
            retiredProviderThreads: { retired: 'session' }, sessions: { session: { threadId: 'current', namespace: 'test', active: true } },
            ...(status ? { providerRetirements: { retired: { threadId: 'retired', sessionId: 'session', status } } } : {}) };
        await writeFile(join(directory, 'runtime.json'), JSON.stringify(owner));
        const records = await readRuntimes(); expect(records).toHaveLength(1);
        expect(records[0].sessions).toEqual(owner.sessions);
        expect(records[0].retiredProviderThreads).toEqual(owner.retiredProviderThreads);
        expect(records[0].providerRetirements?.retired.status).toBe(status === 'future-retirement-status' ? 'unconfirmed' : status);
    });
});
