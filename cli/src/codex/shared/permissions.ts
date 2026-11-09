import { z } from 'zod';
import type { ApiSessionClient } from '@/api/apiSession';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { registerAppServerPermissionHandlers, IGNORE_SHARED_REQUEST } from '../utils/appServerPermissionAdapter';
import { record, string } from './gateway';
import type { SharedCodexAsyncQuestions } from './asyncQuestions';

const ReplySchema = z.object({
    id: z.string(), approved: z.boolean(),
    decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).optional(),
    reason: z.string().optional(),
    answers: z.union([z.record(z.string(), z.array(z.string())), z.record(z.string(), z.object({ answers: z.array(z.string()) }))]).optional()
});
export type PermissionReply = z.infer<typeof ReplySchema>;
type Reply = PermissionReply;
export const USER_INPUT_TIMEOUT_MS = 20 * 60 * 1000;
type Pending = { nativeId: string | number; threadId: string; turnId?: string; toolCallId: string; userInput: boolean; approval: boolean; input: unknown; submitted: boolean;
    deadlineKey?: string; timer?: ReturnType<typeof setTimeout>; timedOut?: boolean;
    answer(reply: Reply): void; cancel(error: Error): void };

/** No winner is inferred from submitting a Web candidate: only native resolution closes it. */
export class SharedCodexPermissions {
    private readonly pending = new Map<string, Pending>();
    private readonly retired = new Set<string>();
    private readonly silentReplies = new Set<string>();
    private closed = false;
    private questionEvent(request: Pending, status?: 'resolved' | 'canceled'): void {
        const id = `codex:${request.threadId}:question:${request.toolCallId}:${status ?? 'start'}`;
        const message = status
            ? { type: 'tool-call-result', callId: request.toolCallId, output: { status, ...(request.timedOut ? { timedOut: true } : {}) }, is_error: false, id }
            : { type: 'tool-call', name: 'request_user_input', callId: request.toolCallId, input: request.input, id };
        const rootThreadId = this.session.getMetadata()?.codexSessionId;
        this.session.sendAgentMessage(rootThreadId && rootThreadId !== request.threadId ? {
            type: 'agent-run-trace', agentId: request.threadId, cardId: `codex-agent:${request.threadId}`, message, id,
            scope: { role: 'child', threadId: request.threadId, parentThreadId: rootThreadId }, scope_role: 'child'
        } : message, id);
    }
    private armTimeout(key: string, request: Pending): void {
        if (!request.userInput || !request.deadlineKey) return; // Never time out command/permission or MCP approvals.
        clearTimeout(request.timer);
        const deadline = this.questionDeadlines.get(request.deadlineKey);
        if (deadline === undefined) return;
        request.timer = setTimeout(() => {
            if (this.closed || this.pending.get(key) !== request || request.submitted) return;
            request.submitted = true;
            request.timedOut = true;
            // Empty means unanswered, not an option selection or authorization.
            // Native resolution remains the authority for retiring the card.
            request.answer({ id: key, approved: true, answers: {} });
        }, Math.max(0, deadline - Date.now()));
        request.timer.unref?.();
    }
    constructor(private readonly session: ApiSessionClient, private readonly client: CodexAppServerClient, private readonly generation: string,
        private readonly answerAsyncQuestion?: ((reply: Reply) => Promise<boolean>) | SharedCodexAsyncQuestions,
        private readonly questionDeadlines = new Map<string, number>(),
        private readonly noApprovalPrompts: () => boolean = () => false,
        private readonly autoApprove: () => boolean = () => false) {
        session.rpcHandlerManager.registerHandler(RPC_METHODS.Permission, async (raw: unknown) => {
            const reply = ReplySchema.parse(raw);
            if (typeof this.answerAsyncQuestion === 'function') {
                if (await this.answerAsyncQuestion(reply)) return;
            } else if (this.answerAsyncQuestion && 'answer' in this.answerAsyncQuestion) {
                if (await this.answerAsyncQuestion.answer(reply)) return;
            }
            const request = this.pending.get(reply.id);
            if (!request || request.submitted) throw new Error('Request already resolved or submitted');
            const questions = record(request.input).questions;
            if (Array.isArray(questions) && reply.approved) {
                if (!reply.answers) throw new Error('Answers are required');
                for (const question of questions) {
                    const id = string(record(question).id);
                    if (id && !reply.answers[id]) throw new Error(`Missing answer: ${id}`);
                }
            }
            request.submitted = true;
            if (request.userInput && !reply.approved) {
                if (!request.turnId) { request.submitted = false; throw new Error('Cannot cancel a question without its native turn ID'); }
                try { await this.client.request('turn/interrupt', { threadId: request.threadId, turnId: request.turnId }); }
                catch (error) { request.submitted = false; this.armTimeout(reply.id, request); throw error; }
                clearTimeout(request.timer);
                return;
            }
            clearTimeout(request.timer);
            request.answer(reply);
        });
    }

