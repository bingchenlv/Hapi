import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { SharedCodexPermissions, USER_INPUT_TIMEOUT_MS } from './permissions';

function fixture(noPrompts: () => boolean = () => false, autoApprove: () => boolean = () => false) {
    let state: AgentState = {};
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const send = vi.fn();
    const session = { getMetadata: () => ({ codexSessionId: 'thread' }), sendAgentMessage: send,
        updateAgentState: (fn: (state: AgentState) => AgentState) => { state = fn(state); },
        rpcHandlerManager: { registerHandler: (key: string, fn: (raw: unknown) => Promise<unknown>) => handlers.set(key, fn) } } as unknown as ApiSessionClient;
    const respond = vi.fn();
    const client = { respond, request: vi.fn(async () => ({})) } as unknown as CodexAppServerClient;
    const deadlines = new Map<string, number>();
    const permissions = new SharedCodexPermissions(session, client, 'generation', undefined, deadlines, noPrompts, autoApprove);
    const request = { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'call',
        questions: [{ id: 'choice', header: 'Choose', question: 'Which?', options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }] }] } };
    return { permissions, request, respond, handlers, send, client, session, deadlines, state: () => state };
}
afterEach(() => { vi.useRealTimers(); });
describe('shared request arbitration', () => {
    it.each(['approved', 'approved_for_session'])('forwards an explicit %s decision to Codex without approving a different root', async decision => {
        const first = fixture(); const other = fixture();
        const request = { id: 17, method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread', turnId: 'turn', itemId: 'exec', command: 'printf approval-check' } };
        first.permissions.receive(request); other.permissions.receive(request);
        const id = Object.keys(first.state().requests!)[0];
        await first.handlers.get('permission')!({ id, approved: true, decision });
        await vi.waitFor(() => expect(first.respond).toHaveBeenCalledExactlyOnceWith(17,
            { decision: decision === 'approved_for_session' ? 'acceptForSession' : 'accept' }));
        expect(other.respond).not.toHaveBeenCalled();
        first.permissions.close(); other.permissions.close();
    });
    it('waits the full 20 minutes, then returns no answer once without selecting or queuing', async () => {
        vi.useFakeTimers(); const f = fixture(); f.permissions.receive(f.request);
        expect(USER_INPUT_TIMEOUT_MS).toBe(20 * 60 * 1000);
        const id = Object.keys(f.state().requests!)[0];
        await vi.advanceTimersByTimeAsync(USER_INPUT_TIMEOUT_MS - 1);
        expect(f.respond).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(f.respond).toHaveBeenCalledExactlyOnceWith(1, { answers: {} });
        expect(f.client.request).not.toHaveBeenCalled();
        await expect(f.handlers.get('permission')!({ id, approved: true, answers: { choice: ['B'] } })).rejects.toThrow('already resolved or submitted');
        f.permissions.resolved('thread', 1);
        expect(f.deadlines.size).toBe(0);
        expect(f.send).toHaveBeenLastCalledWith(expect.objectContaining({ output: { status: 'resolved', timedOut: true } }), expect.any(String));
        await vi.advanceTimersByTimeAsync(USER_INPUT_TIMEOUT_MS);
        expect(f.respond).toHaveBeenCalledTimes(1);
    });
    it('does not replace an answer submitted just before the deadline with an empty answer', async () => {
        vi.useFakeTimers(); const f = fixture(); f.permissions.receive(f.request);
        await vi.advanceTimersByTimeAsync(USER_INPUT_TIMEOUT_MS - 1);
        await f.handlers.get('permission')!({ id: Object.keys(f.state().requests!)[0], approved: true, answers: { choice: ['B'] } });
        await vi.advanceTimersByTimeAsync(USER_INPUT_TIMEOUT_MS);
        expect(f.respond).toHaveBeenCalledExactlyOnceWith(1, { answers: { choice: { answers: ['B'] } } });
        f.permissions.resolved('thread', 1);
    });
    it('preserves the original deadline across a native transport reconnect', async () => {
        vi.useFakeTimers(); const f = fixture(); f.permissions.receive(f.request);
        const createdAt = Object.values(f.state().requests!)[0].createdAt;
        await vi.advanceTimersByTimeAsync(USER_INPUT_TIMEOUT_MS - 60_000);
        f.permissions.close();
        const next = new SharedCodexPermissions(f.session, f.client, 'next-generation', undefined, f.deadlines);
        next.receive(f.request);
        expect(Object.values(f.state().requests!)[0].createdAt).toBe(createdAt);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(f.respond).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(f.respond).toHaveBeenCalledExactlyOnceWith(1, { answers: {} });
        next.resolved('thread', 1); next.close();
    });
    it.each(['resolve', 'disconnect', 'cancel'])('clears the timer on %s', async action => {
        vi.useFakeTimers(); const f = fixture(); f.permissions.receive(f.request);
        if (action === 'resolve') f.permissions.resolved('thread', 1);
        else if (action === 'disconnect') f.permissions.close();
        else await f.handlers.get('permission')!({ id: Object.keys(f.state().requests!)[0], approved: false });
        await vi.advanceTimersByTimeAsync(USER_INPUT_TIMEOUT_MS * 2);
        expect(f.respond).not.toHaveBeenCalled();
        f.permissions.close();
    });
    it.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'])('never automatically approves %s', async method => {
        vi.useFakeTimers(); const f = fixture(); f.permissions.receive({ ...f.request, method });
        expect(Object.keys(f.state().requests!)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(USER_INPUT_TIMEOUT_MS * 2);
        expect(f.respond).not.toHaveBeenCalled();
        expect(f.deadlines.size).toBe(0);
        f.permissions.close();
    });
    it.each([{ notes: [] }, { notes: ['user_note: custom answer'] }])('preserves isOther and canonical other answers (%j) without claiming a winner', async ({ notes }) => {
        const f = fixture();
        const request = { ...f.request, params: { ...f.request.params, isBlocking: true,
            questions: f.request.params.questions.map(question => ({ ...question, isOther: true })) } };
        f.permissions.receive(request);
        const [id, pending] = Object.entries(f.state().requests ?? {})[0]!;
        expect(pending.arguments).toEqual(request.params);
        const answers = { choice: { answers: ['None of the above', ...notes] } };
        await f.handlers.get('permission')!({ id, approved: true, answers });
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledWith(1, { answers }));
        expect(f.state().completedRequests).toBeUndefined();
        f.permissions.resolved('thread', request.id);
        expect(f.state().completedRequests?.[id]).toMatchObject({ status: 'resolved' });
        expect(f.state().completedRequests?.[id]).not.toHaveProperty('answers');
    });

    it('withdrawal on disconnect is canceled, not a claim that a native answer won', () => {
        const f = fixture(); f.permissions.receive(f.request); f.permissions.close();
        expect(Object.values(f.state().completedRequests ?? {})[0]?.status).toBe('canceled');
        expect(f.respond).not.toHaveBeenCalled();
        expect(f.send).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'tool-call-result', callId: 'call', output: { status: 'canceled' }, is_error: false
        }), 'codex:thread:question:call:canceled');
    });
    it('native resolution in the same tick cannot resurrect a prompt or submit a late answer', async () => {
        const f = fixture(); f.permissions.receive(f.request); f.permissions.resolved('thread', 1);
        await Promise.resolve(); await Promise.resolve();
        expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
        expect(Object.values(f.state().completedRequests ?? {})[0]?.status).toBe('resolved');
        expect(f.respond).not.toHaveBeenCalled();
        f.permissions.receive(f.request); expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
        expect(f.send.mock.calls).toEqual([
            [{ type: 'tool-call', name: 'request_user_input', callId: 'call', input: f.request.params,
                id: 'codex:thread:question:call:start' }, 'codex:thread:question:call:start'],
            [{ type: 'tool-call-result', callId: 'call', output: { status: 'resolved' }, is_error: false,
                id: 'codex:thread:question:call:resolved' }, 'codex:thread:question:call:resolved']
        ]);
    });
    it('validates all answers before submitting; sending is not proof of winning', async () => {
        const f = fixture(); f.permissions.receive(f.request);
        const id = Object.keys(f.state().requests ?? {})[0]; const reply = f.handlers.get('permission')!;
        await expect(reply({ id, approved: true, answers: {} })).rejects.toThrow('Missing answer');
        await reply({ id, approved: true, answers: { choice: ['B'] } });
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledWith(1, { answers: { choice: { answers: ['B'] } } }));
        expect(f.state().completedRequests).toBeUndefined();
        expect(f.send).toHaveBeenCalledTimes(1); // Submission alone is not a result.
        f.permissions.resolved('thread', 1);
        expect(Object.values(f.state().completedRequests ?? {})[0]).toMatchObject({ status: 'resolved' });
        expect(Object.values(f.state().completedRequests ?? {})[0]).not.toHaveProperty('answers');
    });
    it('keeps child questions in their agent trace and replay IDs stable across reconnects', () => {
        const f = fixture();
        const request = { ...f.request, params: { ...f.request.params, threadId: 'child' } };
        f.permissions.receive(request); f.permissions.resolved('child', request.id);
        expect(f.send.mock.calls[0][0]).toMatchObject({ type: 'agent-run-trace', agentId: 'child',
            message: { type: 'tool-call', name: 'request_user_input', callId: 'call' },
            scope: { role: 'child', parentThreadId: 'thread' } });
        const again = fixture(); again.permissions.receive(request); again.permissions.resolved('child', request.id);
        expect(again.send.mock.calls).toEqual(f.send.mock.calls);
    });
    it('ignores unsupported requests, including requests for an unknown MCP elicitation form', async () => {
        const f = fixture();
        f.permissions.receive({ id: 2, method: 'future/request', params: { threadId: 'thread' } });
        await Promise.resolve(); expect(f.respond).not.toHaveBeenCalled();
    });
});


