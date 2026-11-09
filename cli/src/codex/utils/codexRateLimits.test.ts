import { describe, expect, it, vi } from 'vitest';
import type { CodexRateLimits } from '@hapi/protocol/types';
import { CodexRateLimitsTracker, normalizeCodexRateLimitsPatch } from './codexRateLimits';

describe('normalizeCodexRateLimitsPatch', () => {
    it('selects the Codex bucket and normalizes seconds to milliseconds', () => {
        const patch = normalizeCodexRateLimitsPatch({
            rateLimits: { primary: { usedPercent: 99, windowDurationMins: 60 } },
            rateLimitsByLimitId: {
                codex_other: { primary: { usedPercent: 88, windowDurationMins: 60 } },
                codex: {
                    limitId: 'codex',
                    planType: 'plus',
                    primary: { usedPercent: 42.4, windowDurationMins: 300, resetsAt: 1_800_000_000 },
                    secondary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: 1_800_100_000 }
                }
            }
        });

        expect(patch).toMatchObject({
            recognized: true,
            limitId: 'codex',
            planType: 'plus',
            primary: { usedPercent: 42.4, windowDurationMins: 300, resetsAt: 1_800_000_000_000 },
            secondary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: 1_800_100_000_000 }
        });
    });

    it('accepts snake_case, clamps percentages, and ignores malformed windows', () => {
        expect(normalizeCodexRateLimitsPatch({
            rate_limits: {
                primary: { used_percent: 104, window_duration_mins: 300, resets_at: '2030-01-01T00:00:00Z' },
                secondary: { used_percent: 'bad', window_duration_mins: 10_080 }
            }
        })).toMatchObject({
            primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Date.parse('2030-01-01T00:00:00Z') },
            secondary: undefined
        });
    });

    it('does not treat unrelated account payloads as rate-limit updates', () => {
        expect(normalizeCodexRateLimitsPatch({ account: { type: 'chatgpt' } }).recognized).toBe(false);
    });
});

describe('CodexRateLimitsTracker', () => {
    const initial: CodexRateLimits = {
        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2_000_000_000_000 },
        secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: 3_000_000_000_000 },
        planType: 'plus',
        updatedAt: 1_000
    };

    it('merges partial notifications without dropping the other window', () => {
        const publish = vi.fn();
        const tracker = new CodexRateLimitsTracker(initial, publish, () => 4_000);

        tracker.acceptNotification({
            rateLimits: { primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 5_000 } }
        });

        expect(publish).toHaveBeenCalledWith({
            ...initial,
            primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 5_000_000 },
            updatedAt: 4_000
        });
    });

    it('replays a notification that arrives while the initial read is pending', async () => {
        let resolveRead!: (value: unknown) => void;
        const read = new Promise<unknown>(resolve => { resolveRead = resolve; });
        const publish = vi.fn();
        const tracker = new CodexRateLimitsTracker(undefined, publish, () => 7_000);
        const refresh = tracker.refresh(() => read);

        tracker.acceptNotification({
            rateLimits: { secondary: { usedPercent: 48, windowDurationMins: 10_080 } }
        });
        resolveRead({
            rateLimits: {
                primary: { usedPercent: 12, windowDurationMins: 300 },
                secondary: { usedPercent: 40, windowDurationMins: 10_080 }
            }
        });
        await refresh;

        expect(publish).toHaveBeenLastCalledWith({
            primary: { usedPercent: 12, windowDurationMins: 300 },
            secondary: { usedPercent: 48, windowDurationMins: 10_080 },
            updatedAt: 7_000
        });
    });

    it('deduplicates identical notifications but refreshes snapshot freshness', async () => {
        const publish = vi.fn();
        const tracker = new CodexRateLimitsTracker(initial, publish, () => 9_000);
        tracker.acceptNotification({ rateLimits: { primary: initial.primary } });
        expect(publish).not.toHaveBeenCalled();

        await tracker.refresh(async () => ({ rateLimits: {
            primary: initial.primary,
            secondary: initial.secondary,
            planType: 'plus'
        } }));
        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith({ ...initial, updatedAt: 9_000 });
    });

    it('clears a previous snapshot when the server explicitly returns null', async () => {
        const publish = vi.fn();
        const tracker = new CodexRateLimitsTracker(initial, publish, () => 10_000);
        await tracker.refresh(async () => ({ rateLimits: null }));
        expect(publish).toHaveBeenCalledWith(undefined);
    });
});
