import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState, Metadata } from '@/api/types';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import { SharedCodexRoot, type RootHost } from './root';
import { codexPlanProposalId } from './plan';
import { asyncQuestionId } from './asyncQuestions';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { hybridModelPolicy } from './hybridModel';
import { deepseekCollaborationPolicy } from './deepseekCollaboration';
import { MINIMAX_MODEL, MINIMAX_PROVIDER, fallbackMessageId } from './minimax';
import { DEEPSEEK_PROVIDER } from './deepseek';
const helper = vi.hoisted(() => ({ enabled: false, hybridAvailable: true }));
vi.mock('./deepseekCollaboration', () => ({ deepseekCollaborationConfig: (sessionId: string) => helper.enabled
    ? { command: '/usr/bin/python3', args: ['fixture-deepseek.py'], env: { DEEPSEEK_HAPI_SESSION_ID: sessionId } } : null,
    deepseekCollaborationPolicy: vi.fn(async (_id: string, mode = 'openai') => ({ mode })) }));
beforeEach(() => { helper.enabled = false; helper.hybridAvailable = true; });
const deepseek = vi.hoisted(() => ({ available: false }));
vi.mock('./deepseek', async importOriginal => {
    const actual = await importOriginal<typeof import('./deepseek')>();
    return { ...actual, deepseekAvailable: () => deepseek.available,
        withDeepSeekModels: (models: unknown[]) => deepseek.available ? [...models, { id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] : models };
});
beforeEach(() => { deepseek.available = false; });
const minimax = vi.hoisted(() => ({ available: false }));
vi.mock('./minimax', async importOriginal => {
    const actual = await importOriginal<typeof import('./minimax')>();
    return { ...actual, minimaxAvailable: () => minimax.available,
        withMiniMaxModel: (models: unknown[]) => minimax.available ? [...models, { id: actual.MINIMAX_MODEL }] : models };
});
beforeEach(() => { minimax.available = false; });

type NativeTurn = { id: string; status: string; items: unknown[] };
vi.mock('./hybridModel', () => ({
    hybridModelAvailable: () => helper.hybridAvailable,
    hybridMcpConfig: (sessionId: string) => ({ command: '/usr/bin/python3', args: ['fixture-minimax.py'], env: { MINIMAX_HAPI_SESSION_ID: sessionId } }),
    hybridModelPolicy: vi.fn(async (_id: string, mode = 'hybrid') => ({ mode }))
}));

vi.mock('../codexAppServerClient', () => ({
    CodexAppServerClient: class {
        initialized = false;
        thread = { id: 'thread', turns: [] as NativeTurn[] };
        settings: Record<string, unknown> = { model: 'mock', collaborationMode: { mode: 'default' } };
        queue: Array<{ id: string; clientUserMessageId: unknown; input: unknown }> = [];
        notify?: (method: string, params: unknown) => void;
        abandoned?: () => void;
        setNotificationHandler(handler: typeof this.notify) { this.notify = handler; }
        setTransportAbandonedHandler(handler: (() => void) | null) { this.abandoned = handler ?? undefined; }
        setServerRequestHandler() {}
        async connect() {}
        async initialize() { this.initialized = true; }
        isInitialized() { return this.initialized; }
        async readRateLimits() { return { rateLimits: { primary: { usedPercent: 41, windowDurationMins: 300 }, secondary: { usedPercent: 6, windowDurationMins: 10_080 } } }; }
        async disconnect() { this.initialized = false; }
        async request(method: string, params: Record<string, unknown> = {}) {
            if (method === 'thread/read' || method === 'thread/resume') return { ...this.settings, thread: structuredClone(this.thread) };
            if (method === 'thread/list') return { data: [] };
            if (method === 'thread/queue/list') return { data: this.queue };
            if (method === 'thread/settings/update') {
                this.settings = { ...this.settings, ...params,
                    ...('serviceTier' in params ? { serviceTier: params.serviceTier ?? 'default' } : {}) };
                this.notify?.('thread/settings/updated', { threadId: 'thread', threadSettings: this.settings });
                return {};
            }
            if (method === 'thread/queue/add') {
                const entry = { id: `queued-${this.queue.length}`, clientUserMessageId: params.clientUserMessageId, input: params.input };
                this.queue.push(entry);
                return { queuedSubmission: entry };
            }
            throw new Error(`Unexpected request: ${method}`);
        }
    },
    isIndeterminateError: () => false
}));
vi.mock('../utils/buildHapiMcpBridge', () => ({ buildHapiMcpBridge: async () => ({
    mcpServers: {}, server: { stop() {} }
}) }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
    finally { vi.useRealTimers(); }
});

async function fixture(hostOverrides: Partial<RootHost> = {}) {
    const directory = await mkdtemp('/tmp/hapi-shared-root-');
    let state: AgentState = { steeringActive: true };
    let metadata: Metadata = { path: directory, host: 'test', flavor: 'codex' };
    let reconnect: (() => void) | null = null;
    let userMessage: Parameters<ApiSessionClient['onUserMessage']>[0] | undefined;
    const updateState = vi.fn((fn: (value: AgentState) => AgentState) => { state = fn(state); });
    const rpc = new Map<string, (raw: unknown) => Promise<unknown>>();
    const send = vi.fn();
    const session = {
        sessionId: 'sid', getMetadata: () => metadata,
        updateMetadata: (fn: (value: Metadata) => Metadata) => { metadata = fn(metadata); },
        updateAgentState: updateState, keepAlive() {},
        onUserMessage(callback: typeof userMessage) { userMessage = callback; }, onCancelQueuedMessage() {}, onRetryQueuedMessage() {},
        onReconnect: (fn: (() => void) | null) => { reconnect = fn; },
        rpcHandlerManager: { registerHandler: (name: string, handler: (raw: unknown) => Promise<unknown>) => rpc.set(name, handler) },
        sendSessionEvent() {}, sendAgentMessage: send, emitSessionReady() {},
        sendUserMessage() {}, emitMessagesConsumed() {}, emitSteerIndeterminate() {}, syncNativeQueuedMessage() {},
        sendSessionDeath() {}, async flush() {}, async flushMetadata() { return true; }, close() {}
    } as unknown as ApiSessionClient;
    const root = new SharedCodexRoot({ session, workingDirectory: directory } as SessionBootstrapResult, {
        directory, generation: 'test', endpoint: 'mock', settingsFor: () => undefined,
        create: async () => { throw new Error('Unexpected root creation'); },
        end: async () => { throw new Error('Unexpected root archive'); },
        ...hostOverrides
    } satisfies RootHost);
    cleanups.push(async () => { await root.close(false); await rm(directory, { recursive: true, force: true }); });
    await root.prepare();
    await root.bind('thread', { model: 'mock', thread: { turns: [] } }, false);
    const native = root.client as unknown as {
        initialized: boolean;
        settings: Record<string, unknown>;
        thread: { id: string; turns: NativeTurn[] };
        queue: Array<{ id: string; clientUserMessageId: string; input: unknown }>;
        notify(method: string, params: unknown): void;
        abandoned(): void;
    };
    return { root, native, rpc, send, metadata: () => metadata, state: () => state, updateState, reconnect: () => reconnect?.(),
        message: (text: string) => userMessage?.({ content: { text } } as Parameters<NonNullable<typeof userMessage>>[0], 'user-command') };
}

describe('native service tier confirmation', () => {
    it('confirms the applied standard tier when native reports default instead of null', async () => {
        const f = await fixture();
        f.native.settings.serviceTier = 'priority';
        f.root.acceptSettings({ model: 'mock', serviceTier: 'priority' });
        const requests = vi.spyOn(f.root.client, 'request');
        const applied = await f.root.applySettings({ serviceTier: 'standard' });
        expect(requests).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({ serviceTier: null }));
        expect(f.native.settings.serviceTier).toBe('default');
        expect(applied).toMatchObject({ applied: { serviceTier: 'standard' } });
    });
});

