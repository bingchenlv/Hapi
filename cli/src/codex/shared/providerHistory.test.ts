import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { providerHistorySnapshot } from './providerHistory';

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const metadata = (id: string, extra = {}) => ({ type: 'session_meta', payload: { id, timestamp: '2026-10-18T00:00:00Z', history_mode: 'paginated', ...extra } });
const item = (payload: Record<string, unknown>) => ({ type: 'response_item', payload });
const encode = (entries: unknown[]) => entries.map(entry => JSON.stringify(entry) + '\n').join('');
async function setup() { const home = await mkdtemp('/tmp/hapi-provider-history-unit-'); homes.push(home); return home; }

describe('private provider history snapshots', () => {
    it('removes opaque OpenAI reasoning for a plaintext-only provider while preserving messages and sources', async () => {
        const home = await setup(); const source = join(home, 'source.jsonl');
        const original = encode([metadata('source'),
            item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'KEEP TASK' }] }),
            item({ type: 'reasoning', summary: [], encrypted_content: 'OPENAI_ONLY_CIPHER' }),
            item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'KEEP ANSWER' }] })]);
        await writeFile(source, original);
        const snapshot = (await providerHistorySnapshot(home, 'source', source, async () => '', { dropAllReasoning: true }))!;
        expect(snapshot.removedReasoning).toBe(1);
        const copied = await readFile(snapshot.path, 'utf8');
        expect(copied).not.toContain('OPENAI_ONLY_CIPHER');
        expect(copied).toContain('KEEP TASK'); expect(copied).toContain('KEEP ANSWER');
        expect(await readFile(source, 'utf8')).toBe(original);
        await snapshot.dispose();
    });
    it('names an invalid record instead of surfacing a bare parse error', async () => {
        const home = await setup(); const source = join(home, 'source.jsonl');
        await writeFile(source, encode([metadata('source')]) + '{"broken":\n');
        await expect(providerHistorySnapshot(home, 'source', source, async () => '')).rejects.toThrow('invalid record');
    });

    it('preserves long Unicode records across byte chunks and an exact ancestor prefix', async () => {
        const home = await setup(); const parent = join(home, 'parent.jsonl'); const source = join(home, 'source.jsonl');
        const result = item({ type: 'function_call_output', call_id: 'long-result',
            output: '中文🙂𠮷'.repeat(80_000) + 'A\u2028B\u2029C\n"quoted"\\tail' });
        const prefix = encode([metadata('parent'), result]);
        const parentBytes = prefix + encode([item({ type: 'message', role: 'user', content: ['OUTSIDE PREFIX'] })]);
        const own = encode([metadata('source', { history_base: { thread_id: 'parent', end_ordinal_exclusive: 2,
            end_byte_offset: Buffer.byteLength(prefix) } }),
            item({ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'FOREIGN' }] }),
            item({ type: 'message', role: 'assistant', content: ['RETAINED'] })]);
        await writeFile(parent, parentBytes); await writeFile(source, own);
        const snapshot = (await providerHistorySnapshot(home, 'source', source, async () => parent))!;
        const rows = (await readFile(snapshot.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(rows[1].payload).toEqual(result.payload);
        expect(rows.map(row => row.ordinal)).toEqual([0, 1, 2]);
        expect(rows[2].payload.content).toEqual(['RETAINED']);
        expect(await readFile(parent, 'utf8')).toBe(parentBytes);
        expect(await readFile(source, 'utf8')).toBe(own);
        await snapshot.dispose();
    });

    it('materializes only inherited prefixes, preserves tool pairs and valid OpenAI data, and leaves sources byte-identical', async () => {
        const home = await setup();
        const parent = join(home, 'parent.jsonl'); const source = join(home, 'source.jsonl');
        const retained = [item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ORIGINAL TASK' }] }),
            item({ type: 'reasoning', summary: [], encrypted_content: 'VALID_OPENAI_CIPHER' }),
            item({ type: 'function_call', call_id: 'call1', name: 'run', arguments: '{}' }),
            item({ type: 'function_call_output', call_id: 'call1', output: 'ALREADY EXECUTED' })];
        const prefix = encode([metadata('parent'), ...retained]);
        const full = prefix + encode([item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'LATER PARENT TURN' }] })]);
        const own = encode([metadata('source', { history_base: { thread_id: 'parent', end_ordinal_exclusive: 5, end_byte_offset: Buffer.byteLength(prefix) } }),
            item({ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'FOREIGN' }], encrypted_content: 'MINI_CIPHER' }),
            item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'MINIMAX RESULT' }] })]);
        await writeFile(parent, full); await writeFile(source, own);
        const snapshot = (await providerHistorySnapshot(home, 'source', source, async id => { expect(id).toBe('parent'); return parent; }))!;
        expect(snapshot.removedReasoning).toBe(1);
        const text = await readFile(snapshot.path, 'utf8'); const entries = text.trim().split('\n').map(line => JSON.parse(line));
        expect(entries[0].payload).toMatchObject({ history_mode: 'paginated' });
        expect(entries[0].payload.id).not.toBe('source');
        expect(entries[0].payload.session_id).toBe(entries[0].payload.id);
        expect(entries[0].payload.history_base).toBeUndefined();
        expect(entries.slice(1, 5).map(({ ordinal: _ordinal, ...entry }) => entry)).toEqual(retained);
        expect(entries.map(entry => entry.ordinal)).toEqual(entries.map((_, index) => index));
        expect(text).toContain('MINIMAX RESULT'); expect(text).toContain('VALID_OPENAI_CIPHER');
        expect(text).not.toContain('MINI_CIPHER'); expect(text).not.toContain('LATER PARENT TURN');
        expect(await readFile(parent, 'utf8')).toBe(full); expect(await readFile(source, 'utf8')).toBe(own);
        expect((await stat(snapshot.path)).mode & 0o777).toBe(0o600);
        await snapshot.dispose(); expect(await readdir(join(home, 'sessions', 'hapi-provider-history'))).toEqual([]);
    });
    it('filters incompatible reasoning inside compaction replacements while retaining aligned metadata and encrypted compaction', async () => {
        const home = await setup(); const source = join(home, 'source.jsonl');
        await writeFile(source, encode([metadata('source'), { type: 'compacted', payload: { message: 'SUMMARY', replacement_history: [
            { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'FOREIGN' }], encrypted_content: 'MINI' },
            { type: 'compaction', encrypted_content: 'VALID_OPENAI_COMPACTION' }
        ], replacement_history_metadata: ['reasoning metadata', 'compaction metadata'] } }]));
        const snapshot = (await providerHistorySnapshot(home, 'source', source, async () => { throw new Error('Unexpected ancestor'); }))!;
        const entry = JSON.parse((await readFile(snapshot.path, 'utf8')).trim().split('\n')[1]);
        expect(entry.payload.replacement_history).toEqual([{ type: 'compaction', encrypted_content: 'VALID_OPENAI_COMPACTION' }]);
        expect(entry.payload.replacement_history_metadata).toEqual(['compaction metadata']);
        await snapshot.dispose();
    });
    it('keeps the normal native fork when no incompatible reasoning exists', async () => {
        const home = await setup(); const source = join(home, 'source.jsonl');
        await writeFile(source, encode([metadata('source'), item({ type: 'message', role: 'user', content: [] })]));
        expect(await providerHistorySnapshot(home, 'source', source, async () => '')).toBeUndefined();
        expect(await readdir(join(home, 'sessions', 'hapi-provider-history'))).toEqual([]);
    });
    it('fails closed on cyclic ancestry, incorrect identity, and a byte boundary inside a record', async () => {
        const home = await setup(); const source = join(home, 'source.jsonl'); const parent = join(home, 'parent.jsonl');
        await writeFile(source, encode([metadata('source', { history_base: { thread_id: 'source', end_ordinal_exclusive: 1 } })]));
        await expect(providerHistorySnapshot(home, 'source', source, async () => source)).rejects.toThrow('cycle');
        await expect(providerHistorySnapshot(home, 'other', source, async () => source)).rejects.toThrow('identity');
        const prefix = encode([metadata('parent')]);
        await writeFile(parent, prefix + encode([item({ type: 'message', role: 'user', content: [] })]));
        await writeFile(source, encode([metadata('source', { history_base: { thread_id: 'parent', end_ordinal_exclusive: 1, end_byte_offset: Buffer.byteLength(prefix) - 1 } })]));
        await expect(providerHistorySnapshot(home, 'source', source, async () => parent)).rejects.toThrow('boundaries disagree');
    });
});

