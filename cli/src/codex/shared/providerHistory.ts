import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { record, string } from './gateway';

// Keep JSONL framing in bytes. Native rollouts can contain very long Unicode
// tool results; decode only complete records, independently of read chunks or
// the runtime's readline implementation. Reads are bounded to the captured
// prefix and every early return closes the descriptor. The raw byte length of
// each record travels with it so boundaries are checked against the file, not
// against a re-encoding of the decoded text.
type HistoryLine = { text: string; bytes: number; terminated: boolean };
async function* historyLines(path: string, bytes?: number): AsyncGenerator<HistoryLine> {
    const input = await open(path, 'r');
    const parts: Buffer[] = [];
    let position = 0;
    try {
        while (bytes === undefined || position < bytes) {
            const chunk = Buffer.allocUnsafe(bytes === undefined ? 64 * 1024 : Math.min(64 * 1024, bytes - position));
            const { bytesRead } = await input.read(chunk, 0, chunk.length, position);
            if (!bytesRead) break;
            position += bytesRead;
            let start = 0;
            for (let end = chunk.indexOf(10, start); end >= 0 && end < bytesRead; end = chunk.indexOf(10, start)) {
                parts.push(chunk.subarray(start, end));
                const line = Buffer.concat(parts);
                yield { text: line.toString('utf8'), bytes: line.length, terminated: true };
                parts.length = 0;
                start = end + 1;
            }
            if (start < bytesRead) parts.push(chunk.subarray(start, bytesRead));
        }
        if (parts.length) {
            const line = Buffer.concat(parts);
            yield { text: line.toString('utf8'), bytes: line.length, terminated: false };
        }
    } finally { await input.close(); }
}

function parseHistoryRecord(text: string): Record<string, unknown> {
    try {
        return record(JSON.parse(text));
    } catch {
        // A truncated or invalid record is a history defect, not a bug report
        // about this parser. Name it so the failure is actionable.
        throw new Error('Provider history contains an invalid record');
    }
}

type Segment = { path: string; id: string; bytes: number; byteBounded: boolean; lines?: number; inherited: number; meta: Record<string, unknown> };
export type ProviderHistorySnapshot = {
    path: string;
    removedReasoning: number;
    /** A successful/uncertain native fork may reference this immutable prefix. */
    retain(): void;
    dispose(): Promise<void>;
};

/** OpenAI rejects MiniMax's clear-text reasoning content and cannot decrypt its
 * opaque reasoning payload. Drop that entire model-only item from a private
 * copy, while retaining every message, tool pair, compaction and UI event.
 * Original rollouts are never edited. Native fork still owns the new identity.
 */
