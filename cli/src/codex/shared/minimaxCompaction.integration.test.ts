import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { resolveSharedCodex } from './launch';
import { prepareMiniMaxCatalog } from './nativeMiniMaxCatalog';
import { minimaxProviderConfig, minimaxServerArgs } from './minimax';
import { startMiniMaxReviewRouter } from './minimaxReviewRouter';

// Installed native engine, local fake upstreams and fake auth only. No Hub
// writes, approval responses, real provider calls or production histories.
describe.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1')('installed native MiniMax compaction', () => {
    it.each(['legacy-downshift', 'startup-catalog', 'native-auto-compaction', 'compaction-failure'] as const)('%s preserves generation or an explicit failure without replay', async mode => {
        const home = await mkdtemp('/tmp/hapi-compact-native-');
        const calls: Array<{ model: string; path: string; input: string }> = [];
        const incoming: unknown[] = [];
        let routerBase = '';
        const notifications: any[] = [];
        const http = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', async () => {
                if (req.url?.startsWith('/router/')) {
                    const data = JSON.parse(Buffer.concat(chunks).toString());
                    incoming.push({ path: req.url, model: data.model, tools: data.tools?.length, metadata: req.headers['x-codex-turn-metadata'] });
                    const response = await fetch(routerBase + req.url.slice('/router'.length), { method: 'POST', headers: { 'content-type': 'application/json', 'x-hapi-minimax-router': String(req.headers['x-hapi-minimax-router']), 'x-codex-turn-metadata': String(req.headers['x-codex-turn-metadata'] ?? '') }, body: Buffer.concat(chunks) });
                    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' }); res.end(Buffer.from(await response.arrayBuffer())); return;
                }
                if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
                const data = JSON.parse(Buffer.concat(chunks).toString());
                calls.push({ model: data.model, path: req.url!, input: JSON.stringify(data.input) });
                if (mode === 'compaction-failure' && req.url === '/mini/responses') {
                    res.writeHead(503, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'ISOLATED_COMPACTION_UNAVAILABLE' } })); return;
                }
                const id = randomUUID(); const tokens = mode === 'native-auto-compaction' ? 950000 : 400000;
                const events = [{ type: 'response.created', response: { id } },
                    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'SYNTHETIC CHECKPOINT AND ANSWER' }] } },
                    { type: 'response.completed', response: { id, usage: { input_tokens: calls.length === 1 ? tokens : 100, output_tokens: 10, total_tokens: calls.length === 1 ? tokens + 10 : 110 } } }];
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
        const router = await startMiniMaxReviewRouter({ minimaxUrl: `${url}/mini/responses`, credential: async () => 'isolated-fake-mini' });
        routerBase = router.baseUrl;
        const command = resolveSharedCodex();
        const env = { ...process.env, HOME: home, CODEX_HOME: home, HAPI_MINIMAX_TRANSPORT_TOKEN: router.capability, OPENAI_API_KEY: 'isolated-fake' };
        const raw = JSON.parse(execFileSync(command.command, [...command.args, 'debug', 'models', '--bundled'], { env, cwd: home, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
        raw.models.find((model: any) => model.slug === 'gpt-6.1-sol').context_window = 500000;
        await writeFile(join(home, 'base-catalog.json'), JSON.stringify(raw));
        await writeFile(join(home, 'config.toml'), '');
        const settings: Record<string, unknown> = {
            model_catalog_json: join(home, 'base-catalog.json'), model: 'gpt-6.1-sol', model_provider: 'old_local',
            'model_providers.old_local.name': 'Isolated old provider', 'model_providers.old_local.base_url': `${url}/old`,
            'model_providers.old_local.wire_api': 'responses', 'model_providers.old_local.supports_websockets': false,
            'model_providers.old_local.request_max_retries': 0, 'model_providers.old_local.stream_max_retries': 0,
            'features.plugins': false, 'features.remote_plugin': false, 'features.apps': false,
            'analytics.enabled': false, 'feedback.enabled': false, project_doc_max_bytes: 0,
            web_search: 'disabled', model_auto_compact_token_limit: 900000
        };
        const args = Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
        const catalog = mode === 'legacy-downshift' || mode === 'compaction-failure' ? [] : await prepareMiniMaxCatalog(command, args, home, env, home);
        if (catalog.length) expect((await stat(join(home, 'minimax-model-catalog.json'))).mode & 0o777).toBe(0o600);
        const proc = spawn(command.command, [...command.args, 'app-server', ...args, ...minimaxServerArgs(minimaxProviderConfig(`${url}/router`)), ...catalog], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = ''; proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
        const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
        let next = 0; let approvals = 0;
        const lines = createInterface({ input: proc.stdout });
        lines.on('line', line => {
            const data = JSON.parse(line);
            if (data.method) { notifications.push(data); if (data.id != null) approvals++; }
            else if (data.id != null) {
                const item = pending.get(data.id); pending.delete(data.id);
                if (data.error) item?.reject(new Error(JSON.stringify(data.error))); else item?.resolve(data.result);
            }
        });
        const rpc = (method: string, params: object) => new Promise<any>((resolve, reject) => {
            const id = ++next;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Local native ${method} timed out: ${stderr.slice(-2000)}`)); }, 10000);
            pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
            proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
        });
        const turn = async (id: string, text: string, expected = 'completed') => {
            const first = notifications.length;
            const started = await rpc('turn/start', { threadId: id, input: [{ type: 'text', text }] });
            await expect.poll(() => notifications.slice(first).find(event => event.method === 'turn/completed' && event.params.turn.id === started.turn.id), { timeout: 15000 }).toBeTruthy();
            const completed = notifications.slice(first).find(event => event.method === 'turn/completed' && event.params.turn.id === started.turn.id)?.params.turn;
            expect(completed?.status, JSON.stringify({ error: completed?.error, incoming, events: notifications.slice(first).filter(event => event.method === 'error'), stderr: stderr.slice(-2000) })).toBe(expected);
        };
        try {
            await rpc('initialize', { clientInfo: { name: 'isolated-native-compaction', version: '1' }, capabilities: { experimentalApi: true } });
            proc.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
            const original = await rpc('thread/start', { cwd: home, model: mode === 'native-auto-compaction' ? 'MiniMax-M3.1-Flash' : 'gpt-6.1-sol',
                modelProvider: mode === 'native-auto-compaction' ? 'hapi_minimax' : 'old_local', config: { model_context_window: mode === 'native-auto-compaction' ? 1000000 : 500000 },
                historyMode: 'legacy', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' });
            await turn(original.thread.id, 'Preserve this synthetic history before switching provider. No tools.');
            const fork = mode === 'native-auto-compaction' ? original : await rpc('thread/fork', { threadId: original.thread.id, model: 'MiniMax-M3.1-Flash', modelProvider: 'hapi_minimax', config: { model_context_window: 1000000, model_reasoning_effort: 'max' } });
            await turn(fork.thread.id, 'Continue the synthetic history after the provider switch. No tools.', mode === 'compaction-failure' ? 'failed' : 'completed');
            if (mode !== 'native-auto-compaction') expect(calls[0]).toMatchObject({ model: 'gpt-6.1-sol', path: '/old/responses' });
            const mini = mode === 'native-auto-compaction' ? calls : calls.slice(1);
            expect(mini).toHaveLength(mode === 'native-auto-compaction' ? 3 : mode === 'compaction-failure' || mode === 'startup-catalog' ? 1 : 2);
            expect(mini.every(call => call.model === 'MiniMax-M3.1-Flash' && call.path === '/mini/responses')).toBe(true);
            expect(router.counts()).toEqual({ taskRequests: mini.length, reviewRequests: 0 });
            expect(approvals).toBe(0); expect(router.isBlocked()).toBe(false);
            if (mode === 'compaction-failure') {
                expect(notifications.some(event => event.method === 'error' && JSON.stringify(event).includes('ISOLATED_COMPACTION_UNAVAILABLE'))).toBe(true);
                expect(notifications.some(event => event.method === 'error' && JSON.stringify(event).includes('no approval was granted'))).toBe(false);
                return;
            }
            expect(stderr).not.toContain('Failed to run pre-sampling compact');
            if (mode !== 'legacy-downshift') expect(stderr).not.toContain('Model info for `MiniMax-M3.1-Flash` not found');
            expect(notifications.some(event => event.method === 'thread/tokenUsage/updated'
                && event.params.threadId === fork.thread.id && event.params.tokenUsage?.modelContextWindow === 950000)).toBe(mode !== 'legacy-downshift');
        } finally {
            proc.kill('SIGTERM');
            await new Promise<void>(resolve => { if (proc.exitCode != null || proc.signalCode) resolve(); else { const timer = setTimeout(() => proc.kill('SIGKILL'), 3000); proc.once('exit', () => { clearTimeout(timer); resolve(); }); } });
            lines.close(); await router.close();
            http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
            await rm(home, { recursive: true, force: true, maxRetries: 3 });
        }
    }, 45000);
});