describe('lossless native journal snapshots', () => {
    it('retains exact item fields, fresh identity, canonical filename and durable ancestry', async () => {
        const home = await setup(); const source = join(home, 'source.jsonl');
        const items = [
            { type: 'CommandExecution', id: 'command', status: 'failed', exit_code: 7, stdout: 'out', stderr: 'err' },
            { type: 'McpToolCall', id: 'mcp', status: 'failed', error: { message: 'failure' },
                result: { content: [{ type: 'image', data: 'LOCAL_ONLY' }], structuredContent: { n: 1 }, _meta: { keep: true } } },
            { type: 'FileChange', id: 'patch', status: 'declined', changes: { '/tmp/file': { type: 'add', content: 'data' } } },
            { type: 'FutureNativeType', id: 'future', status: 'cancelled', original: true }
        ];
        const original = encode([metadata('source'),
            item({ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'FOREIGN' }] }),
            ...items.map(value => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'source', turn_id: 'turn', item: value } }))
        ]);
        await writeFile(source, original);
        const snapshot = (await providerHistorySnapshot(home, 'source', source, async () => ''))!;
        const copied = await readFile(snapshot.path, 'utf8');
        const rows = copied.trim().split('\n').map(line => JSON.parse(line));
        expect(snapshot.path).toMatch(/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9-]{36}\.jsonl$/);
        expect(rows.slice(1).map(row => row.payload.item)).toEqual(items);
        expect(rows.slice(1).every(row => row.payload.thread_id === rows[0].payload.id)).toBe(true);
        expect(await readFile(source, 'utf8')).toBe(original);
        snapshot.retain(); await snapshot.dispose();
        expect(await readFile(snapshot.path, 'utf8')).toBe(copied);
    });
});
