import { describe, expect, it, vi } from 'vitest';
import { describeRetirementFailure, createRetirementStore, retireProviderThread } from './providerRetirement';

describe('independent retirement failure and durability checks', () => {
    it.each([
        { api_key: 'SYNTHETIC_PRIVATE_VALUE' },
        new Error('{"access_token":"SYNTHETIC_PRIVATE_VALUE"}'),
        new Error("password='SYNTHETIC PRIVATE VALUE'"),
    ])('redacts structured or quoted credentials before persistence/notices', error => {
        const text = describeRetirementFailure(error);
        expect(text).not.toContain('SYNTHETIC_PRIVATE_VALUE');
        expect(text).not.toContain('SYNTHETIC PRIVATE VALUE');
    });
    it('an in-flight durable intent excludes concurrent archive attempts', async () => {
        const store = createRetirementStore(undefined, () => {});
        let release!: () => void;
        const durable = new Promise<void>(resolve => { release = resolve; });
        const archive = vi.fn(async () => {});
        const options = { threadId: 'old', sessionId: 'owner', store, archive, persist: () => durable };
        const first = retireProviderThread(options);
        const second = await retireProviderThread(options);
        expect(second).toMatchObject({ status: 'requested', attempted: false });
        expect(archive).not.toHaveBeenCalled(); release();
        expect(await first).toMatchObject({ status: 'archived', attempted: true, persisted: true });
        expect(archive).toHaveBeenCalledTimes(1);
    });
});
