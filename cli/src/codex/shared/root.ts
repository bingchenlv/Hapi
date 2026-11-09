import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hybridModelAvailable, hybridMcpConfig, hybridModelPolicy } from './hybridModel';
import { deepseekCollaborationConfig, deepseekCollaborationPolicy } from './deepseekCollaboration';
import { z } from 'zod';
import { inheritSessionProject, isMiniMaxModel, isDeepSeekModel, type SessionProject } from '@hapi/protocol';
import { deepseekAvailable, deepseekThreadConfig, DEEPSEEK_PROVIDER, validateDeepSeekEffort, withDeepSeekModels } from './deepseek';
import { withSessionProjectContext } from './project';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import type { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';
import { listSlashCommands } from '@/modules/common/slashCommands';
import { normalizeCodexModel } from '@/modules/common/codexModels';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { ImplementCodexPlanRequestSchema, type ImplementCodexPlanResult } from '@hapi/protocol/apiTypes';
import { CodexAppServerClient, isIndeterminateError } from '../codexAppServerClient';
import { buildHapiMcpBridge, type HapiMcpBridge } from '../utils/buildHapiMcpBridge';
import { extractCodexMcpServers } from '../utils/codexMcpServers';
import { buildUserInputFromMessage } from '../utils/appServerConfig';
import { resolveCodexPermissionModeConfig } from '../utils/permissionModeConfig';
import { resolveCodexSlashCommand } from '../utils/slashCommands';
import { parseReasoningEffortValue } from '../utils/reasoningEffort';
import { SharedCodexPermissions } from './permissions';
import { SharedCodexAsyncQuestions } from './asyncQuestions';
import { SharedCodexQueue } from './queue';
import { SharedCodexProjection, inputText } from './projection';
import { SHARED_USER_INPUT_CONFIG, withSharedUserInputPolicy } from './userInputPolicy';
import { record, string } from './gateway';
import { initializeSharedClient, type SharedLaunchOptions } from './launch';
import { inheritedSandbox, settingsMatch } from './settings';
import { fullAutoConfig } from './fullAutoTools';
import { planImplementationMessageId, planProposalForItem, planProposalForTurn } from './plan';
import { CodexRateLimitsTracker } from '../utils/codexRateLimits';
import { FALLBACK_CONTINUATION, fallbackMessageId, isCodexUsageExhaustion, minimaxAvailable,
    minimaxThreadConfig, MINIMAX_MODEL, MINIMAX_PROVIDER, providerForModel, validateMiniMaxEffort, withMiniMaxModel } from './minimax';

type RuntimeSettings = NonNullable<Parameters<ApiSessionClient['keepAlive']>[2]>;
export type RootHost = {
    directory: string; generation: string; endpoint: string; token?: string;
    settingsFor(threadId: string): Record<string, unknown> | undefined;
    create(method: 'thread/start' | 'thread/fork', params: Record<string, unknown>, parent?: SharedCodexRoot, project?: SessionProject): Promise<SharedCodexRoot>;
    end(root: SharedCodexRoot, nativeArchive?: boolean): Promise<void>;
    switchProvider?(root: SharedCodexRoot, params: Record<string, unknown>, beforeUnload: () => Promise<void>): Promise<Record<string, unknown>>;
    resetReviewTransport?(): void;
    deepseekReady?: boolean;
};
const SettingsSchema = z.object({
    permissionMode: z.enum(['default', 'read-only', 'autoReview', 'yolo']).optional(),
    model: z.string().min(1).optional(), modelReasoningEffort: z.string().nullable().optional(),
    collaborationMode: z.enum(['default', 'plan']).optional(),
    serviceTier: z.enum(['fast', 'standard']).nullable().optional(),
    personality: z.enum(['friendly', 'pragmatic', 'none']).optional(),
    approvalsReviewer: z.enum(['user', 'auto_review']).optional(),
    approvalPolicy: z.enum(['never', 'on-request']).optional(),
    fullAuto: z.boolean().optional()
});

/** One immutable HAPI identity + independent subscription for one root. */
export class SharedCodexRoot {
    readonly client: CodexAppServerClient;
    readonly session: ApiSessionClient;
    bridge!: HapiMcpBridge;
    threadId = '';
    private permissions!: SharedCodexPermissions;
    private asyncQuestions!: SharedCodexAsyncQuestions;
    private readonly questionDeadlines = new Map<string, number>();
    private queue!: SharedCodexQueue;
    private projection!: SharedCodexProjection;
    private readonly children = new Map<string, SharedCodexProjection>();
    private readonly ancestry = new Map<string, string | null>();
    private heartbeat?: ReturnType<typeof setInterval>;
    private work: Promise<unknown> = Promise.resolve();
    private hybridChanges: Promise<unknown> = Promise.resolve();
    private deepseekChanges: Promise<unknown> = Promise.resolve();
    private providerChanging = false;
    private readonly providerNotifications: Array<{ method: string; params: unknown; modelAtReceipt?: string }> = [];
    private readonly quotaErrors = new Set<string>();
    private readonly fallbackTurns = new Set<string>();
    private notifications = Promise.resolve();
    private currentTurn: string | undefined;
    // Ephemeral observations only: dequeue/compaction never prove acceptance.
    private readonly dequeuedInputs = new Set<string>();
    private deliveryTurn?: string;
    private compactingTurn?: string;
    private publishedCompactionIds?: string;
    private latestTurn?: { id: string; status: string; planId?: string };
    private publishedPlanId: string | null | undefined;
    private submittingPlan = false;
    private steeringActive: boolean | undefined;
    private turnRevision = 0;
    private settingsRevision = 0;
    private refreshing?: Promise<void>;
    private interrupted = false;
    private closed = false;
    private stopping = false;
    private closing?: Promise<void>;
    private readonly controls = new Set<Promise<unknown>>();
    private reconnecting = false;
    private settings: RuntimeSettings = {};
    private settingsNative: Record<string, unknown> = {};
    private settingsNotification?: Record<string, unknown>;
    private readonly settingsListeners = new Set<() => void>();
    private readonly rateLimits: CodexRateLimitsTracker;
    private lastRateLimitsRefreshAt = 0;
    private lastRateLimitsActivityAt = Date.now();
    private rateLimitsRefreshing = false;
    private reviewFallback?: Promise<void>;
    private manualReviewFallback = false;
    private reviewerChanges: Promise<void> = Promise.resolve();
    private nativeToolConfig: Record<string, unknown> = {};
    private ready!: () => void;
    private readonly bound = new Promise<void>(resolve => { this.ready = resolve; });

    constructor(readonly bootstrap: SessionBootstrapResult, private readonly host: RootHost) {
        this.session = bootstrap.session;
        this.client = new CodexAppServerClient({ endpoint: host.endpoint, token: host.token, cwd: bootstrap.workingDirectory });
        this.rateLimits = new CodexRateLimitsTracker(
            bootstrap.metadata?.codexRateLimits,
            codexRateLimits => this.session.updateMetadata(metadata => ({ ...metadata, codexRateLimits }))
        );
        this.client.setNotificationHandler((method, params) => {
            if (method === 'account/rateLimits/updated') {
                this.rateLimits.acceptNotification(params); return;
            }
            if (method === 'serverRequest/resolved') {
                this.permissions?.resolved(string(record(params).threadId) ?? '', record(params).requestId); return;
            }
            if (method === 'thread/settings/updated' && record(params).threadId === this.threadId) this.acceptSettings(record(record(params).threadSettings));
            if (record(params).threadId === this.threadId) {
                if (method === 'turn/started') {
                    this.lastRateLimitsActivityAt = Date.now();
                    this.turnRevision++; this.currentTurn = string(record(record(params).turn).id); this.interrupted = false;
                    if (this.currentTurn) this.latestTurn = { id: this.currentTurn, status: 'inProgress' };
                    this.publishSteering();
                }
                if (method === 'turn/completed' && (!this.currentTurn || record(record(params).turn).id === this.currentTurn)) {
                    this.lastRateLimitsActivityAt = Date.now();
                    this.turnRevision++; this.currentTurn = undefined; this.interrupted = record(record(params).turn).status === 'interrupted';
                    this.publishSteering();
                }
                const p = record(params);
                if (method === 'item/completed' && this.latestTurn && this.latestTurn.id === p.turnId) {
                    const planId = planProposalForItem(this.threadId, this.latestTurn.id, p.item);
                    if (planId) { this.turnRevision++; this.latestTurn.planId = planId; }
                }
                if (method === 'turn/completed') {
                    const turn = record(p.turn);
                    const id = string(turn.id);
                    if (id && (!this.latestTurn || this.latestTurn.id === id)) {
                        this.latestTurn = { id, status: string(turn.status) ?? 'unknown',
                            planId: planProposalForTurn(this.threadId, turn) ?? this.latestTurn?.planId };
                    }
                }
                this.publishPlan();
            }
            const receivedAt = Date.now();
            const modelAtReceipt = record(params).threadId === this.threadId ? this.settings.model ?? undefined : undefined;
            this.notifications = this.notifications.then(() => this.notification(method, params, modelAtReceipt, receivedAt)).catch(error => logger.debug('[Codex shared] projection', error));
        });
        this.client.setTransportAbandonedHandler(() => { void this.reconnect(); });
        this.session.onUserMessage((message, localId) => {
            this.lastRateLimitsActivityAt = Date.now();
            this.work = this.work.catch(() => {}).then(async () => {
                await this.bound;
                if (this.closed || this.stopping) return;
                const id = localId ?? randomUUID();
                const text = formatMessageWithAttachments(message.content.text, message.content.attachments);
                const resolved = text.trim().startsWith('/') ? await this.queue.command(id, () => this.command(text)) : text;
                if (resolved === null) { this.session.emitMessagesConsumed([id], { clearQueuedThinkingGrace: true }); return; }
                await this.queue.enqueue(id, buildUserInputFromMessage(resolved), this.interrupted);
            }).catch(error => this.notice(`Message not confirmed: ${error instanceof Error ? error.message : error}. Inspect the queue before retrying.`));
        });
        this.session.onCancelQueuedMessage(async id => { await this.bound; return this.stopping ? 'indeterminate' : this.queue.cancel(id); });
        // Absence from history is NOT proof an uncertain mutation failed.
        this.session.onRetryQueuedMessage(async id => {
            await this.bound;
            if (this.stopping) return false;
            await this.refresh();
            return ['rejected', 'canceled', 'released'].includes(this.queue.state(id) ?? '');
        });
        this.session.onReconnect(() => {
            if (!this.threadId || this.closed || this.stopping) return;
            const wasActivated = Boolean(this.heartbeat);
            // An emitted socket packet is not a durable hub acknowledgement.
            // Replay final native history with stable IDs after every reconnect.
            this.projection?.reset();
            this.steeringActive = undefined;
            this.publishedPlanId = undefined;
            this.publishedCompactionIds = undefined;
            void this.refresh().then(() => this.refreshChildren(false)).then(() => this.queue.replay())
                .then(() => {
                    // Hub restart loses its ephemeral readiness fence. Replay
                    // it only after native revalidation and completed activation.
                    if (wasActivated && this.heartbeat && !this.closed && !this.stopping && this.client.isInitialized()) this.session.emitSessionReady();
                })
                .catch(error => logger.debug('[Codex shared] hub resync', error));
        });
    }

    async prepare(): Promise<void> {
        if (hybridModelAvailable()) {
            try { await this.hybridPolicy(); }
            catch (error) {
                // The optional helper must not prevent an OpenAI session starting.
                this.session.updateMetadata(metadata => ({ ...metadata, hybridModel: undefined }));
                logger.debug('[Codex shared] hybrid policy unavailable', error);
            }
        }
        if (deepseekCollaborationConfig(this.session.sessionId)) {
            try { await this.deepseekPolicy(); }
            catch (error) {
                this.session.updateMetadata(metadata => ({ ...metadata, deepseekCollaboration: undefined }));
                logger.debug('[Codex shared] DeepSeek collaboration policy unavailable', error);
            }
        } else {
            this.session.updateMetadata(metadata => ({ ...metadata, deepseekCollaboration: undefined }));
        }
        // Descendants share this bridge. The projection applies successful
        // root title calls so a child cannot rename the parent session.
        this.bridge = await buildHapiMcpBridge(this.session, { exportSessionEnv: false, emitTitleSummary: false,
            skillLookup: { workingDirectory: this.bootstrap.workingDirectory, flavor: 'codex' } });
        await initializeSharedClient(this.client);
        // Config stays in process memory; never log/persist its transport
        // credentials. Complete MCP tables are needed because native thread
        // overrides replace a server, rather than merging its individual fields.
        try {
            const response = await this.client.readConfig({ cwd: this.bootstrap.workingDirectory });
            this.nativeToolConfig = { mcp_servers: extractCodexMcpServers(response.config),
                apps: record(response.config.apps), plugins: record(response.config.plugins) };
        } catch (error) { logger.debug('[Codex shared] optional tool approval config unavailable', error); }
        void this.refreshRateLimits();
        this.asyncQuestions = new SharedCodexAsyncQuestions(this.session, (threadId, text, id) => this.submitQuestionAnswer(threadId, text, id));
        this.preparePermissions(this.host.generation);
        this.client.setServerRequestHandler(request => { void this.receiveRequest(request); });
    }
    private preparePermissions(generation: string): void {
        this.permissions = new SharedCodexPermissions(this.session, this.client, generation, reply => this.asyncQuestions.answer(reply), this.questionDeadlines,
            () => this.noApprovalPrompts(), () => this.fullAuto());
    }
    private async refreshRateLimits(): Promise<void> {
        if (this.closed || this.stopping || this.rateLimitsRefreshing || !this.client.isInitialized()) return;
        this.rateLimitsRefreshing = true;
        this.lastRateLimitsRefreshAt = Date.now();
        try {
            await this.rateLimits.refresh(() => this.client.readRateLimits());
        } catch (error) {
            logger.debug('[Codex shared] rate limits unavailable', error);
        } finally {
            this.rateLimitsRefreshing = false;
        }
    }
    private async submitQuestionAnswer(threadId: string, text: string, clientUserMessageId: string): Promise<void> {
        if (this.closed || this.stopping) throw new Error('Codex execution is stopping');
        const operation = (async () => {
            const thread = threadId === this.threadId ? undefined : await this.readThread(threadId);
            const turnId = threadId === this.threadId ? this.currentTurn
                : string((Array.isArray(thread?.turns) ? thread.turns.map(record) : []).find(turn => turn.status === 'inProgress')?.id);
            const params = { threadId, clientUserMessageId, input: buildUserInputFromMessage(text) };
            await this.client.request(turnId ? 'turn/steer' : 'turn/start', { ...params, ...(turnId ? { expectedTurnId: turnId } : {}) });
        })();
        this.controls.add(operation);
        try { await operation; } finally { this.controls.delete(operation); }
    }
    private async projectHistory(projection: SharedCodexProjection, thread: unknown): Promise<void> {
        this.asyncQuestions.history(projection.threadId, thread);
        await projection.history(thread);
    }
    private async receiveRequest(request: { id: string | number; method: string; params: unknown }): Promise<void> {
        await this.bound;
        if (this.closed || this.stopping) return;
        const threadId = string(record(request.params).threadId);
        // App-server automatically subscribes every initialized connection to
        // newly created threads, including siblings. Never answer their calls.
        if (threadId && await this.ownsThread(threadId)) this.permissions.receive(request);
    }
    private async ownsThread(threadId: string): Promise<boolean> {
        const visited = new Set<string>();
        let candidate: string | null = threadId;
        while (candidate && !visited.has(candidate)) {
            if (candidate === this.threadId) return true;
            visited.add(candidate);
            if (!this.ancestry.has(candidate)) {
                try {
                    const thread = record(record(await this.client.request('thread/read', { threadId: candidate, includeTurns: false })).thread);
                    this.ancestry.set(candidate, string(thread.parentThreadId) ?? null);
                } catch { return false; }
            }
            candidate = this.ancestry.get(candidate) ?? null;
        }
        return false;
    }
    config(params: Record<string, unknown>): Record<string, unknown> {
        const route = this.session.getMetadata()?.modelRouting;
        if (route?.provider === 'minimax' && route.status === 'active') {
            params = { ...params, model: MINIMAX_MODEL, modelProvider: MINIMAX_PROVIDER };
        }
        if (route?.provider === 'deepseek' && route.status === 'active') {
            const model = route.model ?? string(params.model);
            params = { ...params, model, modelProvider: DEEPSEEK_PROVIDER,
                config: { ...record(params.config), model_reasoning_effort: validateDeepSeekEffort(
                    model ? this.session.getMetadata()?.modelReasoningEfforts?.[model] : undefined) } };
        }
        if (isDeepSeekModel(string(params.model))) params = { ...params, modelProvider: DEEPSEEK_PROVIDER };
        if ((isDeepSeekModel(string(params.model)) || params.modelProvider === DEEPSEEK_PROVIDER)
            && (!deepseekAvailable() || this.host.deepseekReady === false)) throw new Error('DeepSeek is not configured in this runtime');
        if ((isMiniMaxModel(string(params.model)) || params.modelProvider === MINIMAX_PROVIDER) && !minimaxAvailable()) {
            throw new Error('MiniMax is not configured on this machine');
        }
        const requestedReviewer = params.approvalsReviewer;
        const reviewer = this.session.getMetadata()?.minimaxApprovalReviewer
            ?? (requestedReviewer === 'user' || requestedReviewer === 'auto_review' ? requestedReviewer : 'auto_review');
        const approvalPolicy = this.session.getMetadata()?.codexApprovalPolicy;
        const fullAuto = this.session.getMetadata()?.codexFullAuto;
        const deepseekHelperConfig = deepseekCollaborationConfig(this.session.sessionId);
        const configured = deepseekThreadConfig(minimaxThreadConfig({ ...params, ...(approvalPolicy ? { approvalPolicy } : {}),
            ...(fullAuto ? { sandbox: 'danger-full-access', approvalPolicy: 'never' } : {}), cwd: params.cwd ?? this.bootstrap.workingDirectory,
            developerInstructions: withSharedUserInputPolicy(withSessionProjectContext(string(params.developerInstructions), this.session.getMetadata()?.project)), config: {
            ...record(params.config), ...SHARED_USER_INPUT_CONFIG, 'mcp_servers.hapi': this.bridge.mcpServers.hapi,
            'shell_environment_policy.set.HAPI_SESSION_ID': this.session.sessionId,
            'shell_environment_policy.set.HAPI_MINIMAX_TRANSPORT_TOKEN': '',
            ...(hybridModelAvailable() ? { 'mcp_servers.minimax_helper': hybridMcpConfig(this.session.sessionId) } : {}),
            ...(deepseekHelperConfig ? { 'mcp_servers.deepseek': deepseekHelperConfig } : {})
        } }, reviewer, approvalPolicy ?? 'never', fullAuto ?? (approvalPolicy !== 'on-request' && params.sandbox !== 'read-only')));
        if (isMiniMaxModel(string(configured.model)) || isDeepSeekModel(string(configured.model))) {
            const config = record(configured.config);
            const disabled: Record<string, unknown> = {};
            for (const name of ['deepseek', 'minimax_helper']) {
                // Native validates transports even for disabled servers. Keep a
                // complete configured transport; never create an empty server.
                const server = record(config[`mcp_servers.${name}`]
                    ?? record(config.mcp_servers)[name] ?? record(this.nativeToolConfig.mcp_servers)[name]);
                if (typeof server.command === 'string' || typeof server.url === 'string') {
                    disabled[`mcp_servers.${name}`] = { ...server, enabled: false };
                }
            }
            configured.config = { ...config, ...disabled };
        }
        if (fullAuto || configured.sandbox === 'danger-full-access' && configured.approvalPolicy === 'never') {
            configured.config = fullAutoConfig(record(configured.config), this.nativeToolConfig);
        }
        return configured;
    }
    async bind(threadId: string, response: Record<string, unknown>, subscribe: boolean, providerTransition = false): Promise<void> {
        if (this.threadId && this.threadId !== threadId && !providerTransition) throw new Error('Cannot retarget a shared HAPI session');
        this.threadId = threadId;
        // A provider fork can announce itself before the fork RPC returns.
        // Once bound, it must never retain a child projection of this root.
        this.children.delete(threadId);
        this.queue = new SharedCodexQueue(this.client, threadId, join(this.host.directory, `${this.session.sessionId}.queue.json`),
            (ids, steered) => {
                this.session.emitMessagesConsumed(ids, { steered });
                for (const id of ids) this.dequeuedInputs.delete(id);
                this.publishCompaction();
            }, ids => this.session.emitSteerIndeterminate(ids),
            (id, input) => { if (!id.startsWith('hapi:minimax-fallback:')) this.session.syncNativeQueuedMessage(id, input === null ? null : inputText(input)); },
            ids => this.session.setSteerDeliveryState(ids, 'queued'));
        await this.queue.load();
        this.projection = new SharedCodexProjection(this.session, threadId, id => this.queue.committed(id), undefined,
            async () => record(await this.client.request('thread/read', { threadId, includeTurns: false })).thread,
            (threadId, item) => this.asyncQuestions.observeItem(threadId, item));
        this.session.updateMetadata(metadata => ({ ...metadata, codexSessionId: threadId, capabilities: {
            ...metadata.capabilities, concurrentClients: true, terminal: true,
            minimaxStandalone: minimaxAvailable() && Boolean(this.host.switchProvider),
            deepseekStandalone: deepseekAvailable() && this.host.deepseekReady !== false && Boolean(this.host.switchProvider),
            deepseekCollaboration: deepseekAvailable() && Boolean(deepseekCollaborationConfig(this.session.sessionId)),
            // In-place rewind needs a native + hub commit barrier. Do not
            // advertise a destructive operation we cannot make atomic yet.
            conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: false }
        } }));
        this.session.updateAgentState(state => ({ ...state, controlledByUser: false, startingMode: undefined, codexPlanProposalId: null, codexCompactionPendingMessageIds: [], requests: {},
            completedRequests: { ...state.completedRequests, ...Object.fromEntries(Object.entries(state.requests ?? {}).map(([id, request]) =>
                [id, { ...request, completedAt: Date.now(), status: 'canceled' as const }])) }
        }));
        // 空会话的首次订阅保留完整响应，以兼容原生历史源文件的初始化。
        if (subscribe) response = record(await this.client.request('thread/resume', { threadId }));
        this.acceptSettings(response); this.acceptSettings(this.host.settingsFor(threadId) ?? {});
        if (isMiniMaxModel(this.settings.model) && !this.noApprovalPrompts() && this.settingsNative.approvalsReviewer === 'auto_review') {
            this.notice('本会话已启用 OpenAI 自动审阅：需审批的操作先由 OpenAI 评估，服务不可用时转人工。可发送 /reviewer status 查看状态。');
        }
        await this.projectHistory(this.projection, response.thread);
        await this.refresh(); await this.refreshChildren(true);
    }
    assertProviderTransition(): void {
        if (!this.providerChanging || this.currentTurn || this.closed || this.stopping || this.reconnecting || !this.client.isInitialized()) {
            throw new Error('Provider switch is no longer safe; reconnect before retrying');
        }
    }
    async bindProviderThread(response: Record<string, unknown>, inheritedTurnIds: string[]): Promise<void> {
        this.assertProviderTransition();
        const threadId = string(record(response.thread).id);
        if (!threadId || threadId === this.threadId) throw new Error('Native provider fork has no distinct thread ID');
        const previous = this.threadId;
        await this.queue.flush();
        this.permissions.close(); this.preparePermissions(`${this.host.generation}:${randomUUID()}`);
        this.session.updateMetadata(metadata => ({ ...metadata, codexProviderHistory: {
            previousThreadIds: [...metadata.codexProviderHistory?.previousThreadIds ?? [], previous],
            inheritedTurnIds: [...new Set([...metadata.codexProviderHistory?.inheritedTurnIds ?? [], ...inheritedTurnIds])],
            turnOrigins: { ...metadata.codexProviderHistory?.turnOrigins,
                ...Object.fromEntries(inheritedTurnIds.map(id => [id, metadata.codexProviderHistory?.turnOrigins?.[id] ?? previous])) }
        } }));
        // Active sessions publish metadata asynchronously. The new projection
        // reads turnOrigins immediately, including buffered fork notifications;
        // do not let it emit inherited events under the new thread identity
        // before the Hub has acknowledged the origin mapping.
        // A drained lock only proves the write attempt finished. The Hub may
        // answer with a value this client cannot parse, which the versioned
        // ack logs and skips without failing. Only a mapping that is actually
        // in the local metadata proves the origin was accepted.
        const confirmed = await this.session.flushMetadata();
        const origins = this.session.getMetadata()?.codexProviderHistory?.turnOrigins ?? {};
        if (!confirmed || inheritedTurnIds.some(id => typeof origins[id] !== 'string' || !origins[id])) {
            throw new Error('Provider history mapping was not confirmed; switch is quarantined');
        }
        await this.bind(threadId, response, false, true);
    }
    async activate(options: SharedLaunchOptions = {}): Promise<void> {
        // Restored input cannot run before the cold-resume settings are applied.
        await this.initialSettings(options);
        const route = this.session.getMetadata()?.modelRouting;
        // Recover the safe gap between recording a confirmed fork and enqueueing
        // its one continuation. A ledger entry of any state forbids replay.
        if (route?.reason === 'usage-limit' && route.status === 'active' && route.failedTurnId
            && this.settingsNative.modelProvider === MINIMAX_PROVIDER && !this.queue.owns(fallbackMessageId(route.failedTurnId))) {
            try {
                if ((await this.hybridPolicy()).mode === 'hybrid') {
                    await this.queue.enqueue(fallbackMessageId(route.failedTurnId), buildUserInputFromMessage(FALLBACK_CONTINUATION), true);
                }
            } catch (error) {
                this.notice('自动续接未确认，请检查协作开关和消息队列后手动继续。');
                logger.debug('[Codex shared] takeover recovery not confirmed', error);
            }
        }
        if (this.stopping) throw new Error('Codex execution is stopping');
        this.registerControls(); this.ready();
        this.heartbeat = setInterval(() => this.alive(), 2_000); this.alive(); this.session.emitSessionReady();
    }
    private publishSteering(): void {
        this.publishCompaction();
        const active = Boolean(this.currentTurn) && !this.stopping && !this.closed && !this.reconnecting && this.client.isInitialized();
        if (this.steeringActive === active) return;
        this.steeringActive = active;
        this.session.updateAgentState(state => ({ ...state, steeringActive: active }));
    }
    private publishCompaction(): void {
        const active = this.compactingTurn && this.compactingTurn === this.currentTurn
            && !this.closed && !this.stopping && !this.reconnecting && this.client.isInitialized();
        const ids = active ? [...this.dequeuedInputs].filter(id => this.queue?.state(id) === 'unknown').sort() : [];
        const key = JSON.stringify(ids);
        if (key === this.publishedCompactionIds) return;
        this.publishedCompactionIds = key;
        this.session.updateAgentState(state => ({ ...state, codexCompactionPendingMessageIds: ids }));
    }
    private alive(): void {
        this.publishSteering();
        this.publishPlan();
        if (!this.closed) {
            this.session.keepAlive(Boolean(this.currentTurn), undefined, this.settings);
            const now = Date.now();
            if ((this.currentTurn || now - this.lastRateLimitsActivityAt < 60 * 60_000)
                && now - this.lastRateLimitsRefreshAt >= 60_000) void this.refreshRateLimits();
        }
    }
    private availablePlanId(): string | null {
        if (this.currentTurn || this.latestTurn?.status !== 'completed' || this.settings.collaborationMode !== 'plan'
            || this.stopping || this.closed || this.reconnecting || this.submittingPlan || !this.client.isInitialized()) return null;
        const id = this.latestTurn.planId;
        // An uncertain/accepted submission must never become a fresh Execute button after reconnect.
        return id && !this.queue?.owns(planImplementationMessageId(id)) ? id : null;
    }
    private publishPlan(): void {
        const id = this.availablePlanId();
        if (id === this.publishedPlanId) return;
        this.publishedPlanId = id;
        this.session.updateAgentState(state => ({ ...state, codexPlanProposalId: id }));
    }
    acceptSettings(value: Record<string, unknown>): void {
        if (typeof value.model !== 'string') return;
        this.settingsRevision++;
        if ('collaborationMode' in value && 'sandboxPolicy' in value) this.settingsNotification = value;
        this.settingsNative = { ...this.settingsNative, ...value };
        if (isDeepSeekModel(value.model as string) && this.session.getMetadata()?.modelRouting?.provider === 'deepseek') {
            this.session.updateMetadata(metadata => ({ ...metadata,
                modelRouting: metadata.modelRouting ? { ...metadata.modelRouting, model: value.model as string } : undefined }));
        }
        if (record(value.sandboxPolicy ?? value.sandbox).type === 'dangerFullAccess' && value.approvalPolicy === 'never'
            && this.session.getMetadata()?.codexFullAuto === undefined) {
            this.session.updateMetadata(metadata => ({ ...metadata, codexFullAuto: true, codexApprovalPolicy: 'never' }));
        }
        if (isMiniMaxModel(value.model as string) && ['user', 'auto_review'].includes(String(value.approvalsReviewer))) {
            this.session.updateMetadata(metadata => ({ ...metadata,
                minimaxApprovalReviewer: this.manualReviewFallback ? 'user' : value.approvalsReviewer as 'user' | 'auto_review' }));
        }
        const sandbox = record(value.sandboxPolicy ?? value.sandbox).type;
        this.settings = { ...this.settings, model: value.model,
            modelReasoningEffort: string(value.effort ?? value.reasoningEffort) ?? null,
            ...(sandbox ? { permissionMode: sandbox === 'dangerFullAccess' ? 'yolo' : sandbox === 'readOnly' ? 'read-only'
                : this.settingsNative.approvalsReviewer === 'auto_review' ? 'autoReview' : 'default' } : {}),
            ...('serviceTier' in value ? { serviceTier: value.serviceTier === 'priority' ? 'fast' : 'standard' } : {}),
            ...('collaborationMode' in value ? { collaborationMode: record(value.collaborationMode).mode === 'plan' ? 'plan' as const : 'default' as const } : {})
        };
        const effort = this.settings.modelReasoningEffort;
        if (typeof effort === 'string') this.session.updateMetadata(metadata => ({ ...metadata,
            modelReasoningEfforts: { ...metadata.modelReasoningEfforts, [value.model as string]: effort } }));
        for (const listener of this.settingsListeners) listener();
        this.publishPlan();
    }
    private async notification(method: string, params: unknown, modelAtReceipt?: string, receivedAt = Date.now()): Promise<void> {
        if (!this.threadId || this.closed) return;
        const p = record(params);
        if (method === 'thread/started') {
            const thread = record(p.thread); const id = string(thread.id);
            if (id) this.ancestry.set(id, string(thread.parentThreadId) ?? null);
        }
        const eventThread = string(p.threadId) ?? string(record(p.thread).id);
        if (this.providerChanging && eventThread && eventThread !== this.threadId) {
            this.providerNotifications.push({ method, params, modelAtReceipt });
            return;
        }
        if (eventThread && (eventThread === this.threadId || await this.ownsThread(eventThread))
            && method === 'guardianWarning' && /^Automatic approval review (failed|timed out)/i.test(String(p.message))) {
            // Native parsing/context failures also require manual recovery, even
            // when the HTTP stream itself completed successfully.
            void this.reviewUnavailable().catch(error => logger.debug('[Codex shared] manual review fallback', error));
        }
        if (eventThread && eventThread !== this.threadId) {
            if (!await this.ownsThread(eventThread)) return;
            // Ownership lookup is asynchronous; binding may change while it waits.
            if (eventThread === this.threadId) return this.notification(method, params, modelAtReceipt, receivedAt);
            let projection = this.children.get(eventThread);
            if (!projection) {
                projection = new SharedCodexProjection(this.session, eventThread, async () => {}, this.threadId,
                    async () => record(await this.client.request('thread/read', { threadId: eventThread, includeTurns: false })).thread,
                    (threadId, item) => this.asyncQuestions.observeItem(threadId, item));
                this.children.set(eventThread, projection);
            }
            await projection.notification(method, params); return;
        }
        if (method === 'turn/completed') this.session.sendSessionEvent({ type: 'ready' });
        if (method === 'thread/name/updated' && (typeof p.threadName === 'string' || p.threadName === null)) {
            const name = p.threadName ?? undefined; this.session.updateMetadata(metadata => ({ ...metadata, name }));
        }
        if (method === 'thread/archived') { await this.host.end(this, false); return; }
        // Process these in notification order: queue removal can precede turn/started.
        // Older unknown input must not acquire a later turn's compaction status.
        if (method === 'turn/started') {
            const id = string(record(p.turn).id);
            if (this.deliveryTurn && this.deliveryTurn !== id) this.dequeuedInputs.clear();
            this.deliveryTurn = id;
            this.compactingTurn = undefined;
        }
        if (method === 'turn/completed' && record(p.turn).id === this.deliveryTurn) {
            this.dequeuedInputs.clear(); this.deliveryTurn = undefined; this.compactingTurn = undefined;
        }
        if (p.turnId === this.currentTurn && record(p.item).type === 'contextCompaction') {
            if (method === 'item/started') this.compactingTurn = string(p.turnId);
            if (method === 'item/completed') { this.compactingTurn = undefined; this.dequeuedInputs.clear(); }
        }
        if (method === 'thread/queue/changed') {
            for (const id of await this.queue.reconcile()) this.dequeuedInputs.add(id);
        }
        await this.projection.notification(method, params, modelAtReceipt, receivedAt); this.publishCompaction(); this.alive();
        if (eventThread === this.threadId && method === 'error' && p.willRetry === false
            && typeof p.turnId === 'string' && isCodexUsageExhaustion(p.error)) {
            this.quotaErrors.add(p.turnId);
            if (this.latestTurn?.id === p.turnId && this.latestTurn.status === 'failed' && !this.currentTurn) {
                this.scheduleQuotaFallback(p.turnId);
            }
        }
        if (eventThread === this.threadId && method === 'turn/completed') {
            const turn = record(p.turn); const id = string(turn.id);
            if (id && turn.status === 'completed' && this.session.getMetadata()?.codexProviderHistory) {
                // Legacy native history can regenerate assistant item IDs on
                // cold resume. Checkpoint this fully projected turn only after
                // its outbound messages are durable, so history hydration can
                // skip it without losing an uncommitted or partial response.
                const origin = this.threadId;
                if (await this.session.flush() !== false) {
                    this.session.updateMetadata(metadata => {
                        const history = metadata.codexProviderHistory;
                        return history ? { ...metadata, codexProviderHistory: { ...history,
                            inheritedTurnIds: [...new Set([...history.inheritedTurnIds, id])],
                            turnOrigins: { ...history.turnOrigins, [id]: history.turnOrigins?.[id] ?? origin }
                        } } : metadata;
                    });
                    await this.session.flush();
                }
            }
            if (id && turn.status === 'failed' && (isCodexUsageExhaustion(turn.error) || this.quotaErrors.has(id))) {
                this.scheduleQuotaFallback(id);
            }
        }
    }
    private scheduleQuotaFallback(turnId: string): void {
        if (this.fallbackTurns.has(turnId) || this.settingsNative.modelProvider !== 'openai'
            || !minimaxAvailable() || !this.host.switchProvider) return;
        this.fallbackTurns.add(turnId);
        this.work = this.work.catch(() => {}).then(async () => {
            if (this.closed || this.stopping || this.currentTurn || this.settingsNative.modelProvider !== 'openai') return;
            if (this.session.getMetadata()?.modelRouting?.failedTurnId === turnId || this.queue.owns(fallbackMessageId(turnId))) return;
            try {
                // The persisted per-session policy is authoritative; stale UI metadata is not consent.
                if ((await this.hybridPolicy()).mode !== 'hybrid') return;
                await this.switchModelProvider(MINIMAX_MODEL, 'usage-limit', turnId);
                await this.queue.enqueue(fallbackMessageId(turnId), buildUserInputFromMessage(FALLBACK_CONTINUATION), true);
                await this.queue.resumeReleased();
                this.notice('Codex 用量额度已耗尽，已自动切换 MiniMax，正在继续当前任务。');
            } catch (error) {
                this.session.updateMetadata(metadata => ({ ...metadata, modelRouting: { provider: 'minimax', reason: 'usage-limit',
                    status: 'failed', failedTurnId: turnId, updatedAt: Date.now() } }));
                this.notice('Codex 用量额度已耗尽，但 MiniMax 接管未完成。请检查模型状态与消息队列后再继续。');
                logger.debug('[Codex shared] MiniMax takeover not confirmed', error);
            }
        });
    }

    private async switchModelProvider(model: string, reason: 'manual' | 'usage-limit', failedTurnId?: string, requestedEffort?: string): Promise<void> {
        if (!this.host.switchProvider) throw new Error('Resume this session with the updated runtime to switch providers');
        if (this.currentTurn || this.providerChanging) throw new Error('Wait for this turn to finish before switching providers');
        const provider = providerForModel(model);
        if (provider === MINIMAX_PROVIDER && !minimaxAvailable()) throw new Error('MiniMax is not configured on this machine');
        if (provider === DEEPSEEK_PROVIDER && (!deepseekAvailable() || this.host.deepseekReady === false)) throw new Error('DeepSeek is not configured in this runtime');
        const previousModel = this.settings.model ?? undefined;
        const collaborationMode = this.settings.collaborationMode;
        const previousReviewer = this.settingsNative.approvalsReviewer;
        const openaiApprovalsReviewer = this.settingsNative.modelProvider === 'openai'
            ? previousReviewer === 'user' ? 'user' as const : previousReviewer === 'auto_review' ? 'auto_review' as const : undefined
            : this.session.getMetadata()?.modelRouting?.openaiApprovalsReviewer;
        const route = { provider: provider === MINIMAX_PROVIDER ? 'minimax' as const : provider === DEEPSEEK_PROVIDER ? 'deepseek' as const : 'openai' as const,
            model,
            reason, previousModel, failedTurnId, openaiApprovalsReviewer, updatedAt: Date.now() };
        this.providerChanging = true; this.publishSteering();
        this.session.updateMetadata(metadata => ({ ...metadata, modelRouting: { ...route, status: 'switching' } }));
        try {
            await this.notifications;
            await this.session.flush();
            const savedEffort = requestedEffort ?? this.session.getMetadata()?.modelReasoningEfforts?.[model];
            const targetEffort = provider === MINIMAX_PROVIDER ? validateMiniMaxEffort(savedEffort)
                : provider === DEEPSEEK_PROVIDER ? validateDeepSeekEffort(savedEffort) : savedEffort ?? 'high';
            const params = { ...this.freshParams(), model, modelProvider: provider, serviceTier: null,
                approvalsReviewer: provider === MINIMAX_PROVIDER ? this.session.getMetadata()?.minimaxApprovalReviewer ?? 'auto_review' : openaiApprovalsReviewer ?? 'user',
                config: { ...record(this.freshParams().config), model_reasoning_effort: targetEffort } };
            const response = await this.host.switchProvider(this, params, () => this.queue.suspend());
            this.acceptSettings(response);
            if (collaborationMode) await this.applySettings({ collaborationMode });
            this.session.updateMetadata(metadata => ({ ...metadata, modelRouting: { ...route, status: 'active', updatedAt: Date.now() } }));
        } catch (error) {
            this.session.updateMetadata(metadata => ({ ...metadata, modelRouting: { ...route, status: 'failed', updatedAt: Date.now() } }));
            throw error;
        } finally {
            this.providerChanging = false; this.alive();
            const pending = this.providerNotifications.splice(0);
            this.notifications = this.notifications.then(async () => {
                for (const event of pending) await this.notification(event.method, event.params, event.modelAtReceipt);
            }).catch(error => logger.debug('[Codex shared] provider notification replay', error));
            await this.notifications;
            if (reason === 'manual') await this.queue.resumeReleased();
        }
    }
    private lazyHistory(): boolean {
        return !!this.threadId && (process.env.HAPI_CODEX_LAZY_HISTORY_IDS ?? '')
            .split(',').map(id => id.trim()).includes(this.threadId);
    }
    async readThread(threadId = this.threadId, fullHistory = false): Promise<Record<string, unknown>> {
        let thread = record(record(await this.client.request('thread/read', { threadId, includeTurns: false })).thread);
        if (thread.historyMode === 'paginated') {
            // 显式选择快速恢复时只回放最近一轮，原生上下文仍由 Codex 自己恢复。
            if (this.lazyHistory() && !fullHistory && threadId === this.threadId) {
                const page = record(await this.client.request('thread/turns/list', {
                    threadId, sortDirection: 'desc', itemsView: 'full', limit: 1
                }));
                if (!Array.isArray(page.data)) throw new Error('Invalid Codex history');
                thread.turns = [...page.data].reverse();
                return thread;
            }
            const turns: unknown[] = []; let cursor: string | undefined;
            do {
                const page = record(await this.client.request('thread/turns/list', { threadId, cursor, sortDirection: 'asc', itemsView: 'full' }));
                if (!Array.isArray(page.data)) throw new Error('Invalid Codex history');
                turns.push(...page.data); cursor = string(page.nextCursor);
            } while (cursor);
            thread.turns = turns;
        } else thread = record(record(await this.client.request('thread/read', { threadId, includeTurns: true })).thread);
        return thread;
    }
    refresh(): Promise<void> {
        return this.refreshing ??= this.refreshNow().finally(() => { this.refreshing = undefined; });
    }
    private async refreshNow(): Promise<void> {
        if (!this.threadId || this.closed || !this.client.isInitialized()) return;
        const revision = this.turnRevision;
        const thread = await this.readThread();
        const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : [];
        if (revision === this.turnRevision) {
            this.currentTurn = string(turns.find(turn => turn.status === 'inProgress')?.id);
            this.interrupted = turns.at(-1)?.status === 'interrupted';
            const last = turns.at(-1);
            const id = string(last?.id);
            this.latestTurn = id && last ? { id, status: string(last.status) ?? 'unknown', planId: planProposalForTurn(this.historyThreadId(id), last) } : undefined;
        }
        await this.projectHistory(this.projection, thread); await this.queue.reconcile(); this.alive();
    }
    private async refreshChildren(subscribe: boolean): Promise<void> {
        // 历史回放可省略，子代理发现与实时订阅仍需在重连后恢复。
        const replayHistory = !this.lazyHistory();
        let cursor: string | undefined;
        do {
            const page = record(await this.client.request('thread/list', { ancestorThreadId: this.threadId, cursor,
                sourceKinds: ['subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'] }));
            for (const value of Array.isArray(page.data) ? page.data : []) {
                const thread = record(value); const id = string(thread.id);
                if (id && id !== this.threadId) this.ancestry.set(id, string(thread.parentThreadId) ?? null);
                if (id && id !== this.threadId && await this.ownsThread(id) && !this.children.has(id)) {
                    this.children.set(id, new SharedCodexProjection(this.session, id, async () => {}, this.threadId, undefined,
                        (threadId, item) => this.asyncQuestions.observeItem(threadId, item)));
                }
            }
            cursor = string(page.nextCursor);
        } while (cursor);
        const loaded = new Set<string>(); cursor = undefined;
        if (subscribe && this.children.size) do {
            const page = record(await this.client.request('thread/loaded/list', { cursor }));
            for (const id of Array.isArray(page.data) ? page.data : []) if (typeof id === 'string') loaded.add(id);
            cursor = string(page.nextCursor);
        } while (cursor);
        for (const [id, projection] of this.children) {
            // Replaying a completed/unloaded child must not start its engine.
            try {
                if (subscribe && loaded.has(id)) await this.client.request('thread/resume', { threadId: id, excludeTurns: true });
                if (replayHistory) {
                    projection.reset(); await this.projectHistory(projection, await this.readThread(id));
                }
            } catch (error) { logger.debug('[Codex shared] child history unavailable', { id, error }); }
        }
    }
    nativeQueueDeleted(nativeId: string): Promise<void> { return this.queue.deleted(nativeId); }
    replaySettings(): Array<{ method: string; params: unknown }> {
        return this.settingsNotification ? [{ method: 'thread/settings/updated', params: {
            threadId: this.threadId, threadSettings: this.settingsNotification
        } }] : [];
    }
    private async reconnect(): Promise<void> {
        if (this.closed || this.stopping || this.reconnecting || !this.threadId) return;
        this.reconnecting = true;
        this.dequeuedInputs.clear(); this.deliveryTurn = undefined; this.compactingTurn = undefined;
        this.publishSteering(); this.publishPlan(); this.permissions.close();
        try {
            while (!this.closed && !this.stopping) {
                try {
                    await initializeSharedClient(this.client);
                    void this.refreshRateLimits();
                    if (this.stopping) return;
                    this.preparePermissions(`${this.host.generation}:${randomUUID()}`);
                    this.client.setServerRequestHandler(request => { void this.receiveRequest(request); });
                    const settingsRevision = this.settingsRevision;
                    const response = record(await this.client.request('thread/resume', { threadId: this.threadId, excludeTurns: true }));
                    const observedSettings = this.settingsRevision !== settingsRevision;
                    this.acceptSettings(response);
                    if (!observedSettings) this.acceptSettings(this.host.settingsFor(this.threadId) ?? {});
                    this.projection.reset(); await this.refresh(); this.queue.replay(); await this.refreshChildren(true);
                    return;
                } catch (error) {
                    this.permissions.close();
                    logger.debug('[Codex shared] reconnect', error); await new Promise(resolve => setTimeout(resolve, 1_000));
                }
            }
        } finally { this.reconnecting = false; this.publishSteering(); this.publishPlan(); }
    }
    async applySettings(raw: unknown): Promise<{ applied: RuntimeSettings }> {
        if ((raw as Record<string, unknown>)?.permissionMode === 'safe-yolo') throw new Error('safe-yolo is not a native shared permission mode; choose default, read-only, or yolo');
        const config = SettingsSchema.parse(raw);
        if (config.fullAuto) { config.permissionMode = 'yolo'; config.approvalPolicy = 'never'; }
        if (config.permissionMode === 'yolo') config.approvalPolicy = 'never';
        if (isMiniMaxModel(config.model)) config.model = MINIMAX_MODEL;
        // Reject an invalid combined model/effort request before forking.
        if ((config.model ?? this.settings.model) === MINIMAX_MODEL && config.modelReasoningEffort !== undefined) {
            config.modelReasoningEffort = validateMiniMaxEffort(config.modelReasoningEffort);
        }
        if (isDeepSeekModel(config.model ?? this.settings.model) && config.modelReasoningEffort !== undefined) {
            config.modelReasoningEffort = validateDeepSeekEffort(config.modelReasoningEffort);
        }
        if (config.model && isDeepSeekModel(config.model) && config.model !== this.settings.model && config.modelReasoningEffort === undefined) {
            config.modelReasoningEffort = validateDeepSeekEffort(this.session.getMetadata()?.modelReasoningEfforts?.[config.model]);
        }
        if (isDeepSeekModel(config.model ?? this.settings.model) && config.serviceTier === 'fast') throw new Error('DeepSeek does not support the OpenAI Fast service tier');
        if (config.model && providerForModel(config.model) !== (this.settingsNative.modelProvider ?? providerForModel(this.settings.model ?? ''))) {
            await this.switchModelProvider(config.model, 'manual', undefined,
                isDeepSeekModel(config.model) ? config.modelReasoningEffort as string : undefined);
            const { model: _model, ...remaining } = config;
            if (isDeepSeekModel(config.model)) delete remaining.modelReasoningEffort;
            if (Object.keys(remaining).length) return this.applySettings(remaining);
            return { applied: this.settings };
        }
        if (Object.keys(config).length === 0) return { applied: this.settings };
        if (typeof config.modelReasoningEffort === 'string') config.modelReasoningEffort = parseReasoningEffortValue(config.modelReasoningEffort);
        if (config.modelReasoningEffort === null && (config.model ?? this.settings.model) === MINIMAX_MODEL) config.modelReasoningEffort = 'max';
        if (config.modelReasoningEffort === null && isDeepSeekModel(config.model ?? this.settings.model)) config.modelReasoningEffort = 'high';
        if (config.modelReasoningEffort === null) {
            // Native public null means "leave effort alone", not reset. Resolve
            // the selected model's real default instead of publishing a false reset.
            let cursor: string | undefined;
            do {
                const page = await this.client.listModels({ cursor, includeHidden: true });
                const model = page.data?.find(model => (model.model ?? model.id) === (config.model ?? this.settingsNative.model));
                if (model?.defaultReasoningEffort) { config.modelReasoningEffort = model.defaultReasoningEffort; break; }
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            if (config.modelReasoningEffort === null) throw new Error('Codex did not report a default reasoning effort; choose an explicit effort');
        }
        const revision = this.settingsRevision;
        const permission = config.permissionMode && resolveCodexPermissionModeConfig(config.permissionMode);
        if (config.fullAuto !== undefined || config.permissionMode) {
            this.session.updateMetadata(metadata => ({ ...metadata, codexFullAuto: config.fullAuto ?? config.permissionMode === 'yolo' }));
        }
        if (config.approvalPolicy) {
            // Persist intent before the asynchronous native ACK. Stale callbacks
            // must not briefly reopen human approval while disabling prompts.
            this.session.updateMetadata(metadata => ({ ...metadata, codexApprovalPolicy: config.approvalPolicy }));
            if (config.approvalPolicy === 'never') this.permissions.resolvePendingApprovals(this.fullAuto());
        }
        const params = { threadId: this.threadId,
            ...(config.approvalsReviewer ? { approvalsReviewer: config.approvalsReviewer } : {}),
            ...(config.model ? { model: config.model } : {}),
            ...(config.personality ? { personality: config.personality } : {}),
            ...(config.modelReasoningEffort !== undefined ? { effort: config.modelReasoningEffort } : {}),
            ...(config.serviceTier !== undefined ? { serviceTier: config.serviceTier === 'fast' ? 'priority' : null } : {}),
            ...(permission ? { approvalPolicy: permission.approvalPolicy, sandboxPolicy: permission.sandboxPolicy,
                approvalsReviewer: config.permissionMode === 'autoReview' ? 'auto_review' : 'user' } : {}),
            ...(this.session.getMetadata()?.codexApprovalPolicy ? { approvalPolicy: this.session.getMetadata()!.codexApprovalPolicy } : {}),
            ...(config.collaborationMode ? { collaborationMode: { mode: config.collaborationMode, settings: {
                model: config.model ?? this.settings.model, reasoning_effort: config.modelReasoningEffort ?? this.settings.modelReasoningEffort,
                developer_instructions: null
            } } } : {})
        };
        let changed!: () => void;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const accepted = new Promise<void>((resolve, reject) => {
            changed = () => { if (this.settingsRevision > revision && settingsMatch(this.settingsNative, params)) resolve(); };
            this.settingsListeners.add(changed);
            timer = setTimeout(() => reject(new Error('Native settings update is not confirmed; reconnect before retrying')), 15_000);
        });
        void accepted.catch(() => {});
        try {
            await this.client.request('thread/settings/update', params);
            // The RPC only acknowledges queueing the settings operation. The
            // native notification, not our submitted candidate, establishes state.
            await accepted; this.alive(); return { applied: this.settings };
        } finally { clearTimeout(timer); this.settingsListeners.delete(changed); }
    }
    async initialSettings(options: SharedLaunchOptions): Promise<void> {
        if (options.collaborationMode) await this.applySettings({ collaborationMode: options.collaborationMode });
    }
    private async implementPlan(planId: string): Promise<ImplementCodexPlanResult> {
        const unavailable = (): ImplementCodexPlanResult => ({ ok: false, code: 'unavailable', error: 'Codex is disconnected or stopping. Reconnect before implementing the plan.' });
        const stale = (): ImplementCodexPlanResult => ({ ok: false, code: 'stale_plan', error: 'This plan is no longer actionable. Refresh the conversation.' });
        const localId = planImplementationMessageId(planId);
        if (this.closed || this.stopping || this.reconnecting || !this.client.isInitialized()) return unavailable();
        try {
            // A reconnect snapshot may have started before this action arrived.
            await this.refreshing;
            await this.refresh();
            const prior = this.queue.state(localId);
            if (prior === 'queued' || prior === 'consumed') return { ok: true };
            if (prior) return { ok: false, code: 'indeterminate', error: 'This implementation was already submitted. Check the queue and conversation before sending again.' };
            const before = await this.queue.list();
            if (this.availablePlanId() !== planId || before.length) return stale();
            const revision = this.turnRevision;
            this.submittingPlan = true; this.publishPlan();
            await this.applySettings({ collaborationMode: 'default' });
            const queued = await this.queue.list();
            if (this.closed || this.stopping || this.reconnecting || !this.client.isInitialized()) return unavailable();
            if (this.turnRevision !== revision || this.currentTurn || this.latestTurn?.planId !== planId
                || this.settings.collaborationMode !== 'default' || queued.length) return stale();
            await this.queue.enqueue(localId, buildUserInputFromMessage('Implement the plan.'));
            return { ok: true };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return { ok: false, code: isIndeterminateError(error) || this.queue.state(localId) === 'unknown' ? 'indeterminate' : 'failed',
                error: `Plan implementation was not confirmed: ${detail}. Check the mode, queue and conversation before retrying.` };
        } finally { this.submittingPlan = false; this.publishPlan(); }
    }
    private registerControls(): void {
        const rpc = { registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
            this.session.rpcHandlerManager.registerHandler(method, async (raw: unknown) => {
                if (this.stopping) throw new Error('Codex execution is stopping; resume when inactive');
                const pending = handler(raw); this.controls.add(pending);
                try { return await pending; } finally { this.controls.delete(pending); }
            });
        } };
        rpc.registerHandler(RPC_METHODS.ListCodexModels, async raw => {
            const models = []; let cursor: string | undefined;
            try {
                do {
                    const response = await this.client.listModels({ includeHidden: record(raw).includeHidden === true, cursor });
                    models.push(...(response.data ?? []).map(normalizeCodexModel).filter(model => model !== null)); cursor = response.nextCursor ?? undefined;
                } while (cursor);
            } catch (error) { if (!withDeepSeekModels(withMiniMaxModel([])).length) throw error; }
            const available = withDeepSeekModels(withMiniMaxModel(models));
            return { success: true, models: this.host.deepseekReady === false ? available.filter(model => !isDeepSeekModel(model.id)) : available };
        });
        rpc.registerHandler(RPC_METHODS.Switch, async () => { throw new Error('control_mode_not_applicable'); });
        rpc.registerHandler(RPC_METHODS.HandoffLocal, async () => { throw new Error('control_mode_not_applicable'); });
        rpc.registerHandler(RPC_METHODS.Abort, async () => {
            const turnId = this.currentTurn;
            if (turnId) await this.client.request('turn/interrupt', { threadId: this.threadId, turnId });
        });
        rpc.registerHandler(RPC_METHODS.KillSession, async () => { await this.host.end(this); return { success: true }; });
        // #1911 C2 / AC6: Codex owns KillSession here and never calls
        // registerKillSessionHandler — still must EXIT on hub-archived metadata
        // (KillSession unreachable / map-miss). Latch covers bootstrap write
        // before bind/activate registers controls; B2 refuses tree-kill of the
        // shared wrapper so this subscribe is load-bearing.
        const exitFromHubArchive = () => {
            void this.host.end(this).catch(error => logger.debug('[CODEX] hub-archived end failed:', error));
        };
        if (this.session.hubArchived) {
            exitFromHubArchive();
        }
        this.session.on('hub-archived', exitFromHubArchive);
        rpc.registerHandler(RPC_METHODS.SetSessionConfig, raw => {
            const work = this.work.catch(() => {}).then(() => this.applySettings(raw));
            this.work = work; return work;
        });
        rpc.registerHandler(RPC_METHODS.HybridModel, async raw => {
            const { mode } = z.object({ mode: z.enum(['openai', 'hybrid']).optional() }).strict().parse(raw);
            return this.hybridPolicy(mode);
        });
        rpc.registerHandler(RPC_METHODS.DeepSeekCollaboration, async raw => {
            const { mode } = z.object({ mode: z.enum(['openai', 'hybrid']).optional() }).strict().parse(raw);
            return this.deepseekPolicy(mode);
        });
        rpc.registerHandler(RPC_METHODS.ImplementCodexPlan, raw => {
            const { planId } = ImplementCodexPlanRequestSchema.parse(raw);
            const work = this.work.catch(() => {}).then(() => this.implementPlan(planId));
            this.work = work;
            return work;
        });
        rpc.registerHandler(RPC_METHODS.SteerQueuedMessage, async raw => {
            const { localId } = z.object({ localId: z.string().min(1) }).parse(raw);
            const expectedTurnId = this.currentTurn;
            if (!expectedTurnId) return { steered: false, error: 'No active turn' };
            return this.queue.steer(localId, expectedTurnId);
        });
        rpc.registerHandler(RPC_METHODS.ClearConversation, async () => {
            const child = await this.newConversation(); return { sessionId: child.session.sessionId };
        });
        rpc.registerHandler(RPC_METHODS.ForkConversation, async raw => {
            const { messageLocalId } = z.object({ messageLocalId: z.string().optional() }).parse(raw);
            if (this.currentTurn && !messageLocalId) throw new Error('Session is busy');
            const beforeTurnId = messageLocalId ? this.projection.turnFor(messageLocalId) : undefined;
            if (messageLocalId && !beforeTurnId) throw new Error('No native history point for this message');
            if (messageLocalId) {
                const thread = await this.assertBoundary(messageLocalId, beforeTurnId!);
                const turns = (Array.isArray(thread.turns) ? thread.turns : []).map(record);
                const index = turns.findIndex(turn => turn.id === beforeTurnId);
                if (index < 0 || turns.slice(0, index + 1).some(turn =>
                    !['completed', 'interrupted', 'failed'].includes(string(turn.status) ?? ''))) {
                    throw new Error('Historical fork requires a completed turn and history prefix');
                }
            }
            const project = inheritSessionProject(this.session.getMetadata()?.project, this.session.sessionId);
            const child = await this.host.create('thread/fork', { ...this.freshParams(), threadId: this.threadId,
                ...(beforeTurnId ? { beforeTurnId } : {}) }, this, ...(project ? [project] : []));
            await child.initialSettings({ collaborationMode: this.settings.collaborationMode });
            return { nativeSessionId: child.threadId, sessionId: child.session.sessionId };
        });
        rpc.registerHandler(RPC_METHODS.RewindConversation, async () => {
            throw new Error('In-place rewind is not supported for concurrent Codex clients; fork at the message instead');
        });
    }
    private async assertBoundary(localId: string, turnId: string): Promise<Record<string, unknown>> {
        const thread = await this.readThread(this.threadId, true);
        const turn = (Array.isArray(thread.turns) ? thread.turns.map(record) : []).find(turn => turn.id === turnId);
        const first = (Array.isArray(turn?.items) ? turn.items.map(record) : []).find(item => item.type === 'userMessage');
        const firstId = string(first?.clientId ?? first?.clientUserMessageId) ?? (first?.id ? `codex:${this.historyThreadId(turnId)}:user:${first.id}` : undefined);
        if (firstId !== localId) throw new Error('Cannot cut inside a steered native turn. Select its first message.');
        return thread;
    }
    private historyThreadId(turnId: string): string { return this.session.getMetadata()?.codexProviderHistory?.turnOrigins?.[turnId] ?? this.threadId; }
    freshParams(): Record<string, unknown> {
        const sandbox = inheritedSandbox(this.settingsNative);
        return { ...sandbox, cwd: this.settingsNative.cwd ?? this.bootstrap.workingDirectory, model: this.settingsNative.model, modelProvider: this.settingsNative.modelProvider,
            approvalPolicy: this.session.getMetadata()?.codexApprovalPolicy ?? this.settingsNative.approvalPolicy, serviceTier: this.settingsNative.serviceTier,
            approvalsReviewer: isMiniMaxModel(this.settings.model) && this.manualReviewFallback
                ? 'user' : this.settingsNative.approvalsReviewer, personality: this.settingsNative.personality,
            developerInstructions: withSharedUserInputPolicy(),
            config: { ...record(sandbox.config), model_reasoning_effort: this.settings.modelReasoningEffort ?? undefined } };
    }
    private notice(message: string): void { this.session.sendSessionEvent({ type: 'message', message }); }
    private noApprovalPrompts(): boolean {
        const preference = this.session.getMetadata()?.codexApprovalPolicy;
        return preference ? preference === 'never'
            : this.settingsNative.approvalPolicy === 'never' || isMiniMaxModel(this.settings.model);
    }
    private fullAuto(): boolean {
        return this.session.getMetadata()?.codexFullAuto
            ?? (this.noApprovalPrompts() && record(this.settingsNative.sandboxPolicy ?? this.settingsNative.sandbox).type === 'dangerFullAccess');
    }
    private changeReviewer(reviewer: 'user' | 'auto_review'): Promise<void> {
        // Order explicit recovery and failure notifications, so a concurrent
        // failure is applied after the in-flight automatic-review update.
        const change = this.reviewerChanges.catch(() => {}).then(async () => {
            await this.applySettings({ approvalsReviewer: reviewer, approvalPolicy: 'on-request', fullAuto: false });
        });
        this.reviewerChanges = change;
        return change;
    }
    async reviewUnavailable(): Promise<void> {
        if (!isMiniMaxModel(this.settings.model) || this.closed || this.stopping) return;
        // Never reopen manual approval after the user disabled prompts.
        if (this.noApprovalPrompts()) return;
        if (this.reviewFallback) return this.reviewFallback;
        this.manualReviewFallback = true;
        // Persist the safe recovery preference before the native asynchronous update.
        this.session.updateMetadata(metadata => ({ ...metadata, minimaxApprovalReviewer: 'user' }));
        this.notice('OpenAI 自动审阅暂不可用，当前操作未获准，也不会自动重试。后续审批转人工；恢复后可发送 /reviewer auto 重新启用。');
        this.reviewFallback = this.changeReviewer('user');
        try { await this.reviewFallback; }
        catch (error) { this.notice('人工审批模式尚未确认，请等待本轮结束后重新连接。'); throw error; }
    }
    private async hybridPolicy(mode?: 'openai' | 'hybrid'): Promise<{ mode: 'openai' | 'hybrid' }> {
        // Multiple browser tabs and /hybrid commands share one ordered queue.
        const change = this.hybridChanges.catch(() => {}).then(async () => {
            const result = await hybridModelPolicy(this.session.sessionId, mode);
            this.session.updateMetadata(metadata => ({ ...metadata, hybridModel: result }));
            return result;
        });
        this.hybridChanges = change;
        return change;
    }
    private async deepseekPolicy(mode?: 'openai' | 'hybrid'): Promise<{ mode: 'openai' | 'hybrid' }> {
        const change = this.deepseekChanges.catch(() => {}).then(async () => {
            const result = await deepseekCollaborationPolicy(this.session.sessionId, mode);
            this.session.updateMetadata(metadata => ({ ...metadata, deepseekCollaboration: result }));
            return result;
        });
        this.deepseekChanges = change;
        return change;
    }
    private async newConversation(): Promise<SharedCodexRoot> {
        const project = inheritSessionProject(this.session.getMetadata()?.project, this.session.sessionId);
        const child = project
            ? await this.host.create('thread/start', { ...this.freshParams(), cwd: project.directory }, undefined, project)
            : await this.host.create('thread/start', this.freshParams());
        await child.initialSettings({ collaborationMode: this.settings.collaborationMode }); return child;
    }
    private async command(text: string): Promise<string | null> {
        const command = text.trim();
        if (/^\/approvals(?:\s|$)/.test(command)) {
            const match = /^\/approvals(?:\s+(auto|never|status))?$/.exec(command);
            if (!match) { this.notice('用法：/approvals auto | never | status'); return null; }
            if (match[1] === 'auto') await this.applySettings({ fullAuto: true });
            if (match[1] === 'never') await this.applySettings({ approvalPolicy: 'never' });
            this.notice(this.fullAuto() ? '本会话全自动执行：Full Access、无需人工审批，工具操作审批自动批准。'
                : this.noApprovalPrompts()
                ? '本会话不弹人工审批：授权范围内直接执行，超出权限直接拒绝；沙箱保持当前设置。'
                : '本会话沿用当前审批设置。');
            return null;
        }
        if (/^\/reviewer(?:\s|$)/.test(command)) {
            const match = /^\/reviewer(?:\s+(auto|user|status))?$/.exec(command);
            if (!match) { this.notice('用法：/reviewer auto | user | status'); return null; }
            if (!isMiniMaxModel(this.settings.model)) { this.notice('此命令用于 MiniMax 独立模式。'); return null; }
            if (match[1] && match[1] !== 'status') {
                await this.reviewFallback?.catch(() => {});
                this.reviewFallback = undefined;
                this.manualReviewFallback = match[1] === 'user';
                // Enqueue the explicit change before reopening the transport:
                // a synchronous failure during reset must win after it.
                const change = this.changeReviewer(match[1] === 'auto' ? 'auto_review' : 'user');
                if (match[1] === 'auto') this.host.resetReviewTransport?.();
                await change;
                await this.reviewFallback;
            }
            this.notice(this.noApprovalPrompts() ? '本会话：不弹人工审批。'
                : this.settingsNative.approvalsReviewer === 'auto_review' ? '本会话：OpenAI 自动审阅。' : '本会话：人工审批。');
            return null;
        }
        if (/^\/deepseek(?:\s|$)/.test(command)) {
            const match = /^\/deepseek(?:\s+(on|off|status))?$/.exec(command);
            if (!match) { this.notice('用法：/deepseek on | off | status'); return null; }
            const result = await this.deepseekPolicy(match[1] === 'on' ? 'hybrid' : match[1] === 'off' ? 'openai' : undefined);
            this.notice(result.mode === 'hybrid' ? 'DeepSeek 协作：已开启（仅本会话）。' : 'DeepSeek 协作：已关闭（仅本会话）。已受理请求可以完成。');
            return null;
        }
        if (/^\/hybrid(?:\s|$)/.test(command)) {
            const match = /^\/hybrid(?:\s+(on|off|status))?$/.exec(command);
            if (!match) { this.notice('Usage: /hybrid on | off | status'); return null; }
            const result = await this.hybridPolicy(match[1] === 'on' ? 'hybrid' : match[1] === 'off' ? 'openai' : undefined);
            this.notice(result.mode === 'hybrid' ? 'MiniMax hybrid: ON (this session).' : 'MiniMax hybrid: OFF (this session). Already admitted requests may finish.');
            return null;
        }
        if (command === '/clear' || command === '/new') {
            const child = await this.newConversation(); this.notice(`New conversation: /sessions/${child.session.sessionId}`); return null;
        }
        if (command === '/compact') { await this.client.request('thread/compact/start', { threadId: this.threadId }); return null; }
        if (command === '/exit') { this.notice('/exit closes a native terminal, not this Web view. Use End session to archive this conversation.'); return null; }
        if (!command.startsWith('/')) return text;
        const slash = resolveCodexSlashCommand(text, { commands: await listSlashCommands('codex', this.bootstrap.workingDirectory),
            permissionMode: this.settings.permissionMode === 'yolo' || this.settings.permissionMode === 'read-only' || this.settings.permissionMode === 'autoReview' ? this.settings.permissionMode : 'default',
            collaborationMode: this.settings.collaborationMode ?? 'default', model: this.settings.model ?? undefined,
            modelReasoningEffort: parseReasoningEffortValue(this.settings.modelReasoningEffort), serviceTier: this.settings.serviceTier });
        if (slash.kind === 'passthrough') return text;
        if (slash.kind === 'goal') {
            const params = { threadId: this.threadId };
            const response = slash.action === 'show' ? await this.client.request('thread/goal/get', params)
                : slash.action === 'clear' ? await this.client.request('thread/goal/clear', params)
                : await this.client.request('thread/goal/set', { ...params, ...(slash.action === 'set' ? { objective: slash.objective } : { status: slash.action === 'pause' ? 'paused' : 'active' }) });
            this.notice(JSON.stringify(response)); return null;
        }
        if (slash.updates?.proactiveMultiAgent !== undefined) throw new Error('This Codex version uses Ultra reasoning effort instead of a multi-agent toggle');
        if (slash.updates?.model === null) throw new Error('Choose an explicit model in a shared thread');
        if (slash.updates) await this.applySettings(slash.updates);
        if (slash.message) this.notice(slash.message);
        return slash.kind === 'replace' ? slash.text : null;
    }
    stopAccepting(): void {
        this.stopping = true; this.ready();
        this.publishSteering();
        this.publishPlan();
        this.session.onReconnect(null); this.client.setTransportAbandonedHandler(null);
    }
    async suspend(): Promise<void> {
        this.stopAccepting();
        await this.work.catch(() => {}); await Promise.allSettled([...this.controls]);
        await this.queue?.suspend();
        // Capture any dequeue/turn that won the race with native deletion.
        if (this.threadId && this.client.isInitialized()) await this.refresh();
    }
    close(archived: boolean): Promise<void> {
        return this.closing ??= (async () => {
            this.stopAccepting(); this.closed = true; clearInterval(this.heartbeat);
            this.permissions?.close(); this.asyncQuestions?.close();
            await this.client.disconnect(); await this.notifications; await this.queue?.flush(); this.bridge?.server.stop();
            if (archived) this.session.updateMetadata(metadata => ({ ...metadata, lifecycleState: 'archived', lifecycleStateSince: Date.now() }));
            // Inactive is resumable; uploads referenced by pending input must survive.
            this.session.sendSessionDeath(undefined, { preserveUploads: !archived });
            await this.session.flush(); this.session.close();
        })();
    }
}
