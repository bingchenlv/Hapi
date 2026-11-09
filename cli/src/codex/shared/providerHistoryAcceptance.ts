import { createHash } from 'node:crypto';
import { record, string } from './gateway';

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
    return value;
}

/** No content in errors/logs. Native output, not serialized event presence, is
 * the acceptance oracle. Provider-specific reasoning is intentionally removed. */
export function assertProviderHistoryPreserved(before: Record<string, unknown>, after: Record<string, unknown>): void {
    const fingerprint = (turns: unknown) => (Array.isArray(turns) ? turns : []).flatMap(value => {
        const turn = record(value);
        const items = (Array.isArray(turn.items) ? turn.items : []).map(record).filter(item => item.type !== 'reasoning');
        // Empty completed/reasoning-only turns have no retained visible content.
        // Failed/interrupted turns still carry outcome semantics without items.
        const hasOutcome = turn.status === 'failed' || turn.status === 'interrupted' || turn.error != null;
        return items.length || hasOutcome ? [{ id: string(turn.id), status: turn.status,
            error: canonical(turn.error ?? null), items: items.map(item =>
            createHash('sha256').update(JSON.stringify(canonical(item))).digest('hex')) }] : [];
    });
    if (JSON.stringify(fingerprint(before.turns)) !== JSON.stringify(fingerprint(after.turns))) {
        throw new Error('Provider history semantic verification failed; switch is quarantined, original history preserved');
    }
}