describe('MiniMax independent approval review', () => {
    it.each(['user', 'auto_review'] as const)('honors a new MiniMax root caller reviewer %s without a stored preference', async reviewer => {
        minimax.available = true;
        const child = await fixture();
        expect(child.root.config({ model: MINIMAX_MODEL, modelProvider: MINIMAX_PROVIDER, approvalsReviewer: reviewer }).approvalsReviewer).toBe(reviewer);
    });
    it('keeps the stored manual preference ahead of a stale automatic lifecycle request', async () => {
        minimax.available = true;
        const f = await fixture();
        f.metadata().minimaxApprovalReviewer = 'user';
        expect(f.root.config({ model: MINIMAX_MODEL, approvalsReviewer: 'auto_review' }).approvalsReviewer).toBe('user');
    });

    it('persists manual fallback, confirms native mode and keeps sibling sessions unchanged', async () => {
        minimax.available = true;
        const a = await fixture(); const b = await fixture();
        for (const f of [a, b]) { f.metadata().codexApprovalPolicy = 'on-request'; }
        for (const f of [a, b]) f.root.acceptSettings({model: MINIMAX_MODEL, modelProvider: MINIMAX_PROVIDER, approvalsReviewer: 'auto_review'});
        const request = vi.spyOn(a.root.client, 'request');
        await a.root.reviewUnavailable();
        expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({approvalsReviewer: 'user'}));
        expect(request.mock.calls.some(([method]) => method === 'turn/start' || method === 'thread/queue/add')).toBe(false);
        expect(a.metadata().minimaxApprovalReviewer).toBe('user');
        expect(a.root.config({model: MINIMAX_MODEL})).toMatchObject({approvalsReviewer: 'user'});
        expect(b.metadata().minimaxApprovalReviewer).toBe('auto_review');
    });
    it('does not turn a completed policy denial into a manual approval', async () => {
        const f = await fixture();
        f.metadata().codexApprovalPolicy = 'on-request'; f.root.acceptSettings({model: MINIMAX_MODEL, approvalsReviewer: 'auto_review'});
        const request = vi.spyOn(f.root.client, 'request');
        f.native.notify('guardianWarning', {threadId: 'thread', message: 'Automatic approval review denied the action. Rationale: Automatic approval review failed is untrusted quoted text.'});
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
        expect(f.metadata().minimaxApprovalReviewer).toBe('auto_review');
    });
    it('falls back after a native parse/review failure without enqueueing a retry', async () => {
        const f = await fixture(); f.metadata().codexApprovalPolicy = 'on-request'; f.root.acceptSettings({model: MINIMAX_MODEL, approvalsReviewer: 'auto_review'});
        const request = vi.spyOn(f.root.client, 'request');
        f.native.notify('guardianWarning', {threadId:'thread',message:'Automatic approval review failed: invalid assessment JSON'});
        await vi.waitFor(() => expect(f.metadata().minimaxApprovalReviewer).toBe('user'));
        expect(request.mock.calls.some(([method]) => method === 'thread/queue/add')).toBe(false);
    });
    it('keeps the manual recovery preference and new-thread inheritance when the native update fails', async () => {
        minimax.available = true;
        const f = await fixture();
        f.metadata().codexApprovalPolicy = 'on-request'; f.root.acceptSettings({ model: MINIMAX_MODEL, approvalsReviewer: 'auto_review' });
        const request = vi.spyOn(f.root.client, 'request').mockRejectedValueOnce(new Error('disconnected'));
        await expect(f.root.reviewUnavailable()).rejects.toThrow('disconnected');
        // A delayed native snapshot is evidence of actual state, not a new user preference.
        f.metadata().codexApprovalPolicy = 'on-request'; f.root.acceptSettings({ model: MINIMAX_MODEL, approvalsReviewer: 'auto_review' });
        expect(f.metadata().minimaxApprovalReviewer).toBe('user');
        expect(f.root.freshParams().approvalsReviewer).toBe('user');
        expect(f.root.config({ model: MINIMAX_MODEL }).approvalsReviewer).toBe('user');
        const child = await fixture();
        expect(child.root.config(f.root.freshParams()).approvalsReviewer).toBe('user');
        await expect(f.root.reviewUnavailable()).rejects.toThrow('disconnected');
        expect(request).toHaveBeenCalledTimes(1); // no automatic replay of the uncertain update
    });
    it('handles a fresh failure during explicit automatic-review recovery after the queued update', async () => {
        let root!: SharedCodexRoot;
        const reset = vi.fn(() => { void root.reviewUnavailable(); });
        const f = await fixture({ resetReviewTransport: reset }); root = f.root;
        await root.activate();
        f.metadata().codexApprovalPolicy = 'on-request';
        f.native.settings = { model: MINIMAX_MODEL, approvalsReviewer: 'auto_review' };
        f.root.acceptSettings(f.native.settings);
        await f.root.reviewUnavailable();
        const request = vi.spyOn(f.root.client, 'request');
        f.message('/reviewer auto');
        await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'thread/settings/update')).toHaveLength(2));
        expect(request.mock.calls.filter(([method]) => method === 'thread/settings/update').map(([, params]) =>
            (params as Record<string, unknown>).approvalsReviewer)).toEqual(['auto_review', 'user']);
        expect(f.metadata().minimaxApprovalReviewer).toBe('user');
        expect(f.root.freshParams().approvalsReviewer).toBe('user');
        expect(request.mock.calls.some(([method]) => method === 'thread/queue/add')).toBe(false);
    });
    it('allows explicit recovery after an unconfirmed fallback without leaving manual preference stuck', async () => {
        const reset = vi.fn();
        const f = await fixture({ resetReviewTransport: reset });
        await f.root.activate();
        f.metadata().codexApprovalPolicy = 'on-request';
        f.native.settings = { model: MINIMAX_MODEL, approvalsReviewer: 'auto_review' };
        f.root.acceptSettings(f.native.settings);
        vi.spyOn(f.root.client, 'request').mockRejectedValueOnce(new Error('disconnected'));
        await expect(f.root.reviewUnavailable()).rejects.toThrow('disconnected');
        f.message('/reviewer auto');
        await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(f.metadata().minimaxApprovalReviewer).toBe('auto_review'));
        expect(f.root.freshParams().approvalsReviewer).toBe('auto_review');
    });
});