export async function providerHistorySnapshot(home: string, threadId: string, sourcePath: string,
    pathForThread: (id: string) => Promise<string>, options: { dropAllReasoning?: boolean } = {}): Promise<ProviderHistorySnapshot | undefined> {
    const canonicalHome = await realpath(home);
    const segments: Segment[] = [];
    const visited = new Set<string>();
    const load = async (path: string, id: string, bytes?: number, ordinal?: number): Promise<void> => {
        if (visited.has(id)) throw new Error('Provider history contains an ancestry cycle');
        visited.add(id);
        const canonical = await realpath(path);
        const rel = relative(canonicalHome, canonical);
        if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Provider history is outside the native store');
        const info = await stat(canonical);
        if (!info.isFile() || info.uid !== process.getuid?.()) throw new Error('Provider history has an unexpected owner or file type');
        if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > info.size)) throw new Error('Provider history has an invalid byte boundary');
        let header: Record<string, unknown> | undefined;
        for await (const line of historyLines(canonical)) { header = parseHistoryRecord(line.text); break; }
        const meta = record(header?.payload);
        if (header?.type !== 'session_meta' || meta.id !== id) throw new Error('Provider history identity differs from the native thread');
        const base = record(meta.history_base);
        const inherited = base.thread_id ? Number(base.end_ordinal_exclusive) : 0;
        if (!Number.isSafeInteger(inherited) || inherited < 0) throw new Error('Provider history has an invalid inherited boundary');
        const localLines = ordinal === undefined ? undefined : ordinal - inherited;
        if (localLines !== undefined && (!Number.isSafeInteger(localLines) || localLines < 1)) throw new Error('Provider history has an invalid ordinal boundary');
        if (base.thread_id) {
            const parent = string(base.thread_id);
            if (!parent) throw new Error('Provider history has no ancestor identity');
            await load(await pathForThread(parent), parent,
                base.end_byte_offset == null ? undefined : Number(base.end_byte_offset), inherited);
        }
        segments.push({ path: canonical, id, bytes: bytes ?? info.size, byteBounded: bytes !== undefined, lines: localLines, inherited, meta });
    };
    await load(sourcePath, threadId);
    // Canonical, fresh identity prevents native stale-path rejection. Keep the
    // copy under sessions so the native store can resolve its referenced prefix.
    const importId = randomUUID();
    const directory = join(canonicalHome, 'sessions', 'hapi-provider-history');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(directory, 'fork-')); await chmod(temporary, 0o700);
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const path = join(temporary, `rollout-${stamp}-${importId}.jsonl`);
    const output = await open(path, 'wx', 0o600);
    let removedReasoning = 0;
    let ordinal = 0;
    let retained = false;
    const writeEntry = (entry: Record<string, unknown>) => output.writeFile(JSON.stringify({ ...entry, ordinal: ordinal++ }) + '\n');
    const keepItem = (item: unknown): boolean => {
        const value = record(item);
        // DeepSeek cannot consume OpenAI summary/encrypted reasoning records.
        if (value.type === 'reasoning' && (options.dropAllReasoning || Array.isArray(value.content) && value.content.length)) {
            removedReasoning++; return false;
        }
        return true;
    };
    try {
        const meta: Record<string, unknown> = { ...segments[segments.length - 1].meta,
            id: importId, session_id: importId, history_mode: 'paginated' };
        // Materialize the full sanitized prefix under its own identity. Native forks
        // can reference it safely: no link reaches the unsanitized ancestry.
        delete (meta as Record<string, unknown>).history_base;
        delete (meta as Record<string, unknown>).forked_from_id;
        delete (meta as Record<string, unknown>).forked_from_ordinal_exclusive;
        await writeEntry({ timestamp: meta.timestamp, type: 'session_meta', payload: meta });
        for (const segment of segments) {
            const before = await stat(segment.path);
            let count = 0; let bytes = 0;
            for await (const line of historyLines(segment.path, segment.bytes)) {
                if (segment.lines !== undefined && count === segment.lines) break;
                count++; bytes += line.bytes + 1;
                let entry: Record<string, unknown>;
                try {
                    entry = record(JSON.parse(line.text));
                } catch {
                    // A record the captured boundary cut in half is a boundary
                    // defect, not a corrupt source file. Keep both causes
                    // distinguishable in the failure message.
                    if (!line.terminated && segment.byteBounded) {
                        throw new Error('Provider history byte boundary splits a record');
                    }
                    throw new Error('Provider history contains an invalid record');
                }
                if (entry.type === 'session_meta') {
                    if (count === 1 && JSON.stringify(record(entry.payload)) !== JSON.stringify(segment.meta)) throw new Error('Provider history metadata changed');
                    // Legacy native forks can carry older session metadata
                    // inside their materialized prefix. Only the first
                    // metadata record defines this source's identity.
                    continue;
                }
                if (entry.type === 'response_item' && !keepItem(entry.payload)) continue;
                if (entry.type === 'event_msg' && record(entry.payload).type === 'item_completed') {
                    const journal = record(entry.payload);
                    if (record(journal.item).type === 'Reasoning') continue;
                    // Preserve the native TurnItem verbatim, including failure,
                    // cancellation, structured content and future item types.
                    // Legacy conversion is lossy: native persistence explicitly
                    // discards exec_command_* even when their shapes are valid.
                    entry.payload = { ...journal, thread_id: importId };
                }
                if (entry.type === 'compacted') {
                    const payload = record(entry.payload);
                    if (Array.isArray(payload.replacement_history)) {
                        const indices: number[] = [];
                        const replacement = payload.replacement_history.filter((item, index) => { if (!keepItem(item)) return false; indices.push(index); return true; });
                        if (replacement.length !== payload.replacement_history.length) {
                            if (Array.isArray(payload.replacement_history_metadata)) {
                                if (payload.replacement_history_metadata.length !== payload.replacement_history.length) throw new Error('Cannot align provider compaction metadata');
                                payload.replacement_history_metadata = indices.map(index => (payload.replacement_history_metadata as unknown[])[index]);
                            }
                            entry.payload = { ...payload, replacement_history: replacement };
                            await writeEntry(entry); continue;
                        }
                    }
                }
                await writeEntry(entry);
            }
            if (segment.lines !== undefined && count !== segment.lines) throw new Error('Provider history prefix is incomplete');
            // A byte boundary must end immediately after a complete native line.
            if (segment.lines === undefined && bytes !== segment.bytes) throw new Error('Provider history byte boundary splits a record');
            if (segment.lines !== undefined && segment.byteBounded && bytes !== segment.bytes) throw new Error('Provider history boundaries disagree');
            const after = await stat(segment.path);
            if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Provider history changed while preparing the fork');
        }
        await output.sync(); await output.close();
        const dispose = async () => { if (!retained) await rm(temporary, { recursive: true, force: true }); };
        if (!removedReasoning) { await dispose(); return undefined; }
        return { path, removedReasoning, retain: () => { retained = true; }, dispose };
    } catch (error) { await output.close().catch(() => {}); await rm(temporary, { recursive: true, force: true }); throw error; }
}