    receive(request: { id: string | number; method: string; params: unknown }): void {
        const threadId = string(record(request.params).threadId);
        if (!threadId) return;
        const key = `${this.generation}:${threadId}:${typeof request.id}:${request.id}`;
        if (this.closed || this.pending.has(key) || this.retired.has(key) || this.silentReplies.has(key)) return;
        const handlers = new Map<string, (params: unknown) => unknown>();
        let declinedWithoutPrompt = false;
        const ask = (tool: string, input: unknown, approval = false): Promise<Reply> => new Promise((answer, cancel) => {
            const pending: Pending = { nativeId: request.id, threadId, turnId: string(record(request.params).turnId),
                toolCallId: string(record(request.params).itemId) ?? key,
                userInput: request.method === 'item/tool/requestUserInput', approval, input, answer, cancel, submitted: false };
            this.pending.set(key, pending);
            let createdAt = Date.now();
            if (pending.userInput) {
                pending.deadlineKey = JSON.stringify([threadId, pending.turnId, pending.toolCallId]);
                const deadline = this.questionDeadlines.get(pending.deadlineKey) ?? createdAt + USER_INPUT_TIMEOUT_MS;
                this.questionDeadlines.set(pending.deadlineKey, deadline);
                createdAt = deadline - USER_INPUT_TIMEOUT_MS;
                this.armTimeout(key, pending);
            }
            // requestUserInput is a server request, not a native transcript item.
            // Persist its lifecycle so resolution cannot erase the question card.
            if (pending.userInput) this.questionEvent(pending);
            this.session.updateAgentState(state => ({ ...state, requests: { ...state.requests,
                [key]: { tool, toolCallId: pending.toolCallId, arguments: input, createdAt }
            } }));
        });
        registerAppServerPermissionHandlers({
            client: { registerRequestHandler: (method, handler) => { handlers.set(method, handler); } },
            shared: true,
            permissionHandler: { handleToolCall: async (_id, name, input) => {
                if (this.noApprovalPrompts()) {
                    declinedWithoutPrompt = true;
                    this.silentReplies.add(key);
                    return { decision: this.autoApprove() ? 'approved' : 'denied' };
                }
                const reply = await ask(name, input, true);
                return { decision: reply.approved ? (reply.decision === 'approved_for_session' ? 'approved_for_session' : 'approved') : reply.decision === 'denied' ? 'denied' : 'abort' };
            } },
            onUserInputRequest: async ({ input }) => {
                const reply = await ask('request_user_input', input);
                return reply.approved && reply.answers ? { decision: 'accept', answers: reply.answers } : { decision: 'cancel' };
            }
        });
        const handler = handlers.get(request.method);
        if (!handler) return;
        let response: unknown;
        try { response = handler(request.params); } catch { return; }
        void Promise.resolve(response).then(result => {
            if (result === IGNORE_SHARED_REQUEST) return;
            if (this.closed || this.retired.has(key)) return;
            // No pending entry means a native client already resolved the displayed request.
            if (declinedWithoutPrompt || this.pending.has(key) || request.method === 'mcpServer/elicitation/request' && record(request.params).serverName === 'hapi') {
                // The adapter's decision envelope is HAPI-internal, not the
                // native request_user_input response schema. An invalid first
                // response would consume Codex's callback even if it cannot decode.
                if (request.method === 'item/tool/requestUserInput') {
                    const answers = Object.fromEntries(Object.entries(record(record(result).answers)).map(([id, value]) =>
                        [id, { answers: Array.isArray(value) ? value : record(value).answers }]));
                    this.client.respond(request.id, { answers });
                } else this.client.respond(request.id, result);
                if (declinedWithoutPrompt) this.retired.add(key);
            }
        }).catch(() => { /* Native resolution/disconnection withdraws, never responds with an error. */ })
            .finally(() => { this.silentReplies.delete(key); });
    }

    resolvePendingApprovals(approved = false): void {
        for (const request of this.pending.values()) {
            if (!request.approval || request.submitted) continue;
            request.submitted = true;
            request.answer({ id: '', approved, decision: approved ? 'approved' : 'denied' });
        }
    }

    resolved(threadId: string, nativeId: unknown, status: 'resolved' | 'canceled' = 'resolved'): void {
        this.retired.add(`${this.generation}:${threadId}:${typeof nativeId}:${nativeId}`);
        for (const [key, request] of this.pending) {
            if (request.threadId !== threadId || request.nativeId !== nativeId) continue;
            clearTimeout(request.timer);
            // A transport reconnect replaces this controller but preserves the
            // root's deadlines. A real native resolution releases its deadline.
            if (!this.closed && request.deadlineKey) this.questionDeadlines.delete(request.deadlineKey);
            this.pending.delete(key);
            request.cancel(new Error('Resolved by Codex'));
            if (request.userInput) this.questionEvent(request, status);
            this.session.updateAgentState(state => {
                const requests = { ...state.requests };
                const prior = requests[key]; delete requests[key];
                return { ...state, requests, completedRequests: { ...state.completedRequests,
                    ...(prior ? { [key]: { ...prior, completedAt: Date.now(), status } } : {})
                } };
            });
        }
    }

    close(): void {
        this.closed = true;
        if (this.answerAsyncQuestion && typeof this.answerAsyncQuestion === 'object' && 'close' in this.answerAsyncQuestion) {
            this.answerAsyncQuestion.close();
        }
        for (const request of [...this.pending.values()]) this.resolved(request.threadId, request.nativeId, 'canceled');
    }
}