describe('durable provider turn projection', () => {
    it('checkpoints a completed turn after its messages flush, preserving its source identity', async () => {
        const f = await fixture();
        f.root.session.updateMetadata(metadata => ({ ...metadata, codexProviderHistory: { previousThreadIds: [], inheritedTurnIds: [], turnOrigins: {} } }));
        const flush = vi.spyOn(f.root.session, 'flush').mockResolvedValue(true);
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'done', status: 'completed' } });
        await vi.waitFor(() => expect(f.metadata().codexProviderHistory?.inheritedTurnIds).toContain('done'));
        expect(flush).toHaveBeenCalledTimes(2);
        expect(f.metadata().codexProviderHistory?.turnOrigins?.done).toBe('thread');
    });
    it('does not hide a completed turn whose outbound messages did not flush', async () => {
        const f = await fixture();
        f.root.session.updateMetadata(metadata => ({ ...metadata, codexProviderHistory: { previousThreadIds: [], inheritedTurnIds: [], turnOrigins: {} } }));
        const flush = vi.spyOn(f.root.session, 'flush').mockResolvedValue(false);
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'uncommitted', status: 'completed' } });
        await vi.waitFor(() => expect(flush).toHaveBeenCalled());
        expect(f.metadata().codexProviderHistory?.inheritedTurnIds).not.toContain('uncommitted');
    });
});

