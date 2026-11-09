import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './schemas';

describe('MetadataSchema cursorSessionProtocol', () => {
    const base = {
        path: '/tmp',
        host: 'test'
    };

    it('accepts acp and stream-json protocol values', () => {
        expect(MetadataSchema.safeParse({ ...base, cursorSessionProtocol: 'acp' }).success).toBe(true);
        expect(MetadataSchema.safeParse({ ...base, cursorSessionProtocol: 'stream-json' }).success).toBe(true);
    });

    it('rejects unknown protocol values', () => {
        expect(MetadataSchema.safeParse({ ...base, cursorSessionProtocol: 'websocket' }).success).toBe(false);
    });

    it('persists the original OpenAI reviewer across a MiniMax provider switch', () => {
        const route = { provider: 'minimax', reason: 'usage-limit', status: 'active',
            failedTurnId: 'quota', openaiApprovalsReviewer: 'auto_review', updatedAt: 1 };
        const parsed = MetadataSchema.parse({ ...base, modelRouting: route });
        expect(parsed.modelRouting).toEqual(route);
        expect(MetadataSchema.safeParse({ ...base, modelRouting: { ...route, openaiApprovalsReviewer: 'never' } }).success).toBe(false);
    });

    it('persists Pi native history entry ids', () => {
        const result = MetadataSchema.safeParse({
            ...base,
            conversationHistoryEntryIds: { 'local-user-id': 'pi-entry-id' },
        });
        expect(result.success).toBe(true);
        expect(result.data?.conversationHistoryEntryIds).toEqual({ 'local-user-id': 'pi-entry-id' });
    });
});

describe('MetadataSchema codexRateLimits', () => {
    const base = { path: '/tmp/project', host: 'test-host' };

    it('accepts bounded account rate-limit metadata', () => {
        expect(MetadataSchema.safeParse({
            ...base,
            codexRateLimits: {
                primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000_000 },
                secondary: { usedPercent: 18, windowDurationMins: 10_080 },
                updatedAt: 1_700_000_000_000
            }
        }).success).toBe(true);
    });

    it('rejects percentages outside the displayable range', () => {
        expect(MetadataSchema.safeParse({
            ...base,
            codexRateLimits: {
                primary: { usedPercent: 101, windowDurationMins: 300 },
                updatedAt: 1_700_000_000_000
            }
        }).success).toBe(false);
    });
});
