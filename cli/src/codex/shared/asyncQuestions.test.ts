import { describe, expect, it, vi } from 'vitest';
import type { AgentState } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { SharedCodexPermissions } from './permissions';
import { asyncQuestionId, SharedCodexAsyncQuestions } from './asyncQuestions';

const item = { type: 'agentMessage', id: 'ask-1', text: '', delivery: 'async',
    questions: [{ title: 'Choose a destination', options: ['Beijing', 'Shanghai'] }, { title: 'Any notes?', options: null }] };
const params = { threadId: 'thread', turnId: 'turn', item };
const id = asyncQuestionId('thread', item.id);
const answer = { id, approved: true, answers: { question_0: { answers: ['Shanghai'] }, question_1: { answers: ['With family'] } } };

function fixture() {
    let state: AgentState = { requests: { unrelated: { tool: 'Bash', arguments: {}, createdAt: 1 } } };
    const send = vi.fn(); const submit = vi.fn(async () => {});
    const session = { getMetadata: () => ({ codexSessionId: 'thread' }), sendAgentMessage: send,
        updateAgentState: (fn: (s: AgentState) => AgentState) => { state = fn(state); } } as unknown as ApiSessionClient;
    const questions = new SharedCodexAsyncQuestions(session, submit);
    return { questions, send, submit, session, state: () => state };
}

describe('native asynchronous questions', () => {
    it('renders choices and free text from a completed agent message without a server request', () => {
        const f = fixture(); f.questions.observe('item/started', params);
        expect(f.send).not.toHaveBeenCalled();
        f.questions.observe('item/completed', params); f.questions.observe('item/completed', params);
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(f.state().requests?.[id]).toMatchObject({ tool: 'request_user_input', toolCallId: id,
            arguments: { isBlocking: false, questions: [
                { id: 'question_0', question: 'Choose a destination', isOther: true,
                    options: [{ label: 'Beijing' }, { label: 'Shanghai' }] },
                { id: 'question_1', question: 'Any notes?', options: [], isOther: false }
            ] } });
    });

    it('submits through the permission RPC as a normal native user message, never a JSON-RPC answer', async () => {
        const f = fixture(); const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
        Object.assign(f.session, { rpcHandlerManager: { registerHandler: (key: string, fn: (raw: unknown) => Promise<unknown>) => handlers.set(key, fn) } });
        const respond = vi.fn();
        new SharedCodexPermissions(f.session, { respond } as unknown as CodexAppServerClient, 'g', f.questions);
        f.questions.observe('item/completed', params);
        await handlers.get('permission')!(answer);
        expect(f.submit).toHaveBeenCalledWith('thread', `${id}:answer`, 'Choose a destination\nShanghai\n\nAny notes?\nWith family');
        expect(respond).not.toHaveBeenCalled();
        expect(f.state().requests?.[id]).toBeDefined(); // acceptance is not consumption
        await expect(f.questions.reply(answer)).rejects.toThrow('already resolved or submitted');
        f.questions.observe('item/completed', { threadId: 'thread', item: { type: 'userMessage', id: 'reply', clientId: `${id}:answer` } });
        expect(f.state().requests?.[id]).toBeUndefined();
        expect(f.state().completedRequests?.[id]?.status).toBe('resolved');
        expect(f.state().requests?.unrelated).toBeDefined();
    });

    it('requires every answer and permits retry after an explicitly failed send using the same submission ID', async () => {
        const f = fixture(); f.questions.observe('item/completed', params);
        await expect(f.questions.reply({ ...answer, answers: { question_0: ['Beijing'] } })).rejects.toThrow('Missing answer');
        await expect(f.questions.reply({ ...answer, answers: { question_0: [], question_1: [''] } })).rejects.toThrow('Missing answer');
        expect(f.submit).not.toHaveBeenCalled();
        f.submit.mockRejectedValueOnce(new Error('offline'));
        await expect(f.questions.reply(answer)).rejects.toThrow('offline');
        await f.questions.reply(answer);
        expect(f.submit.mock.calls[0]).toEqual(f.submit.mock.calls[1]);
    });

    it('replays questions during an active turn and does not let earlier history clear a live card', () => {
        const f = fixture(); f.questions.observe('item/completed', params);
        const history = { id: 'thread', turns: [{ id: 'turn', status: 'inProgress', items: [
            { type: 'userMessage', id: 'old', clientId: 'old' }, item
        ] }] };
        f.questions.history(history);
        expect(f.questions.has(id)).toBe(true);
        const fresh = fixture(); fresh.questions.history(history);
        expect(fresh.state().requests?.[id]).toBeDefined();
        expect(fresh.send).toHaveBeenCalledTimes(1);
    });

    it('reconstructs answered and superseded cards without resurrecting them on refresh', () => {
        for (const clientId of [`${id}:answer`, 'unrelated-followup']) {
            const f = fixture();
            const history = { id: 'thread', turns: [{ items: [item, { type: 'userMessage', id: 'next', clientId }] }] };
            f.questions.history(history); f.questions.history(history);
            expect(f.questions.has(id)).toBe(false);
            expect(f.state().completedRequests?.[id]?.status).toBe(clientId === `${id}:answer` ? 'resolved' : 'canceled');
            expect(f.send).toHaveBeenCalledTimes(2);
        }
    });

    it('keeps child questions and answers attached to their originating thread', async () => {
        const f = fixture(); f.questions.observe('item/completed', { ...params, threadId: 'child' });
        expect(f.send.mock.calls[0][0]).toMatchObject({ type: 'agent-run-trace', agentId: 'child',
            message: { name: 'request_user_input' }, scope: { role: 'child', parentThreadId: 'thread' } });
        f.questions.observe('item/completed', { threadId: 'sibling', item: { type: 'userMessage', id: 'u' } });
        await f.questions.reply({ ...answer, id: asyncQuestionId('child', item.id) });
        expect(f.submit).toHaveBeenCalledWith('child', expect.any(String), expect.any(String));
    });

    it('ignores malformed questions and ordinary messages', () => {
        const f = fixture();
        for (const questions of [null, [], [{ title: '' }], [{ question: 'old format' }]]) {
            f.questions.observe('item/completed', { ...params, item: { ...item, questions } });
        }
        expect(f.send).not.toHaveBeenCalled();
    });

    it('withdraws only its own requests on disconnect, so native history can restore them', () => {
        const f = fixture(); f.questions.observe('item/completed', params); f.questions.close();
        expect(f.state().requests?.[id]).toBeUndefined();
        expect(f.state().requests?.unrelated).toBeDefined();
        expect(f.state().completedRequests?.[id]).toBeUndefined();
    });

    it('clears cold-bind cancellation so the Web reducer can render a restored pending question', () => {
        const f = fixture();
        f.session.updateAgentState(state => ({ ...state, completedRequests: {
            [id]: { tool: 'request_user_input', arguments: {}, createdAt: 1, completedAt: 2, status: 'canceled' }
        } }));
        f.questions.history({ id: 'thread', turns: [{ items: [item] }] });
        expect(f.state().requests?.[id]).toBeDefined();
        expect(f.state().completedRequests?.[id]).toBeUndefined();
    });
});
