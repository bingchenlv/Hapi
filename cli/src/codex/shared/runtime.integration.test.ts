import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentState, Metadata } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';
import { record } from './gateway';
import { isProcessAlive } from '@/utils/process';
import { USER_INPUT_TIMEOUT_MS } from './permissions';

const state = vi.hoisted(() => ({ home: '', sessions: new Map<string, MockSession>(), beforeBootstrap: undefined as (() => Promise<void>) | undefined,
    minimaxBase: '', hybrid: 'hybrid' as 'hybrid' | 'openai', catalogFailure: false }));
vi.mock('./minimax', async importOriginal => {
    const actual = await importOriginal<typeof import('./minimax')>();
    return { ...actual, minimaxAvailable: () => Boolean(state.minimaxBase),
        minimaxServerArgs: actual.minimaxServerArgs };
});
vi.mock('./minimaxReviewRouter', async importOriginal => {
    const actual = await importOriginal<typeof import('./minimaxReviewRouter')>();
    return { ...actual, startMiniMaxReviewRouter: (options: Parameters<typeof actual.startMiniMaxReviewRouter>[0]) =>
        actual.startMiniMaxReviewRouter({ ...options, minimaxUrl: `${state.minimaxBase}/responses`,
            openaiUrl: `${state.minimaxBase}/responses`, credential: async () => 'isolated-test-mini-key' }) };
});
vi.mock('./nativeMiniMaxCatalog', async importOriginal => {
    const actual = await importOriginal<typeof import('./nativeMiniMaxCatalog')>();
    return { ...actual, prepareMiniMaxCatalog: (...args: Parameters<typeof actual.prepareMiniMaxCatalog>) => {
        if (state.catalogFailure) return Promise.reject(new Error('ISOLATED_CATALOG_METADATA_UNAVAILABLE'));
        return actual.prepareMiniMaxCatalog(...args);
    } };
});
vi.mock('./hybridModel', () => ({ hybridModelAvailable: () => false, hybridMcpConfig: () => ({}),
    hybridModelPolicy: async () => ({ mode: state.hybrid }) }));
class MockSession {
    readonly sessionId = randomUUID();
    state: AgentState = { requests: { 'old-worker': { tool: 'request_user_input', arguments: {}, createdAt: 0 } } }; metadata: Metadata;
    messages: unknown[] = []; consumed: string[] = []; dead = false;
    user?: (message: { content: { text: string } }, id?: string) => void;
    rpc = new Map<string, (params: unknown) => Promise<unknown>>();
    rpcHandlerManager = { registerHandler: (name: string, fn: (params: unknown) => Promise<unknown>) => { this.rpc.set(name, fn); } };
    constructor(cwd: string) { this.metadata = { path: cwd, host: 'test', hostPid: process.pid, machineId: 'test', flavor: 'codex', capabilities: { concurrentClients: true } }; }
    getMetadata() { return this.metadata; }
    updateMetadata(fn: (m: Metadata) => Metadata) { this.metadata = fn(this.metadata); }
    // This fixture applies metadata synchronously, so there is no ACK to drain.
    async flushMetadata() { return !this.dead; }
    updateAgentState(fn: (s: AgentState) => AgentState) { this.state = fn(this.state); }
    onUserMessage(fn: MockSession['user']) { this.user = fn; }
    onCancelQueuedMessage() {} onRetryQueuedMessage() {} onReconnect() {}
    sendUserMessage(text: string) { this.messages.push({ user: text }); }
    sendAgentMessage(body: unknown) { this.messages.push(body); }
    sendSessionEvent(body: unknown) { this.messages.push(body); }
    emitMessagesConsumed(ids: string[]) { this.consumed.push(...ids); }
    emitSteerIndeterminate() {} keepAlive() {} emitSessionReady() {}
    async setSteerDeliveryState() { return true; }
    syncNativeQueuedMessage() {}
    sendSessionDeath() { this.dead = true; } async flush() {} close() {} isPending() { return false; }
}
vi.mock('@/configuration', () => ({ configuration: { get happyHomeDir() { return state.home; }, apiUrl: 'http://mock-hub', cliApiToken: 'test' } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: (...args: unknown[]) => { if (process.env.HAPI_DEBUG_SHARED_TEST) console.log(...args); }, warn: vi.fn(), info: vi.fn(), debugLargeJson: vi.fn() } }));
vi.mock('@/agent/sessionFactory', () => ({ bootstrapSession: async (options: { workingDirectory: string; metadataOverrides: Partial<Metadata> }) => {
    await state.beforeBootstrap?.();
    const session = new MockSession(options.workingDirectory); session.metadata = { ...session.metadata, ...options.metadataOverrides };
    state.sessions.set(session.sessionId, session);
    return { session: session as unknown as ApiSessionClient, sessionInfo: { id: session.sessionId, namespace: 'test' }, metadata: session.metadata,
        workingDirectory: options.workingDirectory, machineId: 'test', startedBy: 'terminal', api: {} };
}, bootstrapExistingSession: vi.fn(async (options: { sessionId: string; workingDirectory: string; preserveProjectWorkingDirectory?: boolean; metadataOverrides: Partial<Metadata> }) => {
    const session = state.sessions.get(options.sessionId)!;
    if (!session) throw new Error('Unknown test session');
    const cwd = options.preserveProjectWorkingDirectory && session.metadata.project ? session.metadata.path : options.workingDirectory;
    session.dead = false; session.metadata = { ...session.metadata, ...options.metadataOverrides, path: cwd };
    return { session: session as unknown as ApiSessionClient, sessionInfo: { id: session.sessionId, namespace: 'test' }, metadata: session.metadata,
        workingDirectory: cwd, machineId: 'test', startedBy: 'terminal', api: {} };
}) }));
vi.mock('@/runner/controlClient', () => ({ notifyRunnerSessionStarted: vi.fn(async () => ({})) }));
vi.mock('../utils/buildHapiMcpBridge', () => ({ buildHapiMcpBridge: async () => ({ server: { url: 'http://unused', stop() {} }, mcpServers: {} }) }));