describe('MiniMax independent mode and quota takeover', () => {
    it('waits for asynchronous origin metadata before replaying fork notifications', async () => {
        minimax.available = true;
        const f = await fixture({ switchProvider: async (root, params, beforeFork) => {
            await beforeFork();
            f.native.notify('item/completed', { threadId: 'next-root', turnId: 'inherited',
                item: { id: 'message', type: 'agentMessage', text: 'Preserved history' } });
            await new Promise(resolve => setTimeout(resolve, 20));
            f.native.thread = { id: 'next-root', turns: [] };
            const response = { model: params.model, modelProvider: params.modelProvider, thread: f.native.thread };
            await root.bindProviderThread(response, ['inherited']);
            return response;
        } });
        f.root.acceptSettings({ model: 'gpt-6-astra', modelProvider: 'openai' });
        const applyMetadata = f.root.session.updateMetadata.bind(f.root.session);
        const pending: Array<(metadata: Metadata) => Metadata> = [];
        vi.spyOn(f.root.session, 'updateMetadata').mockImplementation(handler => { pending.push(handler); });
        const flush = vi.spyOn(f.root.session, 'flushMetadata').mockImplementation(async () => {
            expect(f.send.mock.calls.some(([body]) => body.message === 'Preserved history')).toBe(false);
            for (const handler of pending.splice(0)) applyMetadata(handler);
            return true;
        });
        await f.root.applySettings({ model: MINIMAX_MODEL });
        expect(flush).toHaveBeenCalledTimes(1);
        const replay = f.send.mock.calls.find(([body]) => body.message === 'Preserved history');
        expect(replay?.[1]).toBe('codex:thread:inherited:message:agent_message');
    });

    it('quarantines a fork when its origin mapping is not acknowledged', async () => {
        minimax.available = true;
        const f = await fixture({ switchProvider: async (root, params) => {
            const response = { model: params.model, modelProvider: params.modelProvider,
                thread: { id: 'next-root', turns: [{ id: 'inherited', status: 'completed',
                    items: [{ id: 'message', type: 'agentMessage', text: 'Must not replay' }] }] } };
            await root.bindProviderThread(response, ['inherited']);
            return response;
        } });
        f.root.acceptSettings({ model: 'gpt-6-astra', modelProvider: 'openai' });
        vi.spyOn(f.root.session, 'flushMetadata').mockResolvedValue(false);
        await expect(f.root.applySettings({ model: MINIMAX_MODEL })).rejects.toThrow('mapping was not confirmed');
        expect(f.root.threadId).toBe('thread');
        expect(f.send.mock.calls.some(([body]) => body.message === 'Must not replay')).toBe(false);
        expect(f.metadata().modelRouting?.status).toBe('failed');
    });

    it('quarantines a fork when the hub silently drops the origin mapping', async () => {
        minimax.available = true;
        const f = await fixture({ switchProvider: async (root, params) => {
            const response = { model: params.model, modelProvider: params.modelProvider,
                thread: { id: 'next-root', turns: [{ id: 'inherited', status: 'completed',
                    items: [{ id: 'message', type: 'agentMessage', text: 'Must not replay' }] }] } };
            await root.bindProviderThread(response, ['inherited']);
            return response;
        } });
        f.root.acceptSettings({ model: 'gpt-6-astra', modelProvider: 'openai' });
        // The hub answered with a value that no longer carries the origin
        // mapping, so the write drained without the mapping ever landing.
        const applyMetadata = f.root.session.updateMetadata.bind(f.root.session);
        vi.spyOn(f.root.session, 'updateMetadata').mockImplementation(handler => {
            const next = handler(f.metadata());
            const { codexProviderHistory: _dropped, ...rest } = next as Metadata & { codexProviderHistory?: unknown };
            applyMetadata(() => rest as Metadata);
        });
        vi.spyOn(f.root.session, 'flushMetadata').mockResolvedValue(true);
        await expect(f.root.applySettings({ model: MINIMAX_MODEL })).rejects.toThrow('mapping was not confirmed');
        expect(f.root.threadId).toBe('thread');
        expect(f.send.mock.calls.some(([body]) => body.message === 'Must not replay')).toBe(false);
        expect(f.metadata().modelRouting?.status).toBe('failed');
    });

    it('projects early provider-fork notifications as root history, never as a child agent', async () => {
        minimax.available = true;
        const f = await fixture({ switchProvider: async (root, params, beforeFork) => {
            await beforeFork();
            f.native.notify('thread/started', { thread: { id: 'next-root', parentThreadId: 'thread' } });
            f.native.notify('item/completed', { threadId: 'next-root', turnId: 'inherited',
                item: { id: 'message', type: 'agentMessage', text: 'Preserved history' } });
            // Reproduce notifications being handled before the fork reply/rebind.
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(f.send.mock.calls.some(([body]) => body.type === 'agent-run-trace')).toBe(false);
            f.native.thread = { id: 'next-root', turns: [] };
            const response = { model: params.model, modelProvider: params.modelProvider, thread: f.native.thread };
            await root.bindProviderThread(response, []);
            return response;
        } });
        f.root.acceptSettings({ model: 'gpt-6-astra', modelProvider: 'openai' });
        await f.root.applySettings({ model: MINIMAX_MODEL });
        expect(f.root.threadId).toBe('next-root');
        expect(f.send.mock.calls.some(([body]) => body.type === 'agent-run-trace')).toBe(false);
        expect(f.send.mock.calls.some(([body]) => body.type === 'message' && body.message === 'Preserved history')).toBe(true);
    });

    it('releases genuine child notifications when a provider fork fails', async () => {
        minimax.available = true;
        const f = await fixture({ switchProvider: async () => {
            f.native.notify('thread/started', { thread: { id: 'real-child', parentThreadId: 'thread' } });
            f.native.notify('item/completed', { threadId: 'real-child', turnId: 'child-turn',
                item: { id: 'child-message', type: 'agentMessage', text: 'Child output' } });
            await new Promise(resolve => setTimeout(resolve, 20));
            throw new Error('Fork rejected');
        } });
        f.root.acceptSettings({ model: 'gpt-6-astra', modelProvider: 'openai' });
        await expect(f.root.applySettings({ model: MINIMAX_MODEL })).rejects.toThrow('Fork rejected');
        expect(f.send.mock.calls.some(([body]) => body.type === 'agent-run-trace' && body.agentId === 'real-child')).toBe(true);
    });

    async function configured() {
        minimax.available = true;
        const switchProvider = vi.fn(async (root: SharedCodexRoot, params: Record<string, unknown>, beforeUnload: () => Promise<void>) => {
            await beforeUnload();
            const client = root.client as unknown as { settings: Record<string, unknown> };
            client.settings = { ...client.settings, model: params.model, modelProvider: params.modelProvider,
                approvalsReviewer: params.approvalsReviewer,
                reasoningEffort: (params.config as Record<string, unknown>).model_reasoning_effort,
                effort: (params.config as Record<string, unknown>).model_reasoning_effort };
            return { ...client.settings };
        });
        const f = await fixture({ switchProvider });
        Object.assign((f.root.client as unknown as { settings: Record<string, unknown> }).settings, { model: 'gpt-6-astra', modelProvider: 'openai' });
        f.root.acceptSettings({ model: 'gpt-6-astra', modelProvider: 'openai', approvalPolicy: 'on-request',
            approvalsReviewer: 'auto_review', sandbox: { type: 'workspaceWrite', writableRoots: ['/project'], networkAccess: false } });
        await f.root.activate();
        const request = vi.spyOn(f.root.client, 'request');
        const failed = (id = 'quota-turn', error: unknown = { codexErrorInfo: 'usageLimitExceeded', message: 'Quota' }) => {
            f.native.notify('turn/started', { threadId: 'thread', turn: { id } });
            f.native.notify('turn/completed', { threadId: 'thread', turn: { id, status: 'failed', error } });
        };
        return { ...f, switchProvider, request, failed };
    }
    it('routes DeepSeek across OpenAI and MiniMax, with real effort validation and cold configuration', async () => {
        const f = await configured(); deepseek.available = true;
        await expect(f.root.applySettings({ model: 'deepseek-flash', modelReasoningEffort: 'medium' })).rejects.toThrow('DeepSeek supports');
        await expect(f.root.applySettings({ model: 'deepseek-flash', serviceTier: 'fast' })).rejects.toThrow('Fast service tier');
        await expect(f.root.applySettings({ model: 'deepseek-flash', permissionMode: 'safe-yolo' })).rejects.toThrow('safe-yolo');
        expect(f.switchProvider).not.toHaveBeenCalled();
        await f.root.applySettings({ model: 'deepseek-flash' });
        expect(f.switchProvider.mock.calls.at(-1)?.[1]).toMatchObject({ modelProvider: DEEPSEEK_PROVIDER, config: { model_reasoning_effort: 'high' } });
        await f.root.applySettings({ modelReasoningEffort: 'max' });
        await expect(f.root.applySettings({ modelReasoningEffort: 'ultra' })).rejects.toThrow('DeepSeek supports');
        await f.root.applySettings({ model: 'deepseek-v4-pro' });
        expect(f.root.config({ model: 'gpt-6-astra', config: {model_reasoning_effort:'ultra'} })).toMatchObject({ model: 'deepseek-v4-pro', modelProvider: DEEPSEEK_PROVIDER,
            config:{model_reasoning_effort:'high'} });
        await f.root.applySettings({ modelReasoningEffort: null });
        expect(f.request.mock.calls.at(-1)?.[1]).toMatchObject({ effort: 'high' });
        await f.root.applySettings({ model: MINIMAX_MODEL });
        expect(f.switchProvider.mock.calls.at(-1)?.[1]).toMatchObject({ modelProvider: MINIMAX_PROVIDER });
        await f.root.applySettings({ model: 'deepseek-flash' });
        expect(f.switchProvider.mock.calls.at(-1)?.[1]).toMatchObject({ modelProvider: DEEPSEEK_PROVIDER, config: { model_reasoning_effort: 'max' } });
        await f.root.applySettings({ model: 'gpt-6-astra' });
        expect(f.switchProvider.mock.calls.at(-1)?.[1]).toMatchObject({ modelProvider: 'openai', approvalsReviewer: 'auto_review' });
    });
    it('rejects DeepSeek selection on a runtime without its native catalogue', async () => {
        deepseek.available = true;
        const f = await fixture({ deepseekReady: false, switchProvider: vi.fn() });
        await expect(f.root.applySettings({ model: 'deepseek-flash' })).rejects.toThrow('not configured');
    });
    it('applies an explicit DeepSeek effort in the first fork and restores efforts between Flash and Pro', async () => {
        const f = await configured(); deepseek.available = true;
        await f.root.applySettings({model:'deepseek-flash',modelReasoningEffort:'low'});
        expect(f.switchProvider.mock.calls[0][1]).toMatchObject({config:{model_reasoning_effort:'low'}});
        await f.root.applySettings({modelReasoningEffort:'max'});
        await f.root.applySettings({model:'deepseek-v4-pro',modelReasoningEffort:'low'});
        await f.root.applySettings({model:'deepseek-flash'});
        expect(f.request.mock.calls.at(-1)?.[1]).toMatchObject({model:'deepseek-flash',effort:'max'});
        expect(f.switchProvider).toHaveBeenCalledTimes(1);
    });
    it('remembers model efforts and rejects unsupported MiniMax effort before RPC', async () => {
        const f = await configured();
        await expect(f.root.applySettings({ model: MINIMAX_MODEL, modelReasoningEffort: 'ultra' })).rejects.toThrow('MiniMax supports');
        expect(f.switchProvider).not.toHaveBeenCalled();
        await f.root.applySettings({ modelReasoningEffort: 'xhigh' });
        await f.root.applySettings({ model: MINIMAX_MODEL });
        const before = f.request.mock.calls.length;
        await expect(f.root.applySettings({ modelReasoningEffort: 'ultra' })).rejects.toThrow('MiniMax supports');
        expect(f.request.mock.calls.length).toBe(before);
        await f.root.applySettings({ modelReasoningEffort: 'high' });
        await f.root.applySettings({ model: 'gpt-6-astra' });
        expect(f.switchProvider.mock.calls.at(-1)?.[1]).toMatchObject({ config: { model_reasoning_effort: 'xhigh' } });
        await f.root.applySettings({ model: MINIMAX_MODEL });
        expect(f.switchProvider.mock.calls.at(-1)?.[1]).toMatchObject({ config: { model_reasoning_effort: 'high' } });
    });

    it('switches manually with collaboration off, preserves sandbox/reviewer, and can return to OpenAI', async () => {
        const f = await configured();
        f.root.session.updateMetadata(metadata => ({ ...metadata, hybridModel: { mode: 'openai' } }));
        await f.root.applySettings({ model: MINIMAX_MODEL });
        expect(f.switchProvider.mock.calls[0][1]).toMatchObject({ model: MINIMAX_MODEL, modelProvider: MINIMAX_PROVIDER,
            approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write',
            config: { 'sandbox_workspace_write.writable_roots': ['/project'], 'sandbox_workspace_write.network_access': false } });
        expect(f.metadata().modelRouting).toMatchObject({ provider: 'minimax', reason: 'manual', status: 'active' });
        expect(f.metadata().modelRouting?.openaiApprovalsReviewer).toBe('auto_review');
        expect(f.root.config({ model: 'gpt-6-astra', modelProvider: 'openai' })).toMatchObject({ model: MINIMAX_MODEL,
            modelProvider: MINIMAX_PROVIDER, approvalsReviewer: 'auto_review' });
        expect(f.metadata().codexSessionId).toBe('thread');
        await f.root.applySettings({ model: 'gpt-6-astra' });
        expect(f.switchProvider.mock.calls[1][1]).toMatchObject({ modelProvider: 'openai', approvalsReviewer: 'auto_review' });
        expect(f.metadata().modelRouting?.provider).toBe('openai');
    });
    it('continues exactly once after confirmed account exhaustion with the authoritative hybrid gate on', async () => {
        const f = await configured();
        f.failed(); f.failed();
        await vi.waitFor(() => expect(f.metadata().modelRouting?.status).toBe('active'));
        await vi.waitFor(() => expect(f.request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1));
        expect(f.switchProvider).toHaveBeenCalledTimes(1);
        expect(f.request).toHaveBeenCalledWith('thread/queue/add', expect.objectContaining({ clientUserMessageId: fallbackMessageId('quota-turn') }));
        expect(f.metadata().modelRouting).toMatchObject({ reason: 'usage-limit', failedTurnId: 'quota-turn' });
    });
    it('does not take over when the persisted policy is off even if metadata says on', async () => {
        const f = await configured();
        vi.mocked(hybridModelPolicy).mockResolvedValueOnce({ mode: 'openai' });
        f.failed();
        await vi.waitFor(() => expect(f.metadata().hybridModel?.mode).toBe('openai'));
        expect(f.switchProvider).not.toHaveBeenCalled();
    });
    it('ignores ordinary rate limits, transport failures, child and unrelated thread errors', async () => {
        const f = await configured();
        f.failed('rate', { codexErrorInfo: 'rateLimitExceeded', message: 'Slow down' });
        f.failed('network', { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } }, message: '429' });
        f.native.notify('turn/completed', { threadId: 'other', turn: { id: 'other', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(f.switchProvider).not.toHaveBeenCalled();
    });
    it('uses a terminal typed error notification when completed omits the error, but not an automatic retry', async () => {
        const f = await configured();
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'retry' } });
        f.native.notify('error', { threadId: 'thread', turnId: 'retry', willRetry: true, error: { codexErrorInfo: 'usageLimitExceeded' } });
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'retry', status: 'failed' } });
        await new Promise(resolve => setTimeout(resolve, 20)); expect(f.switchProvider).not.toHaveBeenCalled();
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'final' } });
        f.native.notify('error', { threadId: 'thread', turnId: 'final', willRetry: false, error: { codexErrorInfo: 'usageLimitExceeded' } });
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'final', status: 'failed' } });
        await vi.waitFor(() => expect(f.switchProvider).toHaveBeenCalledOnce());
    });
    it('reports an unconfirmed switch and does not enqueue a continuation', async () => {
        const f = await configured();
        f.switchProvider.mockRejectedValueOnce(new Error('unconfirmed'));
        f.failed();
        await vi.waitFor(() => expect(f.metadata().modelRouting?.status).toBe('failed'));
        expect(f.request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(0);
    });
    it('handles a late terminal quota error once, after completion omitted its error', async () => {
        const f = await configured();
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'late' } });
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'late', status: 'failed' } });
        f.native.notify('error', { threadId: 'thread', turnId: 'late', willRetry: false, error: { codexErrorInfo: 'usageLimitExceeded' } });
        f.native.notify('error', { threadId: 'thread', turnId: 'late', willRetry: false, error: { codexErrorInfo: 'usageLimitExceeded' } });
        await vi.waitFor(() => expect(f.switchProvider).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(f.request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1));
    });
    it('restores the session without automatic continuation when hybrid policy cannot be confirmed', async () => {
        minimax.available = true;
        const f = await fixture();
        f.root.acceptSettings({ model: MINIMAX_MODEL, modelProvider: MINIMAX_PROVIDER });
        f.root.session.updateMetadata(metadata => ({ ...metadata, modelRouting: { provider: 'minimax', reason: 'usage-limit',
            status: 'active', failedTurnId: 'cold-quota', updatedAt: Date.now() } }));
        vi.mocked(hybridModelPolicy).mockRejectedValueOnce(new Error('Policy unavailable'));
        const request = vi.spyOn(f.root.client, 'request');
        await expect(f.root.activate()).resolves.toBeUndefined();
        expect(request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(0);
    });
});

