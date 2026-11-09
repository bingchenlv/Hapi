import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, chmod, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { assertProviderHistoryPreserved } from './providerHistoryAcceptance';
import { tmpdir } from 'node:os';
import { inheritSessionProject, MINIMAX_MODEL, type SessionProject } from '@hapi/protocol';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { configuration } from '@/configuration';
import { bootstrapSession, bootstrapExistingSession } from '@/agent/sessionFactory';
import { notifyRunnerSessionStarted } from '@/runner/controlClient';
import { getProcessStartMarker, killProcessByChildProcess } from '@/utils/process';
import { logger } from '@/ui/logger';
import { CodexAppServerClient, isIndeterminateError } from '../codexAppServerClient';
import { codexHome, saveRuntime, runtimeDirectory, runtimeAuthHash, findColdBinding, withThreadOwnership, type CodexRuntimeRecord } from './registry';
import { startCodexGateway, record, string, type Envelope } from './gateway';
import { resolveSharedCodex, sharedLaunchConfig, initializeSharedClient, checkSharedCapabilities, takeReservedSessionId, type SharedLaunchOptions } from './launch';
import { SharedCodexRoot } from './root';
import { minimaxAvailable, minimaxServerArgs, minimaxProviderConfig } from './minimax';
import { startMiniMaxReviewRouter } from './minimaxReviewRouter';
import { prepareMiniMaxCatalog } from './nativeMiniMaxCatalog';
import { deepseekAvailable, deepseekServerArgs, prepareDeepSeekCatalog } from './deepseek';
import { providerHistorySnapshot, type ProviderHistorySnapshot } from './providerHistory';
import { createRetirementStore, retireProviderThread } from './providerRetirement';
import { buildForkSessionSummary } from '@hapi/protocol';

export type RuntimeReady = { sessionId: string; runtime: CodexRuntimeRecord };
type Reservation = { root: SharedCodexRoot; resumeId?: string };

function gitInfo(cwd: string): { sha: string | null; branch: string | null; originUrl: string | null } {
    const git = (...args: string[]) => {
        try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
        catch { return null; }
    };
    let originUrl = git('remote', 'get-url', 'origin');
    if (originUrl && /^https?:/.test(originUrl)) {
        try { const url = new URL(originUrl); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; originUrl = url.toString(); }
        catch { originUrl = null; }
    }
    return { sha: git('rev-parse', 'HEAD'), branch: git('symbolic-ref', '--short', 'HEAD'), originUrl };
}
async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No private port');
    await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}