// Explicit opt-in: installed official binary, entirely isolated CODEX_HOME, mock Responses API only.
describe.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1')('installed Codex shared runtime', () => {
    afterEach(() => { vi.unstubAllEnvs(); state.sessions.clear(); state.beforeBootstrap = undefined; state.minimaxBase = ''; state.hybrid = 'hybrid'; state.catalogFailure = false; });
    it('continues MiniMax generation with an honest native-context warning if optional catalog preparation fails', async () => {
        const home = await mkdtemp('/tmp/hapi-minimax-catalog-fallback-'); state.home = home;
        const ch = join(home, 'codex'); await mkdir(ch); state.catalogFailure = true;
        let calls = 0;
        const http = createServer((req, res) => {
            req.resume(); req.once('end', () => {
                if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
                calls++;
                const id = randomUUID(); const events = [{ type: 'response.created', response: { id } },
                    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'CATALOG_FALLBACK_CONTINUES' }] } },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }];
                res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        state.minimaxBase = `http://127.0.0.1:${(http.address() as { port: number }).port}/v1`;
        await writeFile(join(ch, 'config.toml'), 'approval_policy="on-request"\napprovals_reviewer="user"\nsandbox_mode="workspace-write"\nforced_login_method="api"\n[features]\nplugins=false\nremote_plugin=false\napps=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n');
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home); vi.stubEnv('OPENAI_API_KEY', 'isolated-catalog-key');
        const { runSharedRuntime } = await import('./runtime'); const abort = new AbortController();
        let ready!: (id: string) => void; const readiness = new Promise<string>(resolve => { ready = resolve; });
        const running = runSharedRuntime({ workingDirectory: home, model: 'MiniMax-M3.1-Flash' }, ({ sessionId }) => ready(sessionId), abort.signal);
        try {
            const id = await Promise.race([readiness, running.then(() => { throw new Error('Fallback runtime stopped'); })]);
            const web = state.sessions.get(id)!;
            expect(JSON.stringify(web.messages)).toContain('本次未确认百万上下文');
            web.user?.({ content: { text: 'Continue ordinary authorized work with fallback metadata. No tools.' } }, 'catalog-fallback-task');
            await vi.waitFor(() => expect(JSON.stringify(web.messages)).toContain('CATALOG_FALLBACK_CONTINUES'), { timeout: 15000 });
            expect(calls).toBe(1); expect(web.state.requests).toEqual({});
            await vi.waitFor(() => expect(web.messages.map(record).filter(message => message.type === 'token_count').some(message => record(message.info).modelContextWindow === 258400), JSON.stringify(web.messages.map(record).filter(message => message.type === 'token_count'))).toBe(true));
            expect(JSON.stringify(web.messages).split('本次未确认百万上下文')).toHaveLength(2);
        } finally {
            abort.abort(); await running.catch(() => {}); http.closeAllConnections();
            await new Promise<void>(resolve => http.close(() => resolve())); await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 30000);
    it('takes over quota failures in the same HAPI session, isolates other roots, and supports manual round trips', async () => {
        const home = await mkdtemp('/tmp/hapi-minimax-native-'); state.home = home;
        const ch = join(home, 'codex'); await mkdir(ch);
        const bodies: Record<string, unknown>[] = [];
        let failOpenAI = false;
        const http = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(Buffer.from(chunk)));
            req.on('end', () => {
                if (!req.url?.endsWith('/responses') || req.method !== 'POST') { res.writeHead(404).end(); return; }
                const body = record(JSON.parse(Buffer.concat(chunks).toString())); bodies.push(body);
                if (failOpenAI && body.model !== 'MiniMax-M3.1-Flash' && !JSON.stringify(body.input).includes('UNRELATED ROOT')) {
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { type: 'usage_limit_reached', plan_type: 'plus', resets_at: Math.floor(Date.now() / 1000) + 3600 } })); return;
                }
                const foreign = (Array.isArray(body.input) ? body.input : []).map(record).find(value => value.type === 'reasoning' && Array.isArray(value.content) && value.content.length);
                if (body.model !== 'MiniMax-M3.1-Flash' && foreign) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'reasoning.content maximum length 0; foreign encrypted reasoning' } })); return;
                }
                const id = randomUUID();
                const item = { type: 'message', role: 'assistant', id: 'msg_' + id,
                    content: [{ type: 'output_text', text: body.model === 'MiniMax-M3.1-Flash' ? 'MINIMAX CHECK DONE' : 'OPENAI CHECK DONE' }] };
                const reasoning = body.model === 'MiniMax-M3.1-Flash'
                    ? [{ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_' + id, summary: [],
                        content: [{ type: 'reasoning_text', text: 'SYNTHETIC_MINIMAX_REASONING' }], encrypted_content: 'SYNTHETIC_MINIMAX_CIPHER' } }] : [];
                const events = [{ type: 'response.created', response: { id } }, ...reasoning, { type: 'response.output_item.done', item },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }];
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end(events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''));
            });
        });
        http.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n'); });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        state.minimaxBase = `http://127.0.0.1:${(http.address() as { port: number }).port}/v1`;
        await writeFile(join(ch, 'config.toml'), `model = "gpt-6-astra"\nopenai_base_url = "${state.minimaxBase}"\nforced_login_method = "api"\napproval_policy = "on-request"\napprovals_reviewer = "auto_review"\nsandbox_mode = "read-only"\n[features]\nplugins = false\nremote_plugin = false\napps = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`);
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home); vi.stubEnv('OPENAI_API_KEY', 'isolated-test-key');
        const { runSharedRuntime } = await import('./runtime');
        let abort = new AbortController(); let ready!: (id: string) => void;
        const readiness = new Promise<string>(resolve => { ready = resolve; });
        let running = runSharedRuntime({ workingDirectory: home }, ({ sessionId }) => ready(sessionId), abort.signal);
        let terminal: CodexAppServerClient | undefined;
        try {
            const sid = await Promise.race([readiness, running.then(() => { throw new Error('Runtime stopped'); })]);
            const web = state.sessions.get(sid)!; const original = web.metadata.codexSessionId!;
            await web.rpc.get('set-session-config')!({ modelReasoningEffort: 'xhigh' });
            web.user?.({ content: { text: 'RETAIN THIS TASK HISTORY' } }, 'first-task');
            await vi.waitFor(() => expect(JSON.stringify(web.messages)).toContain('OPENAI CHECK DONE'), { timeout: 15_000 });
            web.user?.({ content: { text: '/new' } }, 'other-root');
            await vi.waitFor(() => expect(state.sessions.size).toBe(2));
            const other = [...state.sessions.values()].find(value => value.sessionId !== sid)!;
            await vi.waitFor(() => expect(other.metadata.codexSessionId).toBeTruthy());
            const { readRuntimes } = await import('./registry');
            const runtime = (await readRuntimes()).find(value => value.sessions[sid])!;
            // Retirement records live in the runtime record, so every assertion
            // reads them back from the registry instead of trusting memory.
            const retirementOf = async (threadId: string) => {
                const owner = (await readRuntimes()).find(value => value.sessions[sid]?.active);
                return owner?.providerRetirements?.[threadId];
            };
            terminal = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token }); await initializeSharedClient(terminal);
            const assertRetiredUnloaded = async (threadId: string) => {
                await vi.waitFor(async () => {
                    const loaded = new Set<string>(); let cursor: string | undefined;
                    do {
                        const page = record(await terminal!.request('thread/loaded/list', { cursor }));
                        for (const id of page.data as string[]) loaded.add(id);
                        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
                    } while (cursor);
                    expect(loaded.has(threadId)).toBe(false);
                    expect(loaded.has(web.metadata.codexSessionId!)).toBe(true);
                }, { timeout: 15000 });
            };
            await terminal.request('thread/resume', { threadId: original });
            failOpenAI = true;
            web.user?.({ content: { text: 'Continue this task after the quota interruption' } }, 'quota-task');
            await vi.waitFor(() => expect(JSON.stringify(web.messages)).toContain('MINIMAX CHECK DONE'), { timeout: 30_000 });
            expect(web.metadata.codexSessionId).not.toBe(original);
            expect(web.sessionId).toBe(sid);
            expect(web.metadata.codexProviderHistory?.previousThreadIds).toContain(original);
            expect(web.metadata.modelRouting).toMatchObject({ provider: 'minimax', reason: 'usage-limit', status: 'active' });
            const mini = bodies.filter(body => body.model === 'MiniMax-M3.1-Flash');
            expect(mini).toHaveLength(1); expect(JSON.stringify(mini[0])).toContain('RETAIN THIS TASK HISTORY');
            expect(record(await terminal.request('thread/resume', { threadId: original }))).toMatchObject({ modelProvider: 'hapi_minimax', approvalsReviewer: 'auto_review' });
            // The switch retires the native thread it left behind, and the
            // archive releases that thread's resources exactly once.
            const miniThread = web.metadata.codexSessionId!;
            await vi.waitFor(async () => expect((await retirementOf(original))?.status).toBe('archived'), { timeout: 15_000 });
            const firstRetirement = (await retirementOf(original))!;
            expect(firstRetirement).toMatchObject({ threadId: original, sessionId: sid, status: 'archived' });
            await assertRetiredUnloaded(original);
            const archivedHistory = record(await terminal.request('thread/read', { threadId: original, includeTurns: true }));
            expect(JSON.stringify(archivedHistory)).toContain('RETAIN THIS TASK HISTORY');
            expect(web.dead).toBe(false); expect(other.dead).toBe(false);
            expect(typeof firstRetirement.requestedAt).toBe('number');
            expect(typeof firstRetirement.completedAt).toBe('number');
            const ownerAfterTakeover = (await readRuntimes()).find(value => value.sessions[sid]?.active)!;
            expect(ownerAfterTakeover.retiredProviderThreads?.[original]).toBe(sid);
            expect(ownerAfterTakeover.sessions[sid].threadId).toBe(miniThread);
            // Only the retired thread is recorded; the current thread is not.
            expect(Object.keys(ownerAfterTakeover.providerRetirements ?? {})).toEqual([original]);
            expect(ownerAfterTakeover.providerRetirements?.[miniThread]).toBeUndefined();
            // A retired thread still resumes to the current execution thread...
            const resumedRetired = record(await terminal.request('thread/resume', { threadId: original }));
            expect(record(resumedRetired.thread).id).toBe(miniThread);
            expect(resumedRetired).toMatchObject({ modelProvider: 'hapi_minimax' });
            // ...but it never starts new work.
            await expect(terminal.request('turn/start', { threadId: original, input: [] })).rejects.toThrow(/changed model providers/);
            other.user?.({ content: { text: 'UNRELATED ROOT continues on its own provider' } }, 'unrelated-task');
            await vi.waitFor(() => expect(JSON.stringify(other.messages)).toContain('OPENAI CHECK DONE'), { timeout: 15_000 });
            expect(other.metadata.modelRouting).toBeUndefined();
            await web.rpc.get('set-session-config')!({ model: 'gpt-6-astra' });
            expect(record(await terminal.request('thread/resume', { threadId: original }))).toMatchObject({ modelProvider: 'openai', approvalsReviewer: 'auto_review', reasoningEffort: 'xhigh' });
            // The MiniMax thread the first switch created is retired the same way.
            const openaiThread2 = web.metadata.codexSessionId!;
            await vi.waitFor(async () => expect((await retirementOf(miniThread))?.status).toBe('archived'), { timeout: 15_000 });
            await assertRetiredUnloaded(miniThread);
            // The imported thread keeps the visible conversation of the
            // MiniMax turn it came from: the sanitized import mirrors the
            // paginated journal into the events the native reader reads.
            const importedHistory = record(await terminal.request('thread/read', { threadId: openaiThread2, includeTurns: true }));
            expect(JSON.stringify(importedHistory)).toContain('RETAIN THIS TASK HISTORY');
            expect(JSON.stringify(importedHistory)).not.toContain('SYNTHETIC_MINIMAX_CIPHER');
            expect((await retirementOf(original))?.status).toBe('archived');
            const ownerAfterReturn = (await readRuntimes()).find(value => value.sessions[sid]?.active)!;
            expect(ownerAfterReturn.retiredProviderThreads?.[miniThread]).toBe(sid);
            expect(ownerAfterReturn.sessions[sid].threadId).toBe(openaiThread2);
            expect(ownerAfterReturn.providerRetirements?.[openaiThread2]).toBeUndefined();
            expect(Object.keys(ownerAfterReturn.providerRetirements ?? {}).sort()).toEqual([miniThread, original].sort());
            failOpenAI = false;
            const beforeReturn = bodies.length;
            web.user?.({ content: { text: 'RETURN TO OPENAI AFTER MINIMAX' } }, 'return-openai');
            await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(beforeReturn), { timeout: 15_000 });
            await vi.waitFor(() => expect(web.state.steeringActive).toBe(false));
            const returned = bodies.at(-1)!;
            expect(JSON.stringify(returned.input)).toContain('RETAIN THIS TASK HISTORY');
            expect(JSON.stringify(returned.input)).toContain('MINIMAX CHECK DONE');
            expect(JSON.stringify(returned.input)).not.toContain('SYNTHETIC_MINIMAX_CIPHER');
            expect((Array.isArray(returned.input) ? returned.input : []).map(record).some(item => item.type === 'reasoning' && Array.isArray(item.content) && item.content.length)).toBe(false);
            expect(JSON.stringify(web.messages)).not.toContain('reasoning.content maximum length 0');
            failOpenAI = true;
            const savedOrigins = { ...web.metadata.codexProviderHistory?.turnOrigins };
            state.hybrid = 'openai';
            const attempts = bodies.length;
            web.user?.({ content: { text: 'Quota with hybrid disabled' } }, 'no-fallback');
            await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(attempts));
            await vi.waitFor(() => expect(web.state.steeringActive).toBe(false));
            expect(bodies.filter(body => body.model === 'MiniMax-M3.1-Flash')).toHaveLength(1);
            await web.rpc.get('set-session-config')!({ model: 'MiniMax-M3.1-Flash' });
            expect(record(await terminal.request('thread/resume', { threadId: original }))).toMatchObject({ modelProvider: 'hapi_minimax', approvalsReviewer: 'auto_review' });
            expect(web.metadata.codexProviderHistory?.turnOrigins).toMatchObject(savedOrigins);
            const currentThreadId = web.metadata.codexSessionId!;
            // The third switch retires the OpenAI thread the second switch created.
            await vi.waitFor(async () => expect((await retirementOf(openaiThread2))?.status).toBe('archived'), { timeout: 15_000 });
            await assertRetiredUnloaded(openaiThread2);
            const ownerAfterThird = (await readRuntimes()).find(value => value.sessions[sid]?.active)!;
            expect(Object.keys(ownerAfterThird.providerRetirements ?? {}).sort()).toEqual([miniThread, openaiThread2, original].sort());
            expect(ownerAfterThird.providerRetirements?.[currentThreadId]).toBeUndefined();
            await web.rpc.get('set-session-config')!({ modelReasoningEffort: 'high' });
            await expect(web.rpc.get('set-session-config')!({ modelReasoningEffort: 'ultra' })).rejects.toThrow('MiniMax supports');
            const inheritedMessages = JSON.stringify(web.messages);
            await terminal.disconnect(); terminal = undefined;
            abort.abort(); await running;
            abort = new AbortController();
            let coldReady!: () => void;
            const coldReadiness = new Promise<void>(resolve => { coldReady = resolve; });
            running = runSharedRuntime({ workingDirectory: home, existingSessionId: sid, resumeSessionId: currentThreadId }, () => coldReady(), abort.signal);
            await Promise.race([coldReadiness, running.then(() => { throw new Error('Cold runtime stopped'); })]);
            const coldRuntime = (await readRuntimes()).find(value => value.sessions[sid]?.active)!;
            terminal = new CodexAppServerClient({ endpoint: coldRuntime.endpoint, token: coldRuntime.token }); await initializeSharedClient(terminal);
            expect(record(await terminal.request('thread/resume', { threadId: currentThreadId }))).toMatchObject({ modelProvider: 'hapi_minimax', approvalsReviewer: 'auto_review' });
            expect(web.metadata.modelRouting).toMatchObject({ provider: 'minimax', reason: 'manual', status: 'active' });
            expect(JSON.stringify(web.messages).split('OPENAI CHECK DONE').length).toBe(inheritedMessages.split('OPENAI CHECK DONE').length);
            web.user?.({ content: { text: 'Manual MiniMax after cold resume' } }, 'cold-mini');
            await vi.waitFor(() => expect(bodies.filter(body => body.model === 'MiniMax-M3.1-Flash')).toHaveLength(2), { timeout: 15_000 });
            await vi.waitFor(() => expect(web.state.steeringActive).toBe(false));
            failOpenAI = false;
            await web.rpc.get('set-session-config')!({ model: 'gpt-6.1-sol' });
            // The cold runtime retires the thread it resumed, in its own record.
            await vi.waitFor(async () => expect((await retirementOf(currentThreadId))?.status).toBe('archived'), { timeout: 15_000 });
            await assertRetiredUnloaded(currentThreadId);
            const coldOwner = (await readRuntimes()).find(value => value.sessions[sid]?.active)!;
            expect(Object.keys(coldOwner.providerRetirements ?? {})).toEqual([currentThreadId]);
            const beforeColdReturn = bodies.length;
            web.user?.({ content: { text: 'OPENAI AFTER COLD MINIMAX' } }, 'cold-return-openai');
            await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(beforeColdReturn), { timeout: 15_000 });
            await vi.waitFor(() => expect(web.state.steeringActive).toBe(false));
            expect(bodies.at(-1)!.model).toBe('gpt-6.1-sol');
            expect(JSON.stringify(bodies.at(-1)!.input)).toContain('RETAIN THIS TASK HISTORY');
            expect(JSON.stringify(bodies.at(-1)!.input)).toContain('Manual MiniMax after cold resume');
            expect(JSON.stringify(bodies.at(-1)!.input)).not.toContain('SYNTHETIC_MINIMAX_CIPHER');
            const openaiThread = web.metadata.codexSessionId!;
            const latestPage = record(await terminal.request('thread/turns/list', { threadId: openaiThread, limit: 1, sortDirection: 'desc', itemsView: 'full' }));
            const completedId = record((latestPage.data as unknown[])[0]).id;
            await vi.waitFor(() => expect(web.metadata.codexProviderHistory?.inheritedTurnIds).toContain(completedId));
            const completedReplies = JSON.stringify(web.messages).split('OPENAI CHECK DONE').length;
            await terminal.disconnect(); terminal = undefined;
            abort.abort(); await running;
            abort = new AbortController();
            let finalReady!: () => void;
            const finalReadiness = new Promise<void>(resolve => { finalReady = resolve; });
            running = runSharedRuntime({ workingDirectory: home, existingSessionId: sid, resumeSessionId: openaiThread }, () => finalReady(), abort.signal);
            await Promise.race([finalReadiness, running.then(() => { throw new Error('OpenAI cold resume stopped'); })]);
            expect(JSON.stringify(web.messages).split('OPENAI CHECK DONE').length).toBe(completedReplies);
        } finally {
            await terminal?.disconnect(); abort.abort(); await running.catch(() => {});
            await new Promise<void>(resolve => http.close(() => resolve()));
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 75_000);
    it('preserves project identity across normal/native new and cold resume without tagging unrelated clients', async () => {
        const home = await mkdtemp('/tmp/hapi-project-native-'); state.home = home;
        const ch = join(home, 'codex'); const directory = join(home, 'family-finance');
        await mkdir(ch); await mkdir(directory);
        await writeFile(join(directory, 'AGENTS.md'), 'FF_PROJECT_RULE_SENTINEL: Read project documents and submit research drafts.\n');
        const bodies: Record<string, unknown>[] = [];
        const http = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(Buffer.from(chunk)));
            req.on('end', () => {
                if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
                bodies.push(record(JSON.parse(Buffer.concat(chunks).toString())));
                const id = randomUUID();
                const item = { type: 'message', role: 'assistant', id: 'msg_' + id, content: [{ type: 'output_text', text: 'PROJECT CHECK DONE' }] };
                const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }];
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end(events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''));
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const port = (http.address() as { port: number }).port;
        await writeFile(join(ch, 'config.toml'), 'model = "gpt-6-astra"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.mock]\nname = "Isolated project test"\nbase_url = "http://127.0.0.1:' + port + '/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nplugins = false\nremote_plugin = false\napps = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n');
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home);
        const { runSharedRuntime } = await import('./runtime');
        const abort = new AbortController(); let ready!: (id: string) => void;
        const readySession = new Promise<string>(resolve => { ready = resolve; });
        const running = runSharedRuntime({ workingDirectory: home }, ({ sessionId }) => ready(sessionId), abort.signal);
        let client: CodexAppServerClient | undefined; let unrelated: CodexAppServerClient | undefined;
        let coldAbort: AbortController | undefined; let coldRunning: Promise<void> | undefined;
        try {
            const sid = await Promise.race([readySession, running.then(() => { throw new Error('Runtime stopped'); })]);
            const web = state.sessions.get(sid)!;
            const project = { id: 'FF', name: '家庭记账', directory, controllerSessionId: sid, role: 'controller' as const };
            web.metadata.project = project;
            web.user?.({ content: { text: '/new' } }, 'project-new');
            await vi.waitFor(() => expect(state.sessions.size).toBe(2));
            const child = [...state.sessions.values()].find(session => session.sessionId !== sid)!;
            await vi.waitFor(() => expect(child.metadata.codexSessionId).toBeTruthy());
            expect(child.metadata.path).toBe(directory);
            expect(child.metadata.project).toEqual({ ...project, role: 'research', createdFromSessionId: sid });
            expect(web.metadata.path).toBe(home);
            const consumed = web.consumed.length;
            web.user?.({ content: { text: '/new' } }, 'project-new');
            await vi.waitFor(() => expect(web.consumed.length).toBeGreaterThan(consumed));
            expect(state.sessions.size).toBe(2);
            child.user?.({ content: { text: 'Read project context' } }, 'project-read');
            await vi.waitFor(() => expect(JSON.stringify(child.messages)).toContain('PROJECT CHECK DONE'), { timeout: 15_000 });
            expect(JSON.stringify(bodies)).toContain('FF_PROJECT_RULE_SENTINEL');
            expect(JSON.stringify(bodies)).toContain('[HAPI project context]');
            child.user?.({ content: { text: '/new' } }, 'project-grandchild');
            await vi.waitFor(() => expect(state.sessions.size).toBe(3));
            const grandchild = [...state.sessions.values()].find(session => session.metadata.project?.createdFromSessionId === child.sessionId)!;
            expect(grandchild.metadata.project).toMatchObject({ id: 'FF', controllerSessionId: sid, role: 'research' });
            const { readRuntimes } = await import('./registry');
            const runtime = (await readRuntimes()).find(value => value.sessions[sid])!;
            client = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token }); await initializeSharedClient(client);
            const resumed = record(await client.request('thread/resume', { threadId: child.metadata.codexSessionId }));
            expect(record(resumed.thread).cwd).toBe(directory);
            const result = record(await client.request('thread/start', { cwd: home }));
            const nativeChild = [...state.sessions.values()].find(session => session.metadata.codexSessionId === record(result.thread).id)!;
            expect(nativeChild.metadata.project).toMatchObject({ id: 'FF', controllerSessionId: sid, createdFromSessionId: child.sessionId });
            expect(record(result.thread).cwd).toBe(directory);
            unrelated = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token }); await initializeSharedClient(unrelated);
            await expect(unrelated.request('thread/resume', { threadId: child.metadata.codexSessionId, approvalPolicy: 'invalid-policy' }))
                .rejects.toThrow();
            const plain = record(await unrelated.request('thread/start', { cwd: home }));
            const plainSession = [...state.sessions.values()].find(session => session.metadata.codexSessionId === record(plain.thread).id)!;
            expect(plainSession.metadata.project).toBeUndefined();
            expect(record(plain.thread).cwd).toBe(home);
            // Concurrent frontends must keep their own source, even in one engine.
            await Promise.all([
                client.request('thread/resume', { threadId: child.metadata.codexSessionId }),
                unrelated.request('thread/resume', { threadId: plainSession.metadata.codexSessionId })
            ]);
            const [projectNew, plainNew] = await Promise.all([
                client.request('thread/start', { cwd: home }),
                unrelated.request('thread/start', { cwd: home })
            ]);
            const projectNewId = record(record(projectNew).thread).id;
            const plainNewId = record(record(plainNew).thread).id;
            expect(projectNewId).not.toBe(plainNewId);
            const concurrentProject = [...state.sessions.values()].find(session => session.metadata.codexSessionId === projectNewId)!;
            const concurrentPlain = [...state.sessions.values()].find(session => session.metadata.codexSessionId === plainNewId)!;
            expect(concurrentProject.metadata.project).toEqual({ ...project, role: 'research', createdFromSessionId: child.sessionId });
            expect(concurrentProject.metadata.path).toBe(directory);
            expect(concurrentPlain.metadata.project).toBeUndefined();
            expect(concurrentPlain.metadata.path).toBe(home);
            await client.disconnect(); client = undefined; await unrelated.disconnect(); unrelated = undefined;
            const controllerThread = web.metadata.codexSessionId;
            abort.abort(); await running;
            coldAbort = new AbortController(); let coldReady!: (id: string) => void;
            const coldSession = new Promise<string>(resolve => { coldReady = resolve; });
            coldRunning = runSharedRuntime({ workingDirectory: directory, existingSessionId: sid, resumeSessionId: controllerThread }, ({ sessionId }) => coldReady(sessionId), coldAbort.signal);
            expect(await Promise.race([coldSession, coldRunning.then(() => { throw new Error('Cold resume stopped'); })])).toBe(sid);
            expect(web.metadata.path).toBe(home);
            expect(web.metadata.project).toEqual(project);
            expect(web.metadata.codexSessionId).toBe(controllerThread);
            // A research conversation is an ordinary root and can resume alone.
            coldAbort.abort(); await coldRunning;
            const childThread = child.metadata.codexSessionId;
            coldAbort = new AbortController(); let childReady!: (id: string) => void;
            const childSession = new Promise<string>(resolve => { childReady = resolve; });
            coldRunning = runSharedRuntime({ workingDirectory: home, existingSessionId: child.sessionId, resumeSessionId: childThread },
                ({ sessionId }) => childReady(sessionId), coldAbort.signal);
            expect(await Promise.race([childSession, coldRunning.then(() => { throw new Error('Research cold resume stopped'); })])).toBe(child.sessionId);
            expect(child.metadata.codexSessionId).toBe(childThread);
            expect(child.metadata.path).toBe(directory);
            expect(child.metadata.project).toEqual({ ...project, role: 'research', createdFromSessionId: sid });
            const previousSessions = new Set(state.sessions.keys());
            child.user?.({ content: { text: '/new' } }, 'after-research-cold-resume');
            await vi.waitFor(() => expect(state.sessions.size).toBe(previousSessions.size + 1));
            const afterColdNew = [...state.sessions.values()].find(session => !previousSessions.has(session.sessionId))!;
            expect(afterColdNew.metadata.project).toEqual({ ...project, role: 'research', createdFromSessionId: child.sessionId });
            expect(afterColdNew.metadata.path).toBe(directory);
            expect(web.metadata.project).toEqual(project);
        } finally {
            await client?.disconnect(); await unrelated?.disconnect(); abort.abort(); coldAbort?.abort();
            await Promise.allSettled([running, ...(coldRunning ? [coldRunning] : [])]);
            await new Promise<void>(resolve => http.close(() => resolve()));
            await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    }, 60_000);
    it('waits for a delayed native answer in Default mode and resumes the same turn', async () => {
        const home = await mkdtemp('/tmp/hapi-input-wait-'); state.home = home;
        const ch = join(home, 'codex'); await mkdir(ch);
        const bodies: Record<string, unknown>[] = [];
        const http = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(Buffer.from(chunk)));
            req.on('end', () => {
                if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
                const body = record(JSON.parse(Buffer.concat(chunks).toString())); bodies.push(body);
                const input = (Array.isArray(body.input) ? body.input : []).map(record);
                let lastUser = -1;
                input.forEach((item, index) => { if (item.role === 'user') lastUser = index; });
                const answered = input.slice(lastUser + 1).some(item => item.type === 'function_call_output');
                const independent = JSON.stringify(input[lastUser]).includes('Independent work');
                const id = randomUUID();
                const item = answered || independent ? { type: 'message', role: 'assistant', id: `msg_${id}`,
                    content: [{ type: 'output_text', text: independent ? 'INDEPENDENT DONE' : 'ANSWER RECEIVED' }] }
                    : { type: 'function_call', call_id: `choice_${id}`, name: 'request_user_input', arguments: JSON.stringify({
                        questions: [{ id: 'city', header: 'City', question: 'Choose a city', options: [
                            { label: 'Beijing', description: 'First city' }, { label: 'Shanghai', description: 'Second city' }
                        ] }]
                    }) };
                const events = [{ type: 'response.created', response: { id } },
                    { type: 'response.output_item.done', item },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } }];
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const port = (http.address() as { port: number }).port;
        await writeFile(join(ch, 'config.toml'), `model = "gpt-6-astra"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.mock]\nname = "Isolated mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`);
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home);
        const { runSharedRuntime } = await import('./runtime');
        const abort = new AbortController(); let ready!: (id: string) => void;
        const readySession = new Promise<string>(resolve => { ready = resolve; });
        const running = runSharedRuntime({ workingDirectory: home }, ({ sessionId }) => ready(sessionId), abort.signal);
        let client: CodexAppServerClient | undefined;
        try {
            const sid = await Promise.race([readySession, running.then(() => { throw new Error('Runtime stopped'); })]);
            const { readRuntimes } = await import('./registry');
            const runtime = (await readRuntimes())[0]; const threadId = runtime.sessions[sid].threadId;
            client = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token });
            await initializeSharedClient(client);
            const web = state.sessions.get(sid)!;
            web.user?.({ content: { text: 'Ask me to choose' } }, 'wait-input');
            await vi.waitFor(() => expect(Object.values(web.state.requests ?? {}).some(r => r.tool === 'request_user_input')).toBe(true), { timeout: 15_000 });
            const questionId = Object.keys(web.state.requests ?? {})[0];
            const before = record(record(await client.request('thread/read', { threadId, includeTurns: true })).thread);
            const turns = (before.turns as Record<string, unknown>[]);
            const turnId = turns.at(-1)!.id;
            expect(JSON.stringify(bodies[0].input)).toContain('<hapi_user_input>');
            expect(JSON.stringify(bodies[0].input)).toContain('available in Default or Plan mode');
            // SessionCreate uses /new. A waiting root must not stall its sibling.
            web.user?.({ content: { text: '/new' } }, 'new-while-waiting');
            await vi.waitFor(() => expect(state.sessions.size).toBe(2));
            const sibling = [...state.sessions.values()].find(s => s.sessionId !== sid)!;
            sibling.user?.({ content: { text: 'Independent work' } }, 'sibling-work');
            await vi.waitFor(() => expect(sibling.messages).toContainEqual(expect.objectContaining({ type: 'message', message: 'INDEPENDENT DONE' })), { timeout: 15_000 });
            const siblingId = sibling.metadata.codexSessionId!;
            expect(siblingId).toEqual(expect.any(String));
            await client.disconnect();
            client = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token });
            await initializeSharedClient(client);
            await client.request('thread/resume', { threadId });
            const callsBeforeWait = bodies.length;
            // Exceed normal RPC/UI timeout windows without another model call.
            await new Promise(resolve => setTimeout(resolve, 65_000));
            expect(web.state.requests?.[questionId]).toBeDefined();
            expect(bodies).toHaveLength(callsBeforeWait);
            await web.rpc.get('permission')!({ id: questionId, approved: true, answers: { city: { answers: ['Shanghai'] } } });
            await vi.waitFor(() => expect(web.messages).toContainEqual(expect.objectContaining({ type: 'message', message: 'ANSWER RECEIVED' })), { timeout: 15_000 });
            expect(JSON.stringify(bodies.at(-1)!.input)).toContain('Shanghai');
            expect(web.state.completedRequests?.[questionId]?.status).toBe('resolved');
            const after = record(record(await client.request('thread/read', { threadId, includeTurns: true })).thread);
            expect((after.turns as Record<string, unknown>[]).at(-1)!.id).toBe(turnId);
            expect(record(await client.request('thread/queue/list', { threadId })).data).toEqual([]);
            await expect(web.rpc.get('permission')!({ id: questionId, approved: true, answers: { city: ['Beijing'] } })).rejects.toThrow('already resolved or submitted');
            // The newly created conversation inherits the same waiting tool.
            sibling.user?.({ content: { text: 'Ask me to choose' } }, 'sibling-choice');
            await vi.waitFor(() => expect(Object.values(sibling.state.requests ?? {}).some(r => r.tool === 'request_user_input')).toBe(true), { timeout: 15_000 });
            const siblingQuestion = Object.keys(sibling.state.requests ?? {})[0];
            const callsBeforeCancel = bodies.length;
            await sibling.rpc.get('permission')!({ id: siblingQuestion, approved: false });
            await vi.waitFor(() => expect(sibling.state.requests?.[siblingQuestion]).toBeUndefined());
            expect(bodies).toHaveLength(callsBeforeCancel);
            expect(web.dead).toBe(false);
            // Exercise the actual native empty-answer response with only the
            // 20-minute timer accelerated; production has no timeout override.
            const realSetTimeout = globalThis.setTimeout;
            const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) =>
                realSetTimeout(callback, typeof ms === 'number' && ms >= USER_INPUT_TIMEOUT_MS - 1000 && ms <= USER_INPUT_TIMEOUT_MS ? 100 : ms, ...args));
            const beforeTimeout = bodies.length;
            try {
                sibling.user?.({ content: { text: 'Ask me to choose after cancellation' } }, 'timeout-choice');
                await vi.waitFor(() => expect(sibling.messages).toContainEqual(expect.objectContaining({ type: 'message', message: 'ANSWER RECEIVED' })), { timeout: 15_000 });
                const unanswered = (Array.isArray(bodies.at(-1)!.input) ? bodies.at(-1)!.input as unknown[] : []).map(record)
                    .filter(item => item.type === 'function_call_output').at(-1)!;
                expect(JSON.parse(String(unanswered.output))).toEqual({ answers: {} });
                expect(bodies.length).toBe(beforeTimeout + 2); // one question, one continuation
                expect(record(await client.request('thread/queue/list', { threadId: siblingId })).data).toEqual([]);
                expect(sibling.messages).toContainEqual(expect.objectContaining({ type: 'tool-call-result', output: { status: 'resolved', timedOut: true } }));
            } finally { timerSpy.mockRestore(); }
            await client.request('thread/archive', { threadId: siblingId });
            await client.request('thread/archive', { threadId }); await running;
        } finally {
            abort.abort(); await running.catch(() => {}); await client?.disconnect();
            await new Promise<void>(resolve => http.close(() => resolve()));
            await rm(home, { recursive: true, force: true });
        }
    }, 100_000);
    it('rejects a child ID before creating a HAPI binding or calling native resume', async () => {
        const home = await mkdtemp('/tmp/hapi-shared-child-'); state.home = home;
        const ch = join(home, 'codex'); await mkdir(ch);
        await writeFile(join(ch, 'config.toml'), 'model = "mock-model"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n');
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home);
        // Only the read-only ancestry reply is stubbed; startup/shutdown use
        // the installed native engine. No child is actually resumed.
        const originalRequest = CodexAppServerClient.prototype.request;
        const requests = vi.spyOn(CodexAppServerClient.prototype, 'request').mockImplementation(function<T>(this: CodexAppServerClient, method: string, params?: unknown): Promise<T> {
            if (method === 'thread/read' && record(params).threadId === 'child') {
                return Promise.resolve({ thread: { id: 'child', parentThreadId: 'parent' } } as T);
            }
            return originalRequest.call(this, method, params) as Promise<T>;
        });
        const ready = vi.fn();
        try {
            const { runSharedRuntime } = await import('./runtime');
            await expect(runSharedRuntime({ workingDirectory: home, resumeSessionId: 'child' }, ready))
                .rejects.toThrow('Cannot cold-resume a child agent independently');
            expect(ready).not.toHaveBeenCalled(); expect(state.sessions.size).toBe(0);
            expect(requests.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
        } finally { requests.mockRestore(); await rm(home, { recursive: true, force: true }); }
    }, 30_000);
    it.each([false, true])('closes a failed cold reservation without archiving or replaying (existing=%s)', async existing => {
        const home = await mkdtemp('/tmp/hapi-reservation-failure-'); state.home = home;
        const ch = join(home, 'codex'); await mkdir(ch);
        await writeFile(join(ch, 'config.toml'), 'model="mock-model"\nmodel_provider="mock"\n[model_providers.mock]\nname="No model calls"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n');
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home);
        const target = 'isolated-reservation-target';
        const registry = await import('./registry');
        const save = registry.saveRuntime;
        let fail = true;
        const writes = vi.spyOn(registry, 'saveRuntime').mockImplementation(async owner => {
            await save(owner);
            if (fail && Object.values(owner.sessions).some(binding => binding.threadId === target && binding.active)) {
                fail = false; throw new Error('ISOLATED_RESERVATION_WRITE_FAILURE');
            }
        });
        const originalRequest = CodexAppServerClient.prototype.request;
        const requests = vi.spyOn(CodexAppServerClient.prototype, 'request').mockImplementation(function<T>(this: CodexAppServerClient, method: string, params?: unknown): Promise<T> {
            if (method === 'thread/read' && record(params).threadId === target)
                return Promise.resolve({ thread: { id: target, parentThreadId: null } } as T);
            return originalRequest.call(this, method, params) as Promise<T>;
        });
        const abort = new AbortController();
        const { runSharedRuntime } = await import('./runtime');
        let ready!: (value: import('./runtime').RuntimeReady) => void;
        const readiness = new Promise<import('./runtime').RuntimeReady>(resolve => { ready = resolve; });
        const running = runSharedRuntime({ workingDirectory: home }, ready, abort.signal);
        let client: CodexAppServerClient | undefined;
        try {
            const { runtime, sessionId } = await Promise.race([readiness, running.then(() => { throw new Error('Runtime stopped'); })]);
            if (existing) {
                const prior = new MockSession(home); prior.metadata.lifecycleState = 'archived';
                state.sessions.set(prior.sessionId, prior);
                await save({ ...runtime, id: 'old-reservation-fixture', marker: 'old-generation', serverPid: undefined,
                    sessions: { [prior.sessionId]: { threadId: target, namespace: 'test', active: false } } });
            }
            client = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token });
            await initializeSharedClient(client);
            await expect(client.request('thread/resume', { threadId: target })).rejects.toThrow('ISOLATED_RESERVATION_WRITE_FAILURE');
            const failed = [...state.sessions.values()].find(session => session.sessionId !== sessionId)!;
            expect(failed.dead).toBe(true);
            expect(failed.metadata.lifecycleState).toBe(existing ? 'archived' : undefined);
            expect(state.sessions.get(sessionId)!.dead).toBe(false);
            const current = (await registry.readRuntimes()).find(owner => owner.id === runtime.id)!;
            expect(current.sessions[failed.sessionId].active).toBe(false);
            // The caller's gateway request is the only resume attempt; none is
            // forwarded to the native engine, and no archive RPC is issued.
            expect(requests.mock.calls.filter(([method, params]) => method === 'thread/resume' && record(params).threadId === target)).toHaveLength(1);
            expect(requests.mock.calls.some(([method, params]) => method === 'thread/archive' && record(params).threadId === target)).toBe(false);
            expect(record(await client.request('thread/read', { threadId: runtime.sessions[sessionId].threadId, includeTurns: false })).thread).toBeTruthy();
        } finally {
            abort.abort(); await running.catch(() => {}); await client?.disconnect();
            requests.mockRestore(); writes.mockRestore(); await rm(home, { recursive: true, force: true });
        }
    }, 30_000);
    it.each(['abort', 'failure'])('cleans up the native engine and partial roots on startup %s', async outcome => {
        const home = await mkdtemp('/tmp/hapi-shared-startup-'); state.home = home;
        const ch = join(home, 'codex'); await mkdir(ch);
        await writeFile(join(ch, 'config.toml'), 'model = "mock-model"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n');
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home);
        let entered!: () => void; let release!: () => void;
        const reached = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        state.beforeBootstrap = async () => { entered(); await gate; if (outcome === 'failure') throw new Error('bootstrap failure'); };
        const abort = new AbortController(); const ready = vi.fn();
        const { runSharedRuntime } = await import('./runtime');
        const running = runSharedRuntime({ workingDirectory: home }, ready, abort.signal);
        const result = outcome === 'failure' ? expect(running).rejects.toThrow('bootstrap failure') : expect(running).resolves.toBeUndefined();
        try {
            await Promise.race([reached, running]);
            if (outcome === 'abort') abort.abort();
            release(); await result;
            expect(ready).not.toHaveBeenCalled();
            const { readRuntimes } = await import('./registry');
            const records = await readRuntimes(); expect(records).toHaveLength(1);
            expect(isProcessAlive(records[0].serverPid!)).toBe(false);
            for (const session of state.sessions.values()) {
                expect(session.dead).toBe(true); expect(session.metadata.lifecycleState).not.toBe('archived');
            }
        } finally { release(); abort.abort(); await running.catch(() => {}); await rm(home, { recursive: true, force: true }); }
    }, 30_000);
    it('binds empty roots, exchanges messages, isolates /new, and archives only the selected root', async () => {
        const home = await mkdtemp('/tmp/hapi-shared-test-'); state.home = home;
        const ch = join(home, 'codex'); const cwd = join(home, 'work'); await mkdir(ch); await mkdir(cwd);
        const modelRequests: unknown[] = [];
        const http = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(Buffer.from(chunk)));
            request.on('end', () => {
                if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
                const body = record(JSON.parse(Buffer.concat(chunks).toString()));
                modelRequests.push(body);
                const input = Array.isArray(body.input) ? body.input.map(record) : [];
                let lastUser = -1;
                input.forEach((value, index) => { if (value.role === 'user') lastUser = index; });
                const askAsync = JSON.stringify(input[lastUser]).includes('ASK_ASYNC_QUESTION')
                    && !input.slice(lastUser + 1).some(value => value.type === 'function_call_output');
                const id = randomUUID();
                const output = askAsync ? { type: 'function_call', call_id: `ask_${id}`, name: 'request_user_input_async', arguments: JSON.stringify({
                    questions: [{ title: 'Pick your city', options: ['Beijing', 'Shanghai'] }]
                }) } : { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'MOCK ANSWER' }] };
                const events = [{ type: 'response.created', response: { id } },
                    { type: 'response.output_item.done', item: output },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } }];
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const port = (http.address() as { port: number }).port;
        await writeFile(join(ch, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock_provider"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[features]\nsend_message_to_user_async = true\n[model_providers.mock_provider]\nname = "Isolated mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
        vi.stubEnv('CODEX_HOME', ch); vi.stubEnv('HOME', home); vi.stubEnv('HAPI_SESSION_ID', 'parent-must-not-leak');
        const { runSharedRuntime } = await import('./runtime');
        let ready!: (value: import('./runtime').RuntimeReady) => void;
        const readiness = new Promise<import('./runtime').RuntimeReady>(resolve => { ready = resolve; });
        const abort = new AbortController();
        const running = runSharedRuntime({ workingDirectory: cwd }, ready, abort.signal);
        const clients: CodexAppServerClient[] = [];
        let roots: string[] = [];
        try {
            const { runtime, sessionId } = await Promise.race([readiness, running.then(() => { throw new Error('Runtime stopped before ready'); })]);
            const connect = async () => { const client = new CodexAppServerClient({ endpoint: runtime.endpoint, token: runtime.token });
                client.setServerRequestHandler(() => {}); clients.push(client); await initializeSharedClient(client); return client; };
            const first = await connect(); const second = await connect();
            const initial = runtime.sessions[sessionId].threadId; roots.push(initial);
            const resumed = record(await first.request('thread/resume', { threadId: initial }));
            await second.request('thread/resume', { threadId: initial });
            expect(record(resumed.thread).turns).toEqual([]); expect(modelRequests).toHaveLength(0);
            expect(state.sessions.size).toBe(1);
            const web = state.sessions.get(sessionId)!;
            expect(web.state.requests).toEqual({});
            expect(web.state.completedRequests?.['old-worker']?.status).toBe('canceled');
            web.user?.({ content: { text: 'HELLO FROM WEB' } }, 'web-1');
            await vi.waitFor(() => expect(web.consumed).toContain('web-1'), { timeout: 15_000 });
            await vi.waitFor(() => expect(web.messages).toContainEqual(expect.objectContaining({ type: 'message', message: 'MOCK ANSWER' })), { timeout: 15_000 });
            const newResponse = record(await first.request('thread/start', { cwd }));
            const next = String(record(newResponse.thread).id); roots.push(next);
            expect(next).not.toBe(initial); expect(state.sessions.size).toBe(2);
            const nextSession = [...state.sessions.values()].find(session => session.metadata.codexSessionId === next)!;
            expect(web.metadata.codexSessionId).toBe(initial);
            expect(process.env.HAPI_SESSION_ID).toBe('parent-must-not-leak');
            await first.request('thread/archive', { threadId: next }); roots = [initial];
            await vi.waitFor(() => expect(nextSession.dead).toBe(true)); expect(web.dead).toBe(false);
            await second.request('turn/start', { threadId: initial, model: 'second-mock', input: [{ type: 'text', text: 'HELLO FROM TERMINAL', text_elements: [] }], clientUserMessageId: 'native-1' });
            await vi.waitFor(() => expect(web.messages).toContainEqual({ user: 'HELLO FROM TERMINAL' }), { timeout: 15_000 });
            await vi.waitFor(() => {
                const usageModels = web.messages.map(record).filter(body => body.type === 'token_count').map(body => body.model);
                expect(usageModels).toContain('mock-model');
                expect(usageModels).toContain('second-mock');
            }, { timeout: 15_000 });
            // Use a bundled model's tool catalog while keeping inference on the local mock provider.
            await second.request('thread/settings/update', { threadId: initial, model: 'gpt-6-astra' });
            web.user?.({ content: { text: 'ASK_ASYNC_QUESTION' } }, 'async-question');
            await vi.waitFor(() => expect(Object.values(web.state.requests ?? {})).toContainEqual(expect.objectContaining({
                tool: 'request_user_input', arguments: expect.objectContaining({ async: true })
            })), { timeout: 15_000 }).catch(error => {
                console.error('Async integration tool outputs', modelRequests.slice(-3).flatMap(value => {
                    const input = record(value).input;
                    return Array.isArray(input) ? input.map(record).filter(item => item.type === 'function_call_output').map(item => item.output) : [];
                }));
                throw error;
            });
            const [questionId] = Object.entries(web.state.requests ?? {}).find(([, value]) => record(value.arguments).async === true)!;
            // Legacy async cards remain answerable even after their turn finishes.
            await vi.waitFor(async () => {
                const detail = record(await second.request('thread/read', { threadId: initial, includeTurns: false }));
                expect(record(record(detail.thread).status).type).toBe('idle');
            }, { timeout: 15_000 });
            await web.rpc.get('permission')!({ id: questionId, approved: true, answers: { question_0: { answers: ['Shanghai'] } } });
            await vi.waitFor(() => expect(web.messages).toContainEqual({ user: 'Pick your city\nShanghai' }), { timeout: 15_000 });
            await vi.waitFor(() => expect(web.state.requests?.[questionId]).toBeUndefined(), { timeout: 15_000 });
            expect(web.state.completedRequests?.[questionId]?.status).toBe('resolved');
            await first.disconnect(); expect(web.dead).toBe(false);
            await second.request('thread/archive', { threadId: initial }); roots = [];
            await running;
        } finally {
            for (const threadId of roots) {
                await clients.at(-1)?.request('thread/archive', { threadId }).catch(() => {});
            }
            abort.abort(); await running.catch(() => {});
            await Promise.all(clients.map(client => client.disconnect()));
            await new Promise<void>(resolve => http.close(() => resolve()));
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 60_000);
});
