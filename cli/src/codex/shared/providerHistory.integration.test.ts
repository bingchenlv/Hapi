import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAppServerClient } from '../codexAppServerClient';
import { providerHistorySnapshot } from './providerHistory';

const FOREIGN_TEXT = 'FOREIGN_MINIMAX_REASONING_TEXT';
const FOREIGN_CIPHER = 'FOREIGN_MINIMAX_CIPHER';
const SECRET = 'R16_SECRET_NONCE_9d41';

const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

// Explicit opt-in: installed official binary, entirely isolated CODEX_HOME, mock Responses API only.
describe.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1')('provider history import', () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); });

    it.each([false, true])('keeps paginated history, including a plaintext-only provider target: %s', async (dropAllReasoning) => {
        const home = await mkdtemp('/tmp/hapi-provider-history-native-');
        const codexHome = join(home, 'codex');
        const work = join(home, 'work');
        await mkdir(codexHome);
        await mkdir(work);
        const bodies: Record<string, unknown>[] = [];
        const http: Server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(Buffer.from(chunk)));
            req.on('end', () => {
                if (!req.url?.endsWith('/responses') || req.method !== 'POST' || chunks.length === 0) { res.writeHead(404).end(); return; }
                const body = asRecord(JSON.parse(Buffer.concat(chunks).toString()));
                bodies.push(body);
                const input = Array.isArray(body.input) ? body.input : [];
                const foreign = input.map(asRecord).some(item => item.type === 'reasoning'
                    && (dropAllReasoning || Array.isArray(item.content) && item.content.length));
                if (foreign) {
                    // The upstream refuses foreign reasoning content, exactly
                    // like the OpenAI-compatible endpoint this repair targets.
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'reasoning.content maximum length 0' } }));
                    return;
                }
                const id = randomUUID();
                const events = [
                    { type: 'response.created', response: { id } },
                    {
                        type: 'response.output_item.done',
                        item: {
                            type: 'message', role: 'assistant', id: 'msg_' + id,
                            content: [{ type: 'output_text', text: 'IMPORTED TURN DONE' }]
                        }
                    },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }
                ];
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const port = (http.address() as { port: number }).port;
        await writeFile(join(codexHome, 'config.toml'), [
            'model = "source-model"',
            `openai_base_url = "http://127.0.0.1:${port}/v1"`,
            'forced_login_method = "api"',
            'approval_policy = "never"',
            'approvals_reviewer = "user"',
            'sandbox_mode = "workspace-write"',
            '[features]', 'plugins = false', 'remote_plugin = false', 'apps = false',
            '[analytics]', 'enabled = false', '[feedback]', 'enabled = false', ''
        ].join('\n'));
        const previousHome = process.env.CODEX_HOME;
        const previousKey = process.env.OPENAI_API_KEY;
        process.env.CODEX_HOME = codexHome;
        process.env.OPENAI_API_KEY = 'isolated-provider-history-key';
        const client = new CodexAppServerClient({ cwd: work });
        const completed: string[] = [];
        client.setNotificationHandler((method, params) => {
            if (method === 'turn/completed') completed.push(asString(asRecord(asRecord(params).turn).id));
        });
        cleanups.push(async () => {
            await client.disconnect();
            http.closeAllConnections();
            await new Promise<void>(resolve => http.close(() => resolve()));
            if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
            if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
        });
        const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        const until = async (check: () => boolean, ms = 60000) => {
            const by = Date.now() + ms;
            while (!check()) {
                if (Date.now() > by) throw new Error('observation timed out');
                await delay(100);
            }
        };

        await client.connect();
        await client.initialize({ clientInfo: { name: 'hapi', title: 'HAPI', version: '1' }, capabilities: { experimentalApi: true } });
        const started: any = await client.request('thread/start', {
            cwd: work, model: 'source-model', approvalPolicy: 'never',
            approvalsReviewer: 'user', sandbox: 'workspace-write', deferGoalContinuation: true
        });
        const threadId = asString(started.thread?.id);
        expect(threadId).toBeTruthy();
        // The engine writes its rollout lazily, so give it one turn first.
        await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'SEED TURN' }] });
        await until(() => completed.length > 0);

        // A paginated source rollout: its items live in an item_completed
        // journal, and its reasoning is foreign clear text the import removes.
        const sourcePath = join(codexHome, 'sessions', `rollout-${threadId}.jsonl`);
        await mkdir(join(codexHome, 'sessions'), { recursive: true });
        const turnId = 'turn-r16';
        // Reuse the engine's own session metadata so the copy is a rollout the
        // native store accepts, and only the history body is synthetic.
        const ownRead: any = await client.request('thread/read', { threadId, includeTurns: false });
        const ownMeta = JSON.parse((await readFile(asString(ownRead.thread?.path), 'utf8')).split('\n')[0]).payload;
        expect(asString(ownMeta.id)).toBe(threadId);
        const source = [
            {
                timestamp: new Date().toISOString(), type: 'session_meta',
                payload: { ...ownMeta, id: threadId, session_id: threadId, history_mode: 'paginated' }
            },
            { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, started_at: Math.floor(Date.now() / 1000) } },
            { timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `KEEP THIS TASK HISTORY ${SECRET}` }] } },
            {
                timestamp: new Date().toISOString(), type: 'event_msg',
                payload: {
                    type: 'item_completed', thread_id: threadId, turn_id: turnId,
                    item: { type: 'UserMessage', id: 'u1', client_id: 'client-1', content: [{ type: 'text', text: `KEEP THIS TASK HISTORY ${SECRET}`, text_elements: [] }] }
                }
            },
            { timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'reasoning', summary: [],
                ...(!dropAllReasoning ? { content: [{ type: 'reasoning_text', text: FOREIGN_TEXT }] } : {}), encrypted_content: FOREIGN_CIPHER } },
            {
                timestamp: new Date().toISOString(), type: 'event_msg',
                payload: {
                    type: 'item_completed', thread_id: threadId, turn_id: turnId,
                    item: { type: 'Reasoning', id: 'r1', summary_text: [], raw_content: [FOREIGN_TEXT] }
                }
            },
            {
                timestamp: new Date().toISOString(), type: 'response_item',
                payload: { type: 'function_call', id: 'fc-1', name: 'list_peers', namespace: 'hapi', arguments: '{}', call_id: 'call-1' }
            },
            { timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call_output', id: 'fco-1', call_id: 'call-1', output: 'PEERS OK' } },
            {
                timestamp: new Date().toISOString(), type: 'event_msg',
                payload: {
                    type: 'item_completed', thread_id: threadId, turn_id: turnId,
                    item: {
                        type: 'McpToolCall', id: 'call-1', server: 'hapi', tool: 'list_peers',
                        arguments: {}, status: 'completed',
                        result: { content: [{ type: 'text', text: 'PEERS OK' }], isError: false },
                        duration: { secs: 0, nanos: 1 }
                    }
                }
            },
            ...[
                ...['completed', 'failed'].map((status, index) => ({
                    type: 'CommandExecution', id: `cmd-${status}`, command: ['bash', '-lc', 'echo SEMANTIC_COMMAND'],
                    cwd: `file://${work}`, parsed_cmd: [], source: 'agent', status,
                    stdout: 'COMMAND_STDOUT', stderr: index ? 'COMMAND_STDERR' : '',
                    aggregated_output: index ? 'COMMAND_STDOUT\nCOMMAND_STDERR' : 'COMMAND_STDOUT',
                    exit_code: index ? 7 : 0, duration: { secs: 1, nanos: 2_000_000 }
                })),
                ...['completed', 'failed', 'declined'].map(status => ({
                    type: 'FileChange', id: `patch-${status}`, status, stdout: 'PATCH_SUMMARY', stderr: '',
                    changes: { [join(work, `${status}.txt`)]: { type: 'add', content: 'PATCH_CONTENT' } }
                })),
                { type: 'McpToolCall', id: 'mcp-failed', server: 'test', tool: 'failure', arguments: { a: 2 },
                    status: 'failed', result: null, error: { message: 'MCP_FAILED' }, duration: { secs: 0, nanos: 1 } },
                { type: 'McpToolCall', id: 'mcp-is-error', server: 'test', tool: 'failure_result', arguments: {},
                    status: 'failed', result: { content: [{ type: 'text', text: 'MCP_IS_ERROR' }], isError: true }, duration: { secs: 0, nanos: 1 } },
                { type: 'McpToolCall', id: 'mcp-structured', server: 'test', tool: 'structured', arguments: { n: 1 },
                    status: 'completed', result: { content: [{ type: 'text', text: 'STRUCTURED' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
                        structuredContent: { answer: 42 }, _meta: { localFixture: true }, isError: false }, duration: { secs: 0, nanos: 1 } }
            ].map(item => ({ timestamp: new Date().toISOString(), type: 'event_msg', payload: {
                type: 'item_completed', thread_id: threadId, turn_id: turnId, item
            } })),
            { timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SOURCE ANSWER' }] } },
            {
                timestamp: new Date().toISOString(), type: 'event_msg',
                payload: {
                    type: 'item_completed', thread_id: threadId, turn_id: turnId,
                    item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'SOURCE ANSWER' }] }
                }
            },
            { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'SOURCE ANSWER' } }
        ].map(entry => JSON.stringify(entry)).join('\n') + '\n';
        await writeFile(sourcePath, source, { mode: 0o600 });

        const snapshot = (await providerHistorySnapshot(codexHome, threadId, sourcePath, async id => {
            expect(id).toBe(threadId);
            return sourcePath;
        }, { dropAllReasoning }))!;
        expect(snapshot).toBeTruthy();
        expect(snapshot.removedReasoning).toBe(1);
        const copied = await readFile(snapshot.path, 'utf8');
        expect(copied).toContain('item_completed');
        expect(JSON.parse(copied.split('\n')[0]).payload.history_mode).toBe('paginated');
        expect(copied).not.toContain(FOREIGN_TEXT);
        expect(copied).not.toContain(FOREIGN_CIPHER);
        expect(await readFile(sourcePath, 'utf8')).toBe(source);

        const forked: any = await client.request('thread/fork', { threadId, path: snapshot.path, model: 'fork-model', deferGoalContinuation: true });
        snapshot.retain();
        await snapshot.dispose();
        expect(await readFile(snapshot.path, 'utf8')).toBe(copied);
        const forkedId = asString(forked.thread?.id);
        expect(forkedId).toBeTruthy();
        const read: any = await client.request('thread/read', { threadId: forkedId, includeTurns: true });
        const turns = Array.isArray(read.thread?.turns) ? read.thread.turns : [];
        const items = turns.flatMap((turn: any) => (Array.isArray(turn.items) ? turn.items : []));
        const types = items.map((item: any) => asString(item.type));
        expect(types).toContain('userMessage');
        expect(types).toContain('mcpToolCall');
        expect(types).toContain('agentMessage');
        expect(JSON.stringify(items)).toContain(SECRET);
        const assertSemantics = (actual: any[]) => {
            const byId = (id: string) => actual.find(item => item.id === id);
            expect(byId('cmd-completed')).toMatchObject({ type: 'commandExecution', status: 'completed',
                command: 'bash -lc \'echo SEMANTIC_COMMAND\'', aggregatedOutput: 'COMMAND_STDOUT', exitCode: 0, durationMs: 1002 });
            expect(byId('cmd-failed')).toMatchObject({ type: 'commandExecution', status: 'failed',
                aggregatedOutput: 'COMMAND_STDOUT\nCOMMAND_STDERR', exitCode: 7, durationMs: 1002 });
            for (const status of ['completed', 'failed', 'declined']) {
                expect(byId(`patch-${status}`)).toMatchObject({ type: 'fileChange', status,
                    changes: [{ path: join(work, `${status}.txt`), kind: { type: 'add' }, diff: 'PATCH_CONTENT' }] });
            }
            expect(byId('mcp-failed')).toMatchObject({ type: 'mcpToolCall', status: 'failed', error: { message: 'MCP_FAILED' } });
            expect(byId('mcp-is-error')).toMatchObject({ type: 'mcpToolCall', status: 'failed' });
            expect(byId('mcp-structured')).toMatchObject({ type: 'mcpToolCall', status: 'completed',
                arguments: { n: 1 }, result: { structuredContent: { answer: 42 },
                    content: [{ type: 'text', text: 'STRUCTURED' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] } });
        };
        assertSemantics(items);

        const list: any = await client.request('thread/turns/list', { threadId: forkedId, limit: 100, sortDirection: 'asc', itemsView: 'full' });
        const listItems = Array.isArray(list.data) ? list.data.flatMap((turn: any) => (Array.isArray(turn.items) ? turn.items : [])) : [];
        expect(listItems.map((item: any) => asString(item.type))).toContain('userMessage');
        assertSemantics(listItems);

        // New process: not just a warm in-memory reader. No external model call.
        await client.disconnect();
        await client.connect();
        await client.initialize({ clientInfo: { name: 'history-cold-acceptance', version: '1' }, capabilities: { experimentalApi: true } });
        await client.request('thread/resume', { threadId: forkedId, model: 'fork-model', deferGoalContinuation: true });
        const cold: any = await client.request('thread/read', { threadId: forkedId, includeTurns: true });
        assertSemantics(cold.thread.turns.flatMap((turn: any) => turn.items));
        const reversed: any = await client.request('thread/fork', { threadId: forkedId, model: 'source-model', deferGoalContinuation: true });
        const reverseRead: any = await client.request('thread/read', { threadId: reversed.thread.id, includeTurns: true });
        assertSemantics(reverseRead.thread.turns.flatMap((turn: any) => turn.items));
        expect(await readFile(sourcePath, 'utf8')).toBe(source);

        completed.length = 0;
        await client.request('turn/start', { threadId: forkedId, input: [{ type: 'text', text: 'CONTINUE AFTER THE SWITCH' }] });
        await until(() => completed.length > 0);
        const body = bodies.at(-1)!;
        const input = JSON.stringify(body.input ?? '');
        expect(input).toContain('KEEP THIS TASK HISTORY');
        expect(input).toContain(SECRET);
        expect(input).not.toContain(FOREIGN_TEXT);
        expect(input).not.toContain(FOREIGN_CIPHER);
        await snapshot.dispose();
    }, 90_000);
});