describe('approval prompts disabled', () => {
    it.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestApproval', 'item/permissions/requestApproval'])('declines %s without creating a human card or granting permission', async method => {
        const f = fixture(() => true);
        const request = { id: 53, method, params: { threadId: 'thread', turnId: 'turn', itemId: 'restricted', permissions: { network: { enabled: true } } } };
        f.permissions.receive(request); f.permissions.receive(request);
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledTimes(1));
        expect(f.respond).toHaveBeenCalledWith(53, method === 'item/permissions/requestApproval'
            ? { permissions: { network: null, fileSystem: null }, scope: 'turn' } : { decision: 'decline' });
        expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
        expect(f.send).not.toHaveBeenCalled();
        f.permissions.close();
    });
    it('denies only pending approvals when the preference changes, preserving unanswered choices', async () => {
        let disabled = false; const f = fixture(() => disabled);
        f.permissions.receive({ id: 6, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', itemId: 'restricted' } });
        f.permissions.receive(f.request);
        disabled = true; f.permissions.resolvePendingApprovals();
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledExactlyOnceWith(6, { decision: 'decline' }));
        const approval = Object.entries(f.state().requests ?? {}).find(([, r]) => r.tool !== 'request_user_input')!;
        await expect(f.handlers.get('permission')!({ id: approval[0], approved: true })).rejects.toThrow('already resolved or submitted');
        f.permissions.close();
    });
    it('declines MCP tool approval but does not invent answers to a real user question', async () => {
        const f = fixture(() => true);
        f.permissions.receive({ id: 7, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', serverName: 'external', request: {
            mode: 'form', message: 'Allow?', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call' }
        } } });
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledWith(7, expect.objectContaining({ action: 'decline' })));
        expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
        f.permissions.receive(f.request);
        expect(Object.keys(f.state().requests ?? {})).toHaveLength(1);
        f.permissions.close();
    });
});


describe('explicit full automation authorization', () => {
    it.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestApproval', 'item/permissions/requestApproval'])('automatically grants %s exactly once with no visible card', async method => {
        const f = fixture(() => true, () => true);
        const permissions = { network: { enabled: true } };
        const request = { id: 88, method, params: { threadId: 'thread', itemId: 'authorized', permissions } };
        f.permissions.receive(request); f.permissions.receive(request);
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledTimes(1));
        expect(f.respond).toHaveBeenCalledWith(88, method === 'item/permissions/requestApproval' ? { permissions, scope: 'turn' } : { decision: 'accept' });
        expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
        f.permissions.close();
    });
    it('auto-approves a genuine MCP tool operation without requesting user input', async () => {
        const f = fixture(() => true, () => true);
        f.permissions.receive({ id: 9, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', serverName: 'external', request: {
            mode: 'form', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call' }
        } } });
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledWith(9, expect.objectContaining({ action: 'accept' })));
        expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
        f.permissions.close();
    });
});