describe('project new conversations', () => {
    const project = { id: 'FF', name: '家庭记账', directory: '/project/family-finance', controllerSessionId: 'sid', role: 'controller' as const };
    function childFixture() {
        const child = { session: { sessionId: 'new-sid' }, threadId: 'new-thread', initialSettings: vi.fn(async () => {}) } as unknown as SharedCodexRoot;
        const calls: Parameters<RootHost['create']>[] = [];
        const create: RootHost['create'] = async (...args) => { calls.push(args); return child; };
        return { child, calls, create };
    }
    it('inherits a project on the original creation chain and preserves the controller cwd and identity', async () => {
        const c = childFixture(); const f = await fixture({ create: c.create });
        const originalCwd = f.metadata().path;
        f.root.session.updateMetadata(metadata => ({ ...metadata, project }));
        const baseline = f.root.freshParams();
        await f.root.activate();
        expect(await f.rpc.get(RPC_METHODS.ClearConversation)!({})).toEqual({ sessionId: 'new-sid' });
        expect(c.calls).toHaveLength(1);
        expect(c.calls[0][0]).toBe('thread/start');
        expect(c.calls[0][1]).toEqual({ ...baseline, cwd: project.directory });
        expect(c.calls[0][2]).toBeUndefined();
        expect(c.calls[0][3]).toEqual({ ...project, role: 'research', createdFromSessionId: 'sid' });
        expect(f.metadata().path).toBe(originalCwd);
        expect(f.metadata().codexSessionId).toBe('thread');
        expect(f.metadata().project?.role).toBe('controller');
        expect(c.child.initialSettings).toHaveBeenCalledTimes(1);
    });
    it('keeps an unbound conversation on its original path', async () => {
        const c = childFixture(); const f = await fixture({ create: c.create });
        const baseline = f.root.freshParams(); await f.root.activate();
        await f.rpc.get(RPC_METHODS.ClearConversation)!({});
        expect(c.calls[0]).toEqual(['thread/start', baseline]);
        expect(f.metadata().project).toBeUndefined();
    });
    it('keeps a fork distinct from ordinary new, preserving its actual cwd', async () => {
        const c = childFixture(); const f = await fixture({ create: c.create });
        f.root.session.updateMetadata(metadata => ({ ...metadata, project }));
        const baseline = f.root.freshParams(); await f.root.activate();
        await f.rpc.get(RPC_METHODS.ForkConversation)!({});
        expect(c.calls[0][0]).toBe('thread/fork');
        expect(c.calls[0][1]).toEqual({ ...baseline, threadId: 'thread' });
        expect(c.calls[0][2]).toBe(f.root);
        expect(c.calls[0][3]).toMatchObject({ id: 'FF', role: 'research', controllerSessionId: 'sid' });
    });
    it('uses its own bridge identity even when the controller is another session', async () => {
        const f = await fixture();
        f.root.session.updateMetadata(metadata => ({ ...metadata, project: { ...project, role: 'research', controllerSessionId: 'different-controller' } }));
        const config = f.root.config({ developerInstructions: 'Keep custom text', config: { 'mcp_servers.other': { command: 'other' } } });
        expect(config.developerInstructions).toContain('Keep custom text');
        expect(config.developerInstructions).toContain('different-controller');
        expect(config.config).toMatchObject({ 'shell_environment_policy.set.HAPI_SESSION_ID': 'sid', 'mcp_servers.other': { command: 'other' } });
    });
});