/** One ordinary CLI execution owns one private engine, with concurrent frontends. */
export async function runSharedRuntime(options: SharedLaunchOptions, onReady?: (ready: RuntimeReady) => void, abortSignal?: AbortSignal): Promise<void> {
    abortSignal?.throwIfAborted();
    const command = resolveSharedCodex();
    const launch = sharedLaunchConfig(options, options.workingDirectory ?? process.cwd());
    const id = randomUUID();
    await mkdir(codexHome(), { recursive: true, mode: 0o700 });
    const home = await realpath(codexHome());
    await mkdir(runtimeDirectory(), { recursive: true, mode: 0o700 });
    // Unix sockaddr_un has a small path limit; don't nest sockets under CODEX_HOME.
    const sockets = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'hapi-cx-')); await chmod(sockets, 0o700);
    const token = randomBytes(32).toString('hex');
    const upstream = process.platform === 'win32' ? `ws://127.0.0.1:${await freePort()}` : `unix://${join(sockets, 'engine.sock')}`;
    const upstreamToken = process.platform === 'win32' ? randomBytes(32).toString('hex') : undefined;
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
    // Every thread injects its own identity. A launch from another agent must not inherit that root's identity.
    delete env.HAPI_SESSION_ID;
    delete env.HAPI_SESSION_PROJECT;
    let server: ChildProcess | undefined;
    let reviewRouter: Awaited<ReturnType<typeof startMiniMaxReviewRouter>> | undefined;
    let minimaxCatalogUnavailable = false;
    let deepseekReady = false;
    const catalogWarnings = new Set<string>();
    const warnCatalog = (root: SharedCodexRoot, response: Record<string, unknown>) => {
        if (!minimaxCatalogUnavailable || response.model !== MINIMAX_MODEL || catalogWarnings.has(root.session.sessionId)) return;
        catalogWarnings.add(root.session.sessionId);
        root.session.sendSessionEvent({ type: 'message', message: 'MiniMax 原生模型目录暂不可用，当前沿用原生默认上下文及自动压缩继续工作；本次未确认百万上下文。权限和模型请求重试规则保持不变。' });
    };
    let gateway: Awaited<ReturnType<typeof startCodexGateway>> | undefined;
    let stopping = false;
    let failure: unknown;
    let shutdownPromise: Promise<void> | undefined;
    let startup: Promise<void> = Promise.resolve();
    const operations = new Set<Promise<unknown>>();
    const assertRunning = () => { if (stopping) throw new Error('Codex execution is stopping'); };
    const operation = async <T>(work: () => Promise<T>): Promise<T> => {
        assertRunning();
        const pending = work(); operations.add(pending);
        try { return await pending; } finally { operations.delete(pending); }
    };
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const ending = new Set<SharedCodexRoot>();
    const roots = new Map<string, SharedCodexRoot>();
    const switchingProviders = new Set<string>();
    let providerChanges: Promise<unknown> = Promise.resolve();
    const prepared = new Set<SharedCodexRoot>();
    const reservations = new Map<string, Reservation>();
    const connectionSources = new Map<string, SharedCodexRoot>();
    const runtime: CodexRuntimeRecord = { id, pid: process.pid, marker: getProcessStartMarker(process.pid) ?? '',
        endpoint: '', command: command.command, args: command.args, codexHome: home, hub: configuration.apiUrl, authHash: runtimeAuthHash(), sessions: {} };
    if (!runtime.marker) throw new Error('Cannot verify the runtime process generation');
    let writes = Promise.resolve();
    const persist = () => { writes = writes.catch(() => {}).then(() => saveRuntime(runtime)); return writes; };
    const control = new CodexAppServerClient({ endpoint: upstream, token: upstreamToken, cwd: launch.cwd });
    control.setServerRequestHandler(() => {});
    // An independent observer preserves settings when a root's side-client
    // reconnects: native resume responses omit collaboration mode.
    const nativeSettings = new Map<string, Record<string, unknown>>();
    control.setNotificationHandler((method, params) => {
        if (method !== 'thread/settings/updated') return;
        const threadId = string(record(params).threadId);
        if (!threadId) return;
        const settings = record(record(params).threadSettings);
        nativeSettings.set(threadId, settings);
        // Never interleave unversioned streams while the root is healthy:
        // an older control packet must not replace a newer root notification.
        const root = roots.get(threadId);
        if (root && !root.client.isInitialized()) root.acceptSettings(settings);
    });
    let reconnectingControl = false;
    const reconnectControl = () => {
        if (stopping || reconnectingControl) return;
        reconnectingControl = true;
        void (async () => {
            while (!stopping) {
                try {
                    await initializeSharedClient(control);
                    // Roots remain loaded by their independent side-clients.
                    for (const threadId of roots.keys()) await control.request('thread/resume', { threadId, excludeTurns: true });
                    return;
                } catch (error) {
                    logger.debug('[Codex shared] control reconnect', error);
                    await new Promise(resolve => setTimeout(resolve, 1_000));
                }
            }
        })().finally(() => { reconnectingControl = false; });
    };

    const shutdown = (error?: unknown): Promise<void> => {
        if (shutdownPromise) return shutdownPromise;
        stopping = true; failure = error;
        if (error) logger.debug('[Codex shared] runtime stopped', error);
        control.setTransportAbandonedHandler(null);
        for (const root of prepared) root.stopAccepting();
        shutdownPromise = (async () => {
            // Close frontend admission first, then drain binding/startup work.
            // No root may materialize after cleanup took its snapshot.
            await gateway?.close().catch(() => {});
            await startup.catch(() => {});
            while (operations.size) await Promise.allSettled([...operations]);
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    Promise.allSettled([...prepared].filter(root => !ending.has(root)).map(root => root.suspend())),
                    new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })
                ]);
            } finally { clearTimeout(timer); }
            await control.disconnect();
            if (server && server.exitCode === null && server.signalCode === null) {
                if (!await killProcessByChildProcess(server)) throw new Error('Codex engine did not stop; ownership retained for orphan recovery');
            }
            // Release ownership only after the engine is dead, BEFORE inactive
            // reaches the hub. Web may immediately resume through the Runner.
            for (const binding of Object.values(runtime.sessions)) binding.active = false;
            runtime.pendingCreations = [];
            await persist();
        })().catch(error => {
            failure ??= error;
            logger.debug('[Codex shared] shutdown', error);
        }).finally(async () => {
            await reviewRouter?.close();
            await Promise.allSettled([...prepared].map(root => root.close(ending.has(root))));
            await rm(sockets, { recursive: true, force: true }).catch(error => logger.debug('[Codex shared] socket cleanup', error));
            finish();
        });
        return shutdownPromise;
    };
    const end = async (root: SharedCodexRoot, nativeArchive = true): Promise<void> => {
        if (!roots.has(root.threadId) || ending.has(root)) return;
        ending.add(root);
        try { if (nativeArchive) await root.client.request('thread/archive', { threadId: root.threadId }); } catch (error) { ending.delete(root); throw error; }
        roots.delete(root.threadId);
        runtime.sessions[root.session.sessionId].active = false; await persist();
        // Let the RPC acknowledgement leave both gateway and hub sockets before detach.
        setTimeout(() => {
            void root.close(true).then(async () => {
                prepared.delete(root);
                await notifyRunnerSessionStarted(root.session.sessionId, { ...root.bootstrap.metadata, lifecycleState: 'archived' });
                if (roots.size === 0 && reservations.size === 0) await shutdown();
            }).catch(error => logger.debug('[Codex shared] root cleanup', error));
        }, 100);
    };
    const prepare = async (cwd: string, existingSessionId?: string, parent?: SharedCodexRoot, project?: SessionProject): Promise<SharedCodexRoot> => {
        assertRunning();
        // Seed the generated title before Shared Codex replays inherited history.
        // A historical change_title item must not replace this fork identity.
        const forkSummary = parent ? buildForkSessionSummary(parent.session.getMetadata()) : undefined;
        const shared = { flavor: 'codex', startedBy: options.startedBy ?? 'terminal', workingDirectory: cwd,
            exportSessionEnv: false, reportStarted: false, metadataOverrides: {
                ...(forkSummary ? { summary: forkSummary } : {}),
                capabilities: {
                    terminal: true,
                    concurrentClients: true,
                    ...(existingSessionId ? { conversationHistory: undefined } : {})
                },
                ...(parent ? { forkedFrom: parent.session.sessionId } : {}),
                ...(project ? { project } : {})
            }
        } as const;
        // reservedSessionId names one preallocated hub row — single-use. A second
        // create()/fork must mint a fresh row, not re-adopt (#1911 Opus Major).
        const reservedSessionId = takeReservedSessionId(options);
        const bootstrap = existingSessionId
            ? await bootstrapExistingSession({
                ...shared,
                sessionId: existingSessionId,
                preserveProjectWorkingDirectory: true,
                requireMetadataFlush: metadata => Boolean(metadata?.capabilities?.conversationHistory)
            })
            : await bootstrapSession({
                ...shared,
                reservedSessionId,
                agentState: { controlledByUser: false },
            });
        const root = new SharedCodexRoot(bootstrap, { directory: join(runtimeDirectory(), 'queues'), generation: id, endpoint: upstream, token: upstreamToken,
            settingsFor: threadId => nativeSettings.get(threadId), create, end, switchProvider, deepseekReady,
            resetReviewTransport: () => reviewRouter?.reset() });
        prepared.add(root);
        try { assertRunning(); await root.prepare(); assertRunning(); return root; }
        catch (error) { await root.close(!stopping && !existingSessionId); prepared.delete(root); throw error; }
    };
    const reserveRecord = async (root: SharedCodexRoot, threadId: string) => {
        assertRunning();
        if (roots.has(threadId) || Object.entries(runtime.sessions).some(([sid, binding]) => sid !== root.session.sessionId && binding.active && binding.threadId === threadId)) {
            throw new Error('Thread is already being attached in this runtime; retry after it is ready');
        }
        runtime.sessions[root.session.sessionId] = { threadId, namespace: root.bootstrap.sessionInfo.namespace, active: true };
        runtime.pendingCreations = runtime.pendingCreations?.filter(sid => sid !== root.session.sessionId); await persist();
    };
    const reserve = async (root: SharedCodexRoot, threadId: string) => withThreadOwnership(home, threadId, id, () => reserveRecord(root, threadId));
    // Called while holding ownership, before any native resume is sent. Local
    // reservation failure is not an uncertain native mutation. Release only
    // this prepared connection; never archive an existing conversation.
    const prepareResume = async (cwd: string, threadId: string, explicitSessionId?: string) => {
        const coldBinding = await findColdBinding(home, threadId);
        const root = await prepare(cwd, explicitSessionId ?? coldBinding);
        try { await reserveRecord(root, threadId); return root; }
        catch (error) {
            const binding = runtime.sessions[root.session.sessionId];
            if (binding?.threadId === threadId) {
                binding.active = false;
                await persist().catch(cleanupError => logger.debug('[Codex shared] failed reservation state cleanup', cleanupError));
            }
            await root.close(false).then(() => prepared.delete(root))
                .catch(cleanupError => logger.debug('[Codex shared] failed reservation connection cleanup', cleanupError));
            throw error;
        }
    };
    const bind = async (root: SharedCodexRoot, response: Record<string, unknown>, subscribe: boolean, initialOptions?: SharedLaunchOptions) => {
        assertRunning();
        const threadId = string(record(response.thread).id);
        if (!threadId) throw new Error('Codex lifecycle response has no thread ID');
        const reserved = runtime.sessions[root.session.sessionId];
        if (reserved && reserved.threadId !== threadId) throw new Error('Codex retargeted a reserved thread');
        if (!reserved) await reserve(root, threadId);
        // No fake user turn/name. Metadata write materializes an empty legacy rollout for native resume.
        await control.request('thread/metadata/update', { threadId, gitInfo: gitInfo(string(record(response.thread).cwd) ?? root.bootstrap.workingDirectory) });
        assertRunning();
        roots.set(threadId, root);
        await root.bind(threadId, response, subscribe);
        assertRunning();
        // Cold-resumed threads predate the control connection's automatic
        // new-thread subscription. Subscribe once without changing settings.
        await control.request('thread/resume', { threadId, excludeTurns: true });
        await root.activate(initialOptions);
        warnCatalog(root, response);
        await root.session.flush();
        await persist();
        // The hub's view of the metadata is what the hub kept of it: a hub
        // without the field strips hostStartMarker, and the runner ignores an
        // untracked runner-started webhook that cannot prove its process
        // generation. The marker therefore comes from the local bootstrap.
        await notifyRunnerSessionStarted(root.session.sessionId, { ...(root.session.getMetadata() ?? root.bootstrap.metadata), hostStartMarker: root.bootstrap.metadata.hostStartMarker });
    };
    const create = (method: 'thread/start' | 'thread/fork', params: Record<string, unknown>, parent?: SharedCodexRoot, project?: SessionProject, initialOptions?: SharedLaunchOptions): Promise<SharedCodexRoot> => operation(async () => {
        const root = await prepare(string(params.cwd) ?? launch.cwd, undefined, parent, project);
        let nativeSucceeded = false;
        try {
            runtime.pendingCreations = [...runtime.pendingCreations ?? [], root.session.sessionId]; await persist();
            const response = record(await root.client.request(method, root.config({ ...params, ...(method === 'thread/fork' ? { deferGoalContinuation: true } : {}) })));
            nativeSucceeded = true;
            await bind(root, response, true, initialOptions); return root;
        } catch (error) {
            // A timed-out native mutation may have succeeded. Never replay it or kill unrelated roots.
            if (!nativeSucceeded && !isIndeterminateError(error)) {
                runtime.pendingCreations = runtime.pendingCreations?.filter(sid => sid !== root.session.sessionId); await persist();
                prepared.delete(root); await root.close(true);
            }
            else root.session.sendSessionEvent({ type: 'message', message: 'Native thread creation/binding is unconfirmed. Do not retry blindly; inspect the runtime before recovery.' });
            throw error;
        }
    });
    // Durable cleanup state for the native threads a provider switch retires.
    const retirementStore = createRetirementStore(runtime.providerRetirements, records => { runtime.providerRetirements = records; });
    /**
     * Release the native resources of the thread a committed provider switch
     * left behind. The archive runs on the runtime's own native control
     * connection: never through the Hub, never through a peer session, and
     * never against the new thread, the current root or a sibling root. A
     * cleanup problem is reported honestly and never fails the switch.
     */
    const retireRetiredThread = async (root: SharedCodexRoot, retiredThreadId: string, currentThreadId: string): Promise<void> => {
        try {
            const outcome = await retireProviderThread({
                threadId: retiredThreadId,
                sessionId: root.session.sessionId,
                store: retirementStore,
                persist: () => persist(),
                archive: async threadId => { await control.request('thread/archive', { threadId }); },
                // Only the thread this very switch released may be archived.
                precondition: () => retiredThreadId !== currentThreadId
                    && root.threadId !== retiredThreadId
                    && ![...roots.values()].some(entry => entry.threadId === retiredThreadId),
                classifyFailure: error => isIndeterminateError(error) ? 'unconfirmed' : 'rejected',
                // The module already redacts failure text, so nothing raw is logged.
                log: message => logger.debug(message),
                notify: message => root.session.sendSessionEvent({ type: 'message', message })
            });
            if (outcome.status !== 'archived') logger.debug('[Codex shared] retired native thread not released',
                { threadId: retiredThreadId, status: outcome.status, detail: outcome.detail, error: outcome.error });
        } catch (error) {
            // A cleanup problem never turns a committed provider switch into a failed switch.
            logger.debug('[Codex shared] retirement raised', error);
        }
    };
    const switchProvider = (root: SharedCodexRoot, params: Record<string, unknown>, beforeFork: () => Promise<void>): Promise<Record<string, unknown>> => {
        const change = providerChanges.catch(() => {}).then(() => operation(async () => {
            const previousThreadId = root.threadId;
            switchingProviders.add(previousThreadId);
            let forkSucceeded = false;
            let creationReserved = false;
            let historySnapshot: ProviderHistorySnapshot | undefined;
            let committed: Record<string, unknown> | undefined;
            let retired: { retiredThreadId: string; currentThreadId: string } | undefined;
            try {
                assertRunning();
                if (runtime.pendingCreations?.includes(root.session.sessionId)) throw new Error('A prior native mutation is unconfirmed; inspect the runtime before switching again');
                root.assertProviderTransition();
                await gateway?.drain(previousThreadId);
                await beforeFork();
                // A failed parent must not duplicate a still-running child tool.
                // Wait for its native activity to settle while other roots keep running.
                for (;;) {
                    root.assertProviderTransition();
                    let activeChild = false; let cursor: string | undefined;
                    do {
                        const children = record(await control.request('thread/list', { ancestorThreadId: previousThreadId, cursor,
                            sourceKinds: ['subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'] }));
                        activeChild ||= (Array.isArray(children.data) ? children.data : []).some(value => record(record(value).status).type === 'active');
                        cursor = string(children.nextCursor);
                    } while (cursor && !activeChild);
                    if (!activeChild) break;
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
                const thread = await root.readThread();
                const turns = (Array.isArray(thread.turns) ? thread.turns : []).map(record);
                if (turns.some(turn => turn.status === 'inProgress')) throw new Error('Wait for this turn to finish before switching providers');
                root.assertProviderTransition();
                if (params.modelProvider !== 'hapi_minimax') {
                    const sourcePath = string(thread.path);
                    if (!sourcePath) throw new Error('Native provider history has no rollout path');
                    historySnapshot = await providerHistorySnapshot(home, previousThreadId, sourcePath, async threadId => {
                        const ancestor = record(record(await root.client.request('thread/read', { threadId, includeTurns: false })).thread);
                        const path = string(ancestor.path);
                        if (!path || ancestor.id !== threadId) throw new Error('Native provider ancestor was not confirmed');
                        return path;
                    }, { dropAllReasoning: params.modelProvider === 'hapi_deepseek' });
                    root.assertProviderTransition();
                }
                runtime.pendingCreations = [...runtime.pendingCreations ?? [], root.session.sessionId]; await persist();
                creationReserved = true;
                const response = record(await root.client.request('thread/fork', root.config({ ...params,
                    threadId: previousThreadId, ...(historySnapshot ? { path: historySnapshot.path } : {}), deferGoalContinuation: true })));
                const nextThreadId = string(record(response.thread).id);
                forkSucceeded = Boolean(nextThreadId);
                // Paginated native forks reference this sanitized prefix after
                // cold resume; it is durable history, not a disposable import.
                if (forkSucceeded) historySnapshot?.retain();
                if (!nextThreadId || response.modelProvider !== params.modelProvider || response.model !== params.model) {
                    throw new Error('Native provider fork was not confirmed');
                }
                if (historySnapshot) assertProviderHistoryPreserved(thread, await root.readThread(nextThreadId));
                await withThreadOwnership(home, nextThreadId, id, async () => {
                    runtime.retiredProviderThreads = { ...runtime.retiredProviderThreads, [previousThreadId]: root.session.sessionId };
                    runtime.sessions[root.session.sessionId].threadId = nextThreadId;
                    await persist();
                    roots.delete(previousThreadId); roots.set(nextThreadId, root);
                    nativeSettings.set(nextThreadId, { ...response, effort: response.reasoningEffort });
                    await root.bindProviderThread(response, turns.map(turn => string(turn.id)).filter((value): value is string => Boolean(value)));
                    await control.request('thread/resume', { threadId: nextThreadId });
                    await root.session.flush();
                    runtime.pendingCreations = runtime.pendingCreations?.filter(sid => sid !== root.session.sessionId); await persist();
                });
                // The fork, the rebinding, the alias and the pending commit are durable.
                // The retirement itself runs after this switch's own failure path,
                // so a cleanup problem can never make a committed switch look failed.
                retired = { retiredThreadId: previousThreadId, currentThreadId: nextThreadId };
                committed = response;
            } catch (error) {
                // Definite native rejection is safe to clear. Unknown fork outcomes
                // retain the existing ownership quarantine and are never replayed.
                if (creationReserved && !isIndeterminateError(error) && !forkSucceeded && root.threadId === previousThreadId) {
                    runtime.pendingCreations = runtime.pendingCreations?.filter(sid => sid !== root.session.sessionId); await persist();
                }
                throw error;
            } finally {
                // Unknown fork outcomes retain the snapshot for inspection.
                if (!creationReserved || forkSucceeded || !runtime.pendingCreations?.includes(root.session.sessionId)) await historySnapshot?.dispose();
                switchingProviders.delete(previousThreadId);
            }
            if (!committed) throw new Error('The provider switch did not commit');
            // Only now may the retired native thread release its resources.
            if (retired) await retireRetiredThread(root, retired.retiredThreadId, retired.currentThreadId);
            warnCatalog(root, committed);
            return committed;
        }));
        providerChanges = change; return change;
    };
    const key = (connection: string, request: Envelope) => `${connection}:${typeof request.id}:${request.id}`;
    const before = (request: Envelope, connection: string): Promise<Envelope> => operation(async () => {
        const params = record(request.params);
        if (typeof params.threadId === 'string' && switchingProviders.has(params.threadId)) {
            throw new Error('This session is switching model providers. Wait for confirmation before submitting.');
        }
        const retiredSessionId = typeof params.threadId === 'string' ? runtime.retiredProviderThreads?.[params.threadId] : undefined;
        if (retiredSessionId) {
            const current = [...roots.values()].find(root => root.session.sessionId === retiredSessionId);
            if (current && request.method === 'thread/resume') {
                return { ...request, params: current.config({ ...params, ...current.freshParams(), threadId: current.threadId }) };
            }
            if (!['thread/read', 'thread/turns/list', 'thread/items/list'].includes(request.method ?? '')) {
                throw new Error('This conversation changed model providers. Resume the HAPI session to attach its current execution thread.');
            }
        }
        if (['thread/revert', 'thread/rollback'].includes(request.method ?? '')) {
            throw new Error('In-place rewind is unavailable with concurrent HAPI clients. Use /fork or Fork at message instead.');
        }
        if (!['thread/start', 'thread/resume', 'thread/fork'].includes(request.method ?? '') || params.ephemeral === true) return request;
        if (request.id === undefined) throw new Error('Lifecycle operations require a JSON-RPC request ID');
        if (params.history || params.path) throw new Error('Use a native thread ID to resume through HAPI');
        const threadId = string(params.threadId);
        let existing = threadId ? roots.get(threadId) : undefined;
        if (threadId && !existing) {
            let candidate = threadId; const visited = new Set<string>();
            for (;;) {
                if (visited.has(candidate)) throw new Error('Invalid native thread ancestry'); visited.add(candidate);
                await withThreadOwnership(home, candidate, id, async () => {});
                const thread = record(record(await control.request('thread/read', { threadId: candidate, includeTurns: false })).thread);
                const parent = string(thread.parentThreadId);
                if (!parent) break;
                existing = roots.get(parent);
                if (existing) break;
                candidate = parent;
            }
            if (candidate !== threadId && !existing) throw new Error('Resume the parent HAPI session before attaching a child agent');
        }
        if (request.method === 'thread/resume' && existing) {
            return { ...request, params: existing.config(params) };
        }
        if (threadId) await withThreadOwnership(home, threadId, id, async () => {});
        const attached = connectionSources.get(connection);
        const source = existing ?? (request.method === 'thread/start' && attached && roots.get(attached.threadId) === attached ? attached : undefined);
        const project = request.method === 'thread/resume' ? undefined
            : inheritSessionProject(source?.session.getMetadata()?.project, source?.session.sessionId ?? '');
        const cwd = request.method === 'thread/start' && project ? project.directory
            : string(params.cwd) ?? existing?.bootstrap.workingDirectory ?? launch.cwd;
        const root = request.method === 'thread/resume' && threadId
            ? await withThreadOwnership(home, threadId, id, () => prepareResume(cwd, threadId))
            : await prepare(cwd, undefined, request.method === 'thread/fork' ? existing : undefined, project);
        try {
            if (request.method !== 'thread/resume') {
                runtime.pendingCreations = [...runtime.pendingCreations ?? [], root.session.sessionId]; await persist();
            }
            reservations.set(key(connection, request), { root, resumeId: request.method === 'thread/resume' ? threadId : undefined });
            return { ...request, params: root.config({ ...params, ...(request.method === 'thread/fork' ? { deferGoalContinuation: true } : {}),
                ...(request.method === 'thread/resume' && root.session.getMetadata()?.project ? { cwd: root.bootstrap.workingDirectory } : {}),
                ...(request.method === 'thread/start' && project ? { cwd } : {}) }) };
        } catch (error) { prepared.delete(root); await root.close(true); throw error; }
    });
    const after = (request: Envelope, response: Envelope, connection: string): Promise<void | Envelope[]> => operation(async () => {
        const reservation = reservations.get(key(connection, request)); reservations.delete(key(connection, request));
        if (reservation) {
            if (response.error) {
                const binding = runtime.sessions[reservation.root.session.sessionId]; if (binding) binding.active = false;
                runtime.pendingCreations = runtime.pendingCreations?.filter(sid => sid !== reservation.root.session.sessionId);
                await persist(); prepared.delete(reservation.root); await reservation.root.close(true); return;
            }
            await bind(reservation.root, record(response.result), true);
            connectionSources.set(connection, reservation.root);
        } else if (request.method === 'thread/archive' && !response.error) {
            const root = roots.get(string(record(request.params).threadId) ?? ''); if (root) await end(root, false);
        } else if (request.method === 'thread/queue/delete' && !response.error && record(response.result).deleted === true) {
            const root = roots.get(string(record(request.params).threadId) ?? '');
            const nativeId = string(record(request.params).queuedSubmissionId);
            if (root && nativeId) await root.nativeQueueDeleted(nativeId);
        }
        if (!response.error && ['thread/start', 'thread/resume', 'thread/fork'].includes(request.method ?? '')) {
            const threadId = string(record(record(response.result).thread).id);
            const attached = roots.get(threadId ?? '');
            if (attached) connectionSources.set(connection, attached);
            // Native 0.154 resume responses omit collaboration mode. Replay
            // the authoritative settings notification after the response so
            // a newly attached TUI doesn't reset a Web-selected Plan mode.
            return attached?.replaySettings();
        }
        return undefined;
    });
    const signal = () => { void shutdown(); };
    abortSignal?.addEventListener('abort', signal, { once: true });
    process.on('SIGTERM', signal); process.on('SIGINT', signal); process.on('SIGHUP', signal);
    startup = (async () => {
        if (abortSignal?.aborted) throw new Error('Codex startup canceled');
        assertRunning();
        if (minimaxAvailable()) reviewRouter = await startMiniMaxReviewRouter({ onReviewUnavailable: () => {
            for (const root of roots.values()) void root.reviewUnavailable().catch(error => logger.debug('[Codex shared] review fallback unconfirmed', error));
        } });
        if (reviewRouter) env.HAPI_MINIMAX_TRANSPORT_TOKEN = reviewRouter.capability;
        const providerArgs = [ ...(reviewRouter ? minimaxServerArgs(minimaxProviderConfig(reviewRouter.baseUrl)) : []),
            ...(deepseekAvailable() ? deepseekServerArgs() : []) ];
        let catalogArgs: string[] = [];
        if (reviewRouter) {
            try { catalogArgs = await prepareMiniMaxCatalog(command, launch.serverArgs, launch.cwd, env, sockets); }
            catch {
                // Optional metadata cannot take down every OpenAI/shared root.
                // Unchanged native configuration remains authoritative, and
                // router compaction compatibility supports fallback metadata.
                minimaxCatalogUnavailable = true;
                logger.debug('[Codex shared] MiniMax catalog unavailable; retaining native configuration and default context');
            }
        }
        assertRunning();
        if (deepseekAvailable()) {
            try {
                catalogArgs = await prepareDeepSeekCatalog(command, [...launch.serverArgs, ...catalogArgs], launch.cwd, env, sockets);
                deepseekReady = true;
            } catch { logger.debug('[Codex shared] DeepSeek catalog unavailable; DeepSeek selection disabled'); }
        }
        assertRunning();
        server = spawn(command.command, [...command.args, 'app-server', ...launch.serverArgs, ...providerArgs, ...catalogArgs, '--listen', upstream,
            ...(upstreamToken ? ['--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(upstreamToken).digest('hex')] : [])],
            { cwd: launch.cwd, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        server.stderr?.on('data', data => logger.debug('[Codex shared] app-server', data.toString()));
        server.once('error', error => { void shutdown(error); });
        server.once('exit', (code, sig) => { void shutdown(new Error(`app-server exited (${code}, ${sig})`)); });
        runtime.serverPid = server.pid;
        runtime.serverMarker = server.pid ? getProcessStartMarker(server.pid) ?? undefined : undefined;
        if (!runtime.serverPid || !runtime.serverMarker) throw new Error('Cannot verify app-server generation');
        await persist();
        const deadline = Date.now() + 20_000;
        for (;;) {
            try { await initializeSharedClient(control); break; }
            catch (error) { if (Date.now() > deadline || stopping) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        assertRunning();
        control.setTransportAbandonedHandler(reconnectControl);
        await checkSharedCapabilities(control);
        assertRunning();
        gateway = await startCodexGateway({ upstream, upstreamToken, path: process.platform === 'win32' ? undefined : join(sockets, 'clients.sock'), token,
            hooks: { before, after, disconnected: connection => {
                connectionSources.delete(connection);
                for (const [key, reservation] of reservations) {
                    if (!key.startsWith(`${connection}:`)) continue;
                    reservation.root.session.sendSessionEvent({ type: 'message', message: 'Native lifecycle outcome is unknown after transport loss. Do not retry blindly; inspect the shared runtime log.' });
                    logger.debug('[Codex shared] quarantined lifecycle reservation', { runtimeId: id, sessionId: reservation.root.session.sessionId });
                }
            }, control: (method, params) => operation(async () => {
                const sid = string(record(params).sessionId); const root = [...roots.values()].find(root => root.session.sessionId === sid);
                if (!root) throw new Error('Shared session not found');
                if (method === 'hapi/stopSession') { await end(root); return { stopped: true }; }
                if (method === 'hapi/attach') return { threadId: root.threadId };
                throw new Error('Unknown runtime control');
            }) } });
        if (stopping) { await gateway.close(); assertRunning(); }
        runtime.endpoint = gateway.endpoint; if (process.platform === 'win32') runtime.token = token; await persist();
        let root: SharedCodexRoot;
        if (options.resumeLast) {
            const response = record(await control.request('thread/list', { limit: 1, sortKey: 'updated_at', sortDirection: 'desc',
                ...(!options.resumeAll ? { cwd: launch.cwd } : {}) }));
            options.resumeSessionId = string(record(Array.isArray(response.data) ? response.data[0] : undefined).id);
            if (!options.resumeSessionId) throw new Error('No Codex session to resume');
        }
        if (options.resumeSessionId) {
            const threadId = options.resumeSessionId;
            const thread = record(record(await control.request('thread/read', { threadId, includeTurns: false })).thread);
            if (string(thread.parentThreadId)) {
                throw new Error('Cannot cold-resume a child agent independently. Resume its parent HAPI session instead.');
            }
            // Prove ownership before bootstrap can alter an existing HAPI
            // row's hostPid/metadata. Hold the lock until the reservation is durable.
            root = await withThreadOwnership(home, threadId, id, () => prepareResume(launch.cwd, threadId, options.existingSessionId));
            const params = root.config({ ...launch.threadParams, threadId, excludeTurns: true, ...(root.session.getMetadata()?.project ? { cwd: root.bootstrap.workingDirectory } : {}) });
            let response: Record<string, unknown>;
            try {
                response = record(await root.client.request('thread/resume', params));
            } catch (error) {
                // Reopening a HAPI binding also restores its native archive.
                // Only retry an explicit archived rejection, never a transport
                // failure whose resume outcome may be unknown.
                if (!options.existingSessionId || !(error instanceof Error)
                    || !error.message.startsWith(`session ${threadId} is archived.`)) throw error;
                await root.client.request('thread/unarchive', { threadId });
                response = record(await root.client.request('thread/resume', params));
            }
            await bind(root, response, false, options);
        } else root = await create('thread/start', { ...launch.threadParams, cwd: launch.cwd }, undefined, options.sessionProject, options);
        assertRunning();
        onReady?.({ sessionId: root.session.sessionId, runtime });
    })();
    void startup.catch(error => { if (!stopping) void shutdown(error); });
    if (abortSignal?.aborted) void shutdown();
    try {
        await done;
        if (failure) throw failure;
    } finally {
        abortSignal?.removeEventListener('abort', signal);
        process.off('SIGTERM', signal); process.off('SIGINT', signal); process.off('SIGHUP', signal);
    }
}
