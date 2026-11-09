import type { CodexRateLimits, CodexRateLimitWindow } from '@hapi/protocol/types';

type RateLimitsPatch = {
    clear: boolean;
    recognized: boolean;
    primaryPresent: boolean;
    primary?: CodexRateLimitWindow | null;
    secondaryPresent: boolean;
    secondary?: CodexRateLimitWindow | null;
    planTypePresent: boolean;
    planType?: string;
    limitIdPresent: boolean;
    limitId?: string;
    limitNamePresent: boolean;
    limitName?: string | null;
};

type PublishRateLimits = (value: CodexRateLimits | undefined) => void;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function asNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function readField(record: Record<string, unknown>, camel: string, snake: string): {
    present: boolean;
    value: unknown;
} {
    if (camel in record) return { present: true, value: record[camel] };
    if (snake in record) return { present: true, value: record[snake] };
    return { present: false, value: undefined };
}

function normalizeResetAt(value: unknown): number | undefined {
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            const parsed = Date.parse(value);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
        }
        value = numeric;
    }
    const numeric = asFiniteNumber(value);
    if (numeric === null || numeric <= 0) return undefined;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function normalizeWindow(value: unknown): CodexRateLimitWindow | null | undefined {
    if (value === null) return null;
    const record = asRecord(value);
    if (!record) return undefined;
    const usedPercent = asFiniteNumber(record.usedPercent ?? record.used_percent);
    const windowDurationMins = asFiniteNumber(record.windowDurationMins ?? record.window_duration_mins);
    if (usedPercent === null || windowDurationMins === null || windowDurationMins <= 0) return undefined;
    const resetsAt = normalizeResetAt(record.resetsAt ?? record.resets_at);
    return {
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        windowDurationMins,
        ...(resetsAt !== undefined ? { resetsAt } : {})
    };
}

function extractMainRateLimits(value: unknown): { recognized: boolean; value: unknown } {
    const record = asRecord(value);
    if (!record) return { recognized: value === null, value };

    const byLimitIdField = readField(record, 'rateLimitsByLimitId', 'rate_limits_by_limit_id');
    const byLimitId = asRecord(byLimitIdField.value);
    if (byLimitId && byLimitId.codex !== null && byLimitId.codex !== undefined) {
        return { recognized: true, value: byLimitId.codex };
    }

    const direct = readField(record, 'rateLimits', 'rate_limits');
    if (direct.present) return { recognized: true, value: direct.value };

    // Notification payloads in older app-server builds may already be the
    // snapshot rather than wrapping it in { rateLimits }.
    const looksLikeSnapshot = ['primary', 'secondary', 'planType', 'plan_type', 'limitId', 'limit_id']
        .some(key => key in record);
    return { recognized: looksLikeSnapshot, value: looksLikeSnapshot ? record : undefined };
}

export function normalizeCodexRateLimitsPatch(value: unknown): RateLimitsPatch {
    const extracted = extractMainRateLimits(value);
    if (!extracted.recognized) {
        return {
            clear: false,
            recognized: false,
            primaryPresent: false,
            secondaryPresent: false,
            planTypePresent: false,
            limitIdPresent: false,
            limitNamePresent: false
        };
    }
    if (extracted.value === null) {
        return {
            clear: true,
            recognized: true,
            primaryPresent: false,
            secondaryPresent: false,
            planTypePresent: false,
            limitIdPresent: false,
            limitNamePresent: false
        };
    }

    const record = asRecord(extracted.value);
    if (!record) return normalizeCodexRateLimitsPatch(undefined);
    const primary = readField(record, 'primary', 'primary');
    const secondary = readField(record, 'secondary', 'secondary');
    const planType = readField(record, 'planType', 'plan_type');
    const limitId = readField(record, 'limitId', 'limit_id');
    const limitName = readField(record, 'limitName', 'limit_name');
    return {
        clear: false,
        recognized: true,
        primaryPresent: primary.present,
        primary: normalizeWindow(primary.value),
        secondaryPresent: secondary.present,
        secondary: normalizeWindow(secondary.value),
        planTypePresent: planType.present,
        planType: asNonEmptyString(planType.value),
        limitIdPresent: limitId.present,
        limitId: asNonEmptyString(limitId.value),
        limitNamePresent: limitName.present,
        limitName: limitName.value === null ? null : asNonEmptyString(limitName.value)
    };
}

function applyPatch(
    current: CodexRateLimits | undefined,
    patch: RateLimitsPatch,
    now: number,
    fullSnapshot: boolean
): CodexRateLimits | undefined {
    if (!patch.recognized) return current;
    if (patch.clear) return undefined;

    const next: CodexRateLimits = fullSnapshot
        ? { updatedAt: now }
        : { ...current, updatedAt: now };
    if (patch.primaryPresent && patch.primary !== undefined) next.primary = patch.primary;
    if (patch.secondaryPresent && patch.secondary !== undefined) next.secondary = patch.secondary;
    if (patch.planTypePresent) {
        if (patch.planType === undefined) delete next.planType;
        else next.planType = patch.planType;
    }
    if (patch.limitIdPresent) {
        if (patch.limitId === undefined) delete next.limitId;
        else next.limitId = patch.limitId;
    }
    if (patch.limitNamePresent) {
        if (patch.limitName === undefined) delete next.limitName;
        else next.limitName = patch.limitName;
    }
    return next;
}

function sameLimits(left: CodexRateLimits | undefined, right: CodexRateLimits | undefined): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return JSON.stringify({ ...left, updatedAt: 0 }) === JSON.stringify({ ...right, updatedAt: 0 });
}

/** Keeps account-level limit updates out of the chat/token event stream. */
export class CodexRateLimitsTracker {
    private current: CodexRateLimits | undefined;
    private notificationRevision = 0;
    private readonly recentNotifications: Array<{ revision: number; patch: RateLimitsPatch }> = [];

    constructor(
        initial: CodexRateLimits | undefined,
        private readonly publish: PublishRateLimits,
        private readonly now: () => number = Date.now
    ) {
        this.current = initial;
    }

    acceptNotification(value: unknown): void {
        const patch = normalizeCodexRateLimitsPatch(value);
        if (!patch.recognized) return;
        const revision = ++this.notificationRevision;
        this.recentNotifications.push({ revision, patch });
        if (this.recentNotifications.length > 100) this.recentNotifications.shift();
        this.commit(applyPatch(this.current, patch, this.now(), false), false);
    }

    async refresh(read: () => Promise<unknown>): Promise<void> {
        const startRevision = this.notificationRevision;
        const response = await read();
        const patch = normalizeCodexRateLimitsPatch(response);
        if (!patch.recognized) return;

        let next = applyPatch(undefined, patch, this.now(), true);
        for (const notification of this.recentNotifications) {
            if (notification.revision > startRevision) {
                next = applyPatch(next, notification.patch, this.now(), false);
            }
        }
        this.commit(next, true);
    }

    private commit(next: CodexRateLimits | undefined, forceFreshness: boolean): void {
        if (!forceFreshness && sameLimits(this.current, next)) return;
        this.current = next;
        this.publish(next);
    }
}