async function completePlan(f: Awaited<ReturnType<typeof fixture>>, status = 'completed') {
    await f.root.applySettings({ collaborationMode: 'plan' });
    const turn = { id: 'plan-turn', status: 'inProgress', items: [{ id: 'plan-item', type: 'plan', text: '# Implement me' }] };
    f.native.thread.turns.push(turn);
    f.native.notify('turn/started', { threadId: 'thread', turn: { id: turn.id } });
    f.native.notify('item/completed', { threadId: 'thread', turnId: turn.id, item: turn.items[0] });
    expect(f.state().codexPlanProposalId).toBeNull();
    turn.status = status;
    f.native.notify('turn/completed', { threadId: 'thread', turn: { id: turn.id, status } });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'ExitPlanMode' }), expect.any(String)));
    return codexPlanProposalId('thread', turn.id, 'plan-item');
}

describe('shared plan actions', () => {
    it('changes DeepSeek independently and preserves MiniMax and native thread settings', async () => {
        const f = await fixture();
        await f.root.activate();
        const minimaxBefore = f.metadata().hybridModel;
        const change = f.rpc.get(RPC_METHODS.DeepSeekCollaboration)!;
        expect(await change({ mode: 'hybrid' })).toEqual({ mode: 'hybrid' });
        expect(deepseekCollaborationPolicy).toHaveBeenLastCalledWith('sid', 'hybrid');
        expect(f.metadata().deepseekCollaboration).toEqual({ mode: 'hybrid' });
        expect(f.metadata().hybridModel).toEqual(minimaxBefore);
        await f.rpc.get(RPC_METHODS.HybridModel)!({ mode: 'openai' });
        expect(f.metadata().deepseekCollaboration).toEqual({ mode: 'hybrid' });
        await expect(change({ mode: 'hybrid', sessionId: 'other' })).rejects.toThrow();
    });
    it('serializes DeepSeek writes and retains its confirmed value after failure', async () => {
        const f = await fixture();
        await f.root.activate();
        const policy = vi.mocked(deepseekCollaborationPolicy);
        let finish!: (value: { mode: 'openai' | 'hybrid' }) => void;
        policy.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const change = f.rpc.get(RPC_METHODS.DeepSeekCollaboration)!;
        const on = change({ mode: 'hybrid' });
        const off = change({ mode: 'openai' });
        await vi.waitFor(() => expect(finish).toBeDefined());
        finish({ mode: 'hybrid' });
        await on; await off;
        expect(f.metadata().deepseekCollaboration).toEqual({ mode: 'openai' });
        policy.mockRejectedValueOnce(new Error('unconfirmed'));
        await expect(change({ mode: 'hybrid' })).rejects.toThrow('unconfirmed');
        expect(f.metadata().deepseekCollaboration).toEqual({ mode: 'openai' });
    });
    it('serializes concurrent hybrid changes and publishes the last confirmed choice', async () => {
        const f = await fixture();
        await f.root.activate();
        const policy = vi.mocked(hybridModelPolicy);
        let finish!: (value: { mode: 'openai' | 'hybrid' }) => void;
        policy.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const change = f.rpc.get(RPC_METHODS.HybridModel)!;
        const off = change({ mode: 'openai' });
        const on = change({ mode: 'hybrid' });
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        expect(policy).toHaveBeenLastCalledWith('sid', 'openai');
        finish({ mode: 'openai' });
        expect(await off).toEqual({ mode: 'openai' });
        expect(await on).toEqual({ mode: 'hybrid' });
        expect(f.metadata().hybridModel).toEqual({ mode: 'hybrid' });
    });
    it('binds hybrid MCP to the root and changes policy without a native model turn', async () => {
        const f = await fixture();
        await f.root.activate();
        const config = f.root.config({ config: {} }).config as Record<string, unknown>;
        expect(config['mcp_servers.minimax_helper']).toMatchObject({ env: { MINIMAX_HAPI_SESSION_ID: 'sid' } });
        expect(config['shell_environment_policy.set.HAPI_SESSION_ID']).toBe('sid');
        const native = vi.spyOn(f.root.client, 'request');
        native.mockClear();
        expect(await f.rpc.get(RPC_METHODS.HybridModel)!({ mode: 'openai' })).toEqual({ mode: 'openai' });
        expect(hybridModelPolicy).toHaveBeenLastCalledWith('sid', 'openai');
        expect(f.metadata().hybridModel).toEqual({ mode: 'openai' });
        expect(native).not.toHaveBeenCalled();
        await expect(f.rpc.get(RPC_METHODS.HybridModel)!({ mode: 'hybrid', sessionId: 'other' })).rejects.toThrow();
    });
    it('does not create a transportless DeepSeek entry when no DeepSeek service is configured', async () => {
        helper.hybridAvailable = false;
        const f = await fixture(); minimax.available = true;
        const config = f.root.config({ model: MINIMAX_MODEL, config: {} }).config as Record<string, unknown>;
        const servers = config.mcp_servers as Record<string, unknown> | undefined;
        expect(config['mcp_servers.deepseek'] ?? servers?.deepseek).toBeUndefined();
        // MiniMax's existing standalone adapter intentionally provides its own
        // complete disabled helper transport, independent of helper availability.
        expect(config['mcp_servers.minimax_helper'] ?? servers?.minimax_helper).toMatchObject({
            command: '/usr/bin/python3', enabled: false
        });
    });
    it('disables complete nested transports without discarding connection fields', async () => {
        helper.hybridAvailable = false;
        const f = await fixture(); minimax.available = true;
        const config = f.root.config({ model: MINIMAX_MODEL, config: { mcp_servers: {
            deepseek: { url: 'http://127.0.0.1:9/mcp', headers: { 'X-Fixture': 'public' } },
            minimax_helper: { command: '/usr/bin/python3', args: ['fixture.py'] }
        } } }).config as Record<string, unknown>;
        const servers = config.mcp_servers as Record<string, unknown>;
        expect(servers.deepseek).toMatchObject({ url: 'http://127.0.0.1:9/mcp', headers: { 'X-Fixture': 'public' }, enabled: false });
        expect(servers.minimax_helper).toMatchObject({ command: '/usr/bin/python3', args: ['/home/ubuntu/workspace/minimax-codex/worker.py', 'mcp'], enabled: false });
    });
    it('binds the DeepSeek helper to each OpenAI root and disables both helpers for standalone providers', async () => {
        helper.enabled = true; deepseek.available = true;
        const f = await fixture();
        await f.root.activate();
        expect(f.metadata().capabilities?.deepseekCollaboration).toBe(true);
        const config = f.root.config({ model: 'gpt-test', config: {} }).config as Record<string, unknown>;
        expect(config['mcp_servers.deepseek']).toMatchObject({ env: { DEEPSEEK_HAPI_SESSION_ID: 'sid' } });
        for (const model of ['deepseek-flash', MINIMAX_MODEL]) {
            deepseek.available = true; minimax.available = true;
            const standalone = f.root.config({ model, config: {} }).config as Record<string, unknown>;
            const servers = standalone.mcp_servers as Record<string, unknown> | undefined;
            expect(standalone['mcp_servers.deepseek'] ?? servers?.deepseek).toMatchObject({ enabled: false });
            expect(standalone['mcp_servers.minimax_helper'] ?? servers?.minimax_helper).toMatchObject({ enabled: false });
        }
    });
    it('refreshes idle account limits once per minute without waiting for a turn', async () => {
        const f = await fixture();
        await f.root.activate();
        const read = vi.spyOn(f.root.client, 'readRateLimits');
        const now = vi.spyOn(Date, 'now');
        try {
            const start = Date.now();
            now.mockReturnValue(start + 60_000);
            await f.root.refresh();
            await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
            expect(f.metadata().codexRateLimits?.primary?.usedPercent).toBe(41);
            await f.root.refresh();
            expect(read).toHaveBeenCalledTimes(1);
            now.mockReturnValue(start + 120_000);
            await f.root.refresh();
            await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        } finally {
            now.mockRestore();
        }
    });

    it('pauses quota reads after an idle hour and resumes on a native turn', async () => {
        const f = await fixture();
        await f.root.activate();
        const read = vi.spyOn(f.root.client, 'readRateLimits');
        const now = vi.spyOn(Date, 'now');
        try {
            const start = Date.now();
            now.mockReturnValue(start + 60 * 60_000 + 1);
            await f.root.refresh();
            expect(read).not.toHaveBeenCalled();

            f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'new-turn' } });
            await f.root.refresh();
            await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));

            f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'new-turn', status: 'completed' } });
            now.mockReturnValue(start + 2 * 60 * 60_000 + 2);
            await f.root.refresh();
            expect(read).toHaveBeenCalledTimes(1);
        } finally {
            now.mockRestore();
        }
    });

    it('persists remote title tools while retaining native terminal rename events', async () => {
        const f = await fixture();
        const item = { id: 'title', type: 'mcpToolCall', server: 'hapi', tool: 'change_title',
            arguments: { title: 'Remote title' }, status: 'completed', result: { content: [], isError: false } };
        f.native.notify('item/completed', { threadId: 'thread', turnId: 'turn', item });
        await vi.waitFor(() => expect(f.metadata().summary?.text).toBe('Remote title'));
        f.native.notify('thread/name/updated', { threadId: 'thread', threadName: 'Terminal title' });
        await vi.waitFor(() => expect(f.metadata().name).toBe('Terminal title'));
        await f.root.refresh();
        expect(f.metadata().summary?.text).toBe('Remote title');
        expect(f.metadata().name).toBe('Terminal title');
    });

    it('preserves content while native turns, mode changes and disconnects withdraw controls', async () => {
        const f = await fixture();
        const id = await completePlan(f);
        expect(f.state().codexPlanProposalId).toBe(id);
        expect(f.state().requests).toEqual({});
        await f.root.applySettings({ collaborationMode: 'default' });
        expect(f.state().codexPlanProposalId).toBeNull();
        await f.root.applySettings({ collaborationMode: 'plan' });
        expect(f.state().codexPlanProposalId).toBe(id);
        f.native.initialized = false; f.native.abandoned();
        expect(f.state().codexPlanProposalId).toBeNull();
        await vi.waitFor(() => expect(f.state().codexPlanProposalId).toBe(id));
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'new' } });
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'plan-turn', status: 'completed' } });
        expect(f.state().codexPlanProposalId).toBeNull();
        expect(f.send.mock.calls.some(([message]) => message.input?.plan === '# Implement me')).toBe(true);
    });

    it.each(['failed', 'interrupted'])('does not offer a proposal from a %s turn', async status => {
        const f = await fixture();
        await completePlan(f, status);
        await f.root.refresh();
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('uses only the latest root turn when replaying history', async () => {
        const f = await fixture();
        const id = await completePlan(f);
        f.reconnect();
        await f.root.refresh();
        await vi.waitFor(() => expect(f.state().codexPlanProposalId).toBe(id));
        f.native.thread.turns.push({ id: 'new', status: 'completed', items: [] });
        await f.root.refresh();
        expect(f.state().codexPlanProposalId).toBeNull();
        f.native.notify('item/completed', { threadId: 'child', turnId: 'child-turn', item: { id: 'p', type: 'plan', text: 'child' } });
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('switches mode and submits once across repeated Web actions and lost replies', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const action = () => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id });
        const request = vi.spyOn(f.root.client, 'request');
        expect(await Promise.all([action(), action()])).toEqual([{ ok: true }, { ok: true }]);
        f.reconnect();
        expect(await action()).toEqual({ ok: true });
        expect(request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
        const settingsIndex = request.mock.calls.findIndex(([method]) => method === 'thread/settings/update');
        const queueIndex = request.mock.calls.findIndex(([method]) => method === 'thread/queue/add');
        expect(settingsIndex).toBeLessThan(queueIndex);
        expect(request.mock.calls[settingsIndex][1]).toMatchObject({ collaborationMode: { mode: 'default' } });
        expect(f.native.queue[0]).toMatchObject({ input: [{ type: 'text', text: 'Implement the plan.' }] });
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('does not let a slow history snapshot resurrect a plan after native continuation', async () => {
        const f = await fixture();
        await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        let reading!: () => void;
        const started = new Promise<void>(resolve => { reading = resolve; });
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns) {
                reading(); await blocked;
            }
            return result;
        });
        const refresh = f.root.refresh();
        await started;
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'terminal-continued' } });
        release(); await refresh;
        expect(f.state().codexPlanProposalId).toBeNull();
    });

    it('does not change mode when native input appears during the action preflight', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        const spy = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            if (method === 'thread/queue/list') f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'terminal' } });
            return result;
        });
        expect(await f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id })).toMatchObject({ ok: false, code: 'stale_plan' });
        expect(spy.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false);
        expect(f.native.queue).toHaveLength(0);
    });

    it('rejects stale proposals and native activity arriving during the mode switch', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const action = (planId = id) => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId });
        expect(await action('old')).toMatchObject({ ok: false, code: 'stale_plan' });
        const request = f.root.client.request.bind(f.root.client);
        vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            if (method === 'thread/settings/update') f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'terminal' } });
            return result;
        });
        expect(await action()).toMatchObject({ ok: false, code: 'stale_plan' });
        expect(f.native.queue).toHaveLength(0);
    });

    it('does not resend an implementation with an unknown queue outcome', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = await completePlan(f);
        const request = f.root.client.request.bind(f.root.client);
        const spy = vi.spyOn(f.root.client, 'request').mockImplementation(async (method, params) => {
            const result = await request(method, params);
            // An invalid response schema leaves delivery indeterminate even after acceptance.
            return method === 'thread/queue/add' ? {} : result;
        });
        const action = () => f.rpc.get(RPC_METHODS.ImplementCodexPlan)!({ planId: id });
        expect(await action()).toMatchObject({ ok: false, code: 'indeterminate' });
        f.native.queue = []; // Absence is not proof of cancellation or delivery.
        expect(await action()).toMatchObject({ ok: false, code: 'indeterminate' });
        expect(spy.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
    });
});

