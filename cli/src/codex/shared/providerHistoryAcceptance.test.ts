import { describe, expect, it } from 'vitest';
import { assertProviderHistoryPreserved } from './providerHistoryAcceptance';

describe('provider history semantic acceptance', () => {
    const failed = { type: 'mcpToolCall', id: 'call', status: 'failed', result: { structuredContent: { answer: 42 } } };
    const thread = (items: unknown[]) => ({ turns: [{ id: 'turn', items }] });
    it('accepts object key reordering and deliberate removal of provider reasoning', () => {
        expect(() => assertProviderHistoryPreserved(thread([failed, { type: 'reasoning', content: ['private'] }]),
            thread([{ result: failed.result, status: 'failed', id: 'call', type: 'mcpToolCall' }]))).not.toThrow();
    });
    it('rejects dropped items, fake success, altered output and duplicate replay', () => {
        for (const items of [[], [{ ...failed, status: 'completed' }], [{ ...failed, result: null }], [failed, failed]]) {
            expect(() => assertProviderHistoryPreserved(thread([failed]), thread(items))).toThrow('semantic verification failed');
        }
    });
    it('checks the original turn association', () => {
        expect(() => assertProviderHistoryPreserved(thread([failed]), { turns: [{ id: 'other', items: [failed] }] })).toThrow();
    });
    it('rejects an interrupted or failed turn rewritten as completed', () => {
        for (const status of ['interrupted', 'failed']) {
            const before = { turns: [{ id: 'turn', status, error: null, items: [failed] }] };
            const after = { turns: [{ ...before.turns[0], status: 'completed' }] };
            expect(() => assertProviderHistoryPreserved(before, after)).toThrow('semantic verification failed');
        }
    });
    it('rejects lost or altered native turn errors', () => {
        const before = { turns: [{ id: 'turn', status: 'failed', items: [failed],
            error: { message: 'native failure', codexErrorInfo: 'other', additionalDetails: 'details' } }] };
        for (const error of [null, { ...before.turns[0].error, message: 'different' }]) {
            expect(() => assertProviderHistoryPreserved(before, { turns: [{ ...before.turns[0], error }] }))
                .toThrow('semantic verification failed');
        }
    });
    it('retains empty failed and interrupted turns in the acceptance oracle', () => {
        for (const status of ['failed', 'interrupted']) {
            const before = { turns: [{ id: 'empty', status, error: null, items: [] }] };
            expect(() => assertProviderHistoryPreserved(before, before)).not.toThrow();
            expect(() => assertProviderHistoryPreserved(before, { turns: [] })).toThrow('semantic verification failed');
        }
    });
    it('allows removed reasoning-only completed turns and reordered error keys', () => {
        const error = { message: 'native failure', codexErrorInfo: 'other' };
        const turn = { id: 'visible', status: 'failed', error, items: [failed] };
        const before = { turns: [{ id: 'private', status: 'completed', items: [{ type: 'reasoning' }] }, turn] };
        const after = { turns: [{ ...turn, error: { codexErrorInfo: 'other', message: 'native failure' } }] };
        expect(() => assertProviderHistoryPreserved(before, after)).not.toThrow();
    });
});