describe('shared steering availability', () => {
    it('preserves custom instructions and config on new/resumed roots while enabling waiting questions', async () => {
        const f = await fixture();
        const config = f.root.config({ developerInstructions: 'Keep this custom instruction',
            config: { 'features.default_mode_request_user_input': false, 'mcp_servers.other': { command: 'other' } } });
        expect(config.developerInstructions).toContain('Keep this custom instruction');
        expect(config.developerInstructions).toContain('<hapi_user_input>');
        expect(config.config).toMatchObject({ 'features.default_mode_request_user_input': true, 'mcp_servers.other': { command: 'other' } });
        expect(f.root.config(config).developerInstructions).toBe(config.developerInstructions);
        expect(f.root.freshParams().developerInstructions).toContain('<hapi_user_input>');
        const migrated = String(f.root.config({ developerInstructions: 'Before\n<hapi_user_input>Old waiting rule</hapi_user_input>\nAfter' }).developerInstructions);
        expect(migrated).toContain('Before'); expect(migrated).toContain('After');
        expect(migrated).toContain('20 minutes'); expect(migrated).not.toContain('Old waiting rule');
        expect(migrated.match(/<hapi_user_input>/g)).toHaveLength(1);
    });
    it('keeps idle sessions online without polling usage or publishing agent-state updates', async () => {
        const f = await fixture();
        const requests = vi.spyOn(f.root.client, 'request');
        const heartbeat = vi.spyOn(f.root.session, 'keepAlive');
        const updates = f.updateState.mock.calls.length;
        vi.useFakeTimers();

        await f.root.activate();
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(heartbeat).toHaveBeenCalled();
        expect(requests).not.toHaveBeenCalled();
        expect(f.updateState).toHaveBeenCalledTimes(updates);
    });

    it('routes native async question notifications and permission answers through the existing queue', async () => {
        const f = await fixture();
        await f.root.activate();
        const item = { type: 'agentMessage', id: 'ask', text: '', delivery: 'async', questions: [{ title: 'Which?', options: ['A', 'B'] }] };
        const id = asyncQuestionId('thread', 'ask');
        f.native.thread.turns = [{ id: 'turn', status: 'inProgress', items: [item] }];
        f.native.notify('item/completed', { threadId: 'thread', turnId: 'turn', item });
        await vi.waitFor(() => expect(f.state().requests?.[id]).toBeDefined());
        await f.root.refresh(); // a live snapshot must not erase the question
        await f.rpc.get('permission')!({ id, approved: true, answers: { question_0: { answers: ['B'] } } });
        expect(f.native.queue).toHaveLength(1);
        expect(f.native.queue[0]).toMatchObject({ clientUserMessageId: `${id}:answer`, input: [{ type: 'text', text: 'Which?\nB' }] });
        await expect(f.rpc.get('permission')!({ id, approved: true, answers: { question_0: ['B'] } })).rejects.toThrow('already resolved or submitted');
        const reply = { type: 'userMessage', id: 'reply', clientId: `${id}:answer`, content: [{ type: 'text', text: 'Which?\nB' }] };
        f.native.thread.turns[0].items.push(reply);
        f.native.notify('item/completed', { threadId: 'thread', turnId: 'turn', item: reply });
        await vi.waitFor(() => expect(f.state().requests?.[id]).toBeUndefined());
        expect(f.state().completedRequests?.[id]?.status).toBe('resolved');
        await f.root.refresh();
        expect(f.state().requests?.[id]).toBeUndefined();
    });

    it('restores an unanswered async question after native reconnection without duplicating a queued answer', async () => {
        const f = await fixture();
        await f.root.activate();
        const id = asyncQuestionId('thread', 'restore');
        f.native.thread.turns = [{ id: 'turn', status: 'completed', items: [{ type: 'agentMessage', id: 'restore',
            text: '', delivery: 'async', questions: [{ title: 'Free text?', options: null }] }] }];
        await f.root.refresh();
        const reply = { id, approved: true, answers: { question_0: ['My answer'] } };
        await f.rpc.get('permission')!(reply);
        f.native.initialized = false; f.native.abandoned();
        await vi.waitFor(() => expect(f.state().requests?.[id]).toBeDefined());
        await f.rpc.get('permission')!(reply);
        expect(f.native.queue).toHaveLength(1);
    });

    it('publishes root turn transitions, ignores child turns, and clears on shutdown', async () => {
        const f = await fixture();
        expect(f.state().steeringActive).toBe(false);
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
        expect(f.state().steeringActive).toBe(true);
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'old-turn' } });
        expect(f.state().steeringActive).toBe(true);
        f.native.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
        expect(f.state().steeringActive).toBe(false);
        f.native.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
        expect(f.state().steeringActive).toBe(false);
        f.native.notify('turn/started', { threadId: 'thread', turn: { id: 'next' } });
        f.root.stopAccepting();
        expect(f.state().steeringActive).toBe(false);
    });

    it('reconciles native and Hub reconnects without publishing on every refresh', async () => {
        const f = await fixture();
        const updates = f.updateState.mock.calls.length;
        await f.root.refresh(); await f.root.refresh();
        expect(f.updateState).toHaveBeenCalledTimes(updates);
        f.native.thread.turns = [{ id: 'busy', status: 'inProgress', items: [] }];
        f.reconnect();
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(true));
        f.native.initialized = false; f.native.abandoned();
        expect(f.state().steeringActive).toBe(false);
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(true));
        f.native.thread.turns = [{ id: 'busy', status: 'completed', items: [] }];
        f.reconnect();
        await vi.waitFor(() => expect(f.state().steeringActive).toBe(false));
    });
});


describe('durable no-approval preference', () => {
    it('defaults independent MiniMax to authorized Full Access and never', async () => {
        minimax.available = true; const f = await fixture();
        expect(f.root.config({ model: MINIMAX_MODEL, approvalPolicy: 'on-request', sandbox: 'workspace-write' }))
            .toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
        f.metadata().codexApprovalPolicy = 'never';
        expect(f.root.config({ model: 'gpt-6-astra', approvalPolicy: 'on-request', sandbox: 'read-only' }))
            .toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only' });
    });
    it('never falls back to human approvals or replays a task after review failure when prompts are disabled', async () => {
        const f = await fixture(); f.metadata().codexApprovalPolicy = 'never';
        f.root.acceptSettings({ model: MINIMAX_MODEL, approvalsReviewer: 'auto_review', approvalPolicy: 'never' });
        const request = vi.spyOn(f.root.client, 'request');
        await f.root.reviewUnavailable();
        expect(request).not.toHaveBeenCalled();
        expect(f.metadata().codexApprovalPolicy).toBe('never');
        expect(f.root.freshParams().approvalPolicy).toBe('never');
    });
    it('persists user intent across an unconfirmed native update and keeps siblings unchanged', async () => {
        const f = await fixture(); const sibling = await fixture();
        const request = vi.spyOn(f.root.client, 'request').mockRejectedValueOnce(new Error('disconnected'));
        await expect(f.root.applySettings({ approvalPolicy: 'never' })).rejects.toThrow('disconnected');
        expect(f.metadata().codexApprovalPolicy).toBe('never');
        f.root.acceptSettings({ model: 'mock', approvalPolicy: 'on-request' });
        expect(f.root.config({ model: 'mock', sandbox: 'workspace-write' })).toMatchObject({ approvalPolicy: 'never' });
        expect(sibling.metadata().codexApprovalPolicy).toBeUndefined();
        expect(request).toHaveBeenCalledTimes(1);
    });
});


it('persists full automation before native confirmation and keeps it across model changes', async () => {
    minimax.available = true; const f = await fixture();
    await f.root.applySettings({ fullAuto: true });
    expect(f.metadata()).toMatchObject({ codexFullAuto: true, codexApprovalPolicy: 'never' });
    expect(f.native.settings).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    expect(f.root.config({ model: 'gpt-6-astra', sandbox: 'workspace-write', approvalPolicy: 'on-request' }))
        .toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(f.root.config({ model: MINIMAX_MODEL, sandbox: 'workspace-write', approvalPolicy: 'on-request' }))
        .toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
});
