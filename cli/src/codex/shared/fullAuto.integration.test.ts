import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveSharedCodex } from './launch';
import { minimaxThreadConfig, MINIMAX_MODEL } from './minimax';
import { fullAutoConfig } from './fullAutoTools';

// The actual installed Codex engine executes a harmless file write outside its
// workspace and a local network request. Only fake upstreams/credentials, no Hub.
describe.skipIf(process.env.HAPI_RUN_SHARED_CODEX_TESTS !== '1')('native full automation', () => {
    it('executes outside-workspace and network work with zero approvals, including fork and cold resume', async () => {
        const home = await mkdtemp('/tmp/hapi-full-auto-');
        const cwd = join(home, 'work'); await mkdir(cwd);
        const calls: any[] = []; const proofs: string[] = []; let networkRequests = 0;
        const server = createServer((request, response) => {
            if (request.url === '/proof') { networkRequests++; response.end('LOCAL_NETWORK_OK'); return; }
            const chunks: Buffer[] = []; request.on('data', c => chunks.push(Buffer.from(c)));
            request.once('end', () => {
                if (request.method !== 'POST' || !request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
                const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
                const input = body.input ?? []; let lastUser = -1;
                input.forEach((item: any, i: number) => { if (item.role === 'user') lastUser = i; });
                const outputs = input.slice(lastUser + 1).filter((i: any) => i.type === 'function_call_output');
                const nonce = /PROOF_([a-z0-9]+)/.exec(JSON.stringify(input[lastUser]))?.[1];
                const isMcp = JSON.stringify(input[lastUser]).includes('MCP_PROOF_');
                const proof = join(home, `${isMcp ? 'mcp' : 'outside'}-${nonce}.txt`);
                if (!isMcp && !proofs.includes(proof)) proofs.push(proof);
                const code = `from pathlib import Path; import urllib.request; Path(${JSON.stringify(proof)}).write_text(urllib.request.urlopen(${JSON.stringify(url + '/proof')}).read().decode())`;
                const cmd = `python3 -c '${code.replace(/'/g, "'\\''")}'`;
                const id = randomUUID();
                const item = !outputs.length
                    ? { type: 'function_call', call_id: `exec_${id}`, name: isMcp ? 'write' : 'exec_command', ...(isMcp ? { namespace: 'mcp__proof' } : {}),
                        arguments: JSON.stringify(isMcp ? { path: proof } : { cmd, workdir: cwd }) }
                    : { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: '已完成本地验证。' }] };
                const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }];
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(server.address() as any).port}`;
        // Mirror the production global config: an apps default table without a
        // reviewer. `config/read` reports that absent field as null.
        await writeFile(join(home, 'config.toml'), '[apps._default]\ndefault_tools_approval_mode = "prompt"\n');
        const mcp = join(home, 'proof-mcp.py');
        await writeFile(mcp, `import json,sys\nfrom pathlib import Path\nfor line in sys.stdin:\n r=json.loads(line)\n if 'id' not in r: continue\n method=r.get('method')\n if method=='initialize': result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'proof','version':'1'}}\n elif method=='tools/list': result={'tools':[{'name':'write','description':'Isolated harmless proof write','inputSchema':{'type':'object','properties':{'path':{'type':'string'}},'required':['path']},'annotations':{'readOnlyHint':False,'destructiveHint':True,'openWorldHint':True}}]}\n elif method=='tools/call':\n  Path(r['params']['arguments']['path']).write_text('MCP_AUTO_OK')\n  result={'content':[{'type':'text','text':'MCP_AUTO_OK'}]}\n else: result={}\n print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}),flush=True)\n`);
        const toolConfig = { apps: { _default: { default_tools_approval_mode: 'prompt' } }, mcp_servers: { proof: { command: '/usr/bin/python3', args: [mcp], default_tools_approval_mode: 'prompt',
            tools: { write: { approval_mode: 'prompt' } } } } };
        const command = resolveSharedCodex();
        const settings: Record<string, unknown> = {
            openai_base_url: `${url}/v1`, forced_login_method: 'api',
            'model_providers.hapi_minimax.name': 'Isolated MiniMax',
            'model_providers.hapi_minimax.base_url': `${url}/v1`,
            'model_providers.hapi_minimax.wire_api': 'responses',
            'model_providers.hapi_minimax.supports_websockets': false,
            'model_providers.hapi_minimax.request_max_retries': 0,
            'model_providers.hapi_minimax.stream_max_retries': 0,
            'model_providers.isolated_openai.name': 'Isolated OpenAI',
            'model_providers.isolated_openai.base_url': `${url}/v1`,
            'model_providers.isolated_openai.wire_api': 'responses',
            'model_providers.isolated_openai.requires_openai_auth': false,
            'model_providers.isolated_openai.supports_websockets': false,
            'model_providers.isolated_openai.request_max_retries': 0,
            'model_providers.isolated_openai.stream_max_retries': 0,
            'mcp_servers.proof.command': '/usr/bin/python3', 'mcp_servers.proof.args': [mcp],
            'mcp_servers.proof.default_tools_approval_mode': 'prompt', 'mcp_servers.proof.tools.write.approval_mode': 'prompt',
            'features.plugins': false, 'features.remote_plugin': false, 'features.apps': false,
            'analytics.enabled': false, 'feedback.enabled': false, project_doc_max_bytes: 0, web_search: 'disabled'
        };
        const args = Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
        const env = { ...process.env, HOME: home, CODEX_HOME: home, OPENAI_API_KEY: 'isolated-test-key' };
        const processes: ReturnType<typeof spawn>[] = []; const streams: ReturnType<typeof createInterface>[] = [];
        const events: any[] = []; let approvals = 0; let serial = 0;
        const start = async () => {
            const proc = spawn(command.command, [...command.args, 'app-server', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
            processes.push(proc); let stderr = ''; proc.stderr!.on('data', chunk => { stderr += chunk.toString(); });
            const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
            const lines = createInterface({ input: proc.stdout! }); streams.push(lines);
            lines.on('line', line => {
                const value = JSON.parse(line);
                if (value.method) { events.push(value); if (value.id != null) approvals++; }
                else {
                    const p = pending.get(value.id); pending.delete(value.id);
                    if (value.error) p?.reject(Error(JSON.stringify(value.error))); else p?.resolve(value.result);
                }
            });
            const rpc = (method: string, params: any): Promise<any> => new Promise((resolve, reject) => {
                const id = ++serial; const timer = setTimeout(() => reject(Error(`Native ${method} timed out: ${stderr.slice(-1200)}`)), 10000);
                pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
                proc.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
            });
            await rpc('initialize', { clientInfo: { name: 'full-auto-native-proof', version: '1' }, capabilities: { experimentalApi: true } });
            proc.stdin!.write(JSON.stringify({ method: 'initialized' }) + '\n');
            return { proc, rpc };
        };
        const stop = async (proc: ReturnType<typeof spawn>) => {
            if (proc.exitCode != null || proc.signalCode) return;
            proc.kill('SIGTERM');
            await new Promise<void>(resolve => { const t = setTimeout(() => proc.kill('SIGKILL'), 3000); proc.once('exit', () => { clearTimeout(t); resolve(); }); });
        };
        const turn = async (rpc: Awaited<ReturnType<typeof start>>['rpc'], id: string, mcp = false) => {
            const nonce = randomUUID().replaceAll('-', '');
            const begun = await rpc('turn/start', { threadId: id, input: [{ type: 'text', text: `${mcp ? 'MCP_' : ''}PROOF_${nonce}` }] });
            await expect.poll(() => events.find(e => e.method === 'turn/completed' && e.params.turn.id === begun.turn.id), { timeout: 20000 }).toBeTruthy();
            const ended = events.find(e => e.method === 'turn/completed' && e.params.turn.id === begun.turn.id);
            expect(ended.params.turn.status).toBe('completed');
            let proof: string;
            try { proof = await readFile(join(home, `${mcp ? 'mcp' : 'outside'}-${nonce}.txt`), 'utf8'); }
            catch { throw Error(`Missing proof: ${JSON.stringify({ lastInput: calls.at(-1)?.input?.slice(-3) }).slice(-5000)}`); }
            expect(proof).toBe(mcp ? 'MCP_AUTO_OK' : 'LOCAL_NETWORK_OK');
        };
        try {
            const first = await start();
            // Real native read: an absent optional field arrives as null.
            const native = await first.rpc('config/read', { cwd, includeLayers: false });
            expect(native.config.apps._default.approvals_reviewer).toBeNull();
            const nativeToolConfig = { ...toolConfig, apps: native.config.apps, plugins: native.config.plugins };
            // Writing the read snapshot back unchanged is rejected by the
            // native config parser: a thread override cannot hold null.
            await expect(first.rpc('thread/start', { cwd, model: MINIMAX_MODEL, modelProvider: 'hapi_minimax',
                sandbox: 'danger-full-access', approvalPolicy: 'never',
                config: { apps: native.config.apps, plugins: native.config.plugins } }))
                .rejects.toThrow(/approvals_reviewer/);
            // The HAPI projection drops the absent field and keeps the
            // inheritance of the global config.
            const toolOverrides = fullAutoConfig({}, nativeToolConfig);
            expect((toolOverrides.apps as any)._default.approvals_reviewer).toBeUndefined();
            const original = await first.rpc('thread/start', minimaxThreadConfig({ cwd, model: MINIMAX_MODEL, sandbox: 'workspace-write', approvalPolicy: 'on-request', config: toolOverrides }));
            expect(original).toMatchObject({ approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } });
            await turn(first.rpc, original.thread.id);
            await turn(first.rpc, original.thread.id, true);
            const fork = await first.rpc('thread/fork', { threadId: original.thread.id, model: 'gpt-6.1-sol', modelProvider: 'isolated_openai',
                sandbox: 'danger-full-access', approvalPolicy: 'never', deferGoalContinuation: true, config: toolOverrides });
            await turn(first.rpc, fork.thread.id);
            await turn(first.rpc, fork.thread.id, true);
            await stop(first.proc);
            const cold = await start();
            // Native cold resume otherwise falls back to startup permissions.
            // HAPI must resend its durable per-session autonomy preference.
            const resumed = await cold.rpc('thread/resume', { threadId: fork.thread.id, deferGoalContinuation: true,
                sandbox: 'danger-full-access', approvalPolicy: 'never', config: toolOverrides });
            expect(resumed).toMatchObject({ approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } });
            await turn(cold.rpc, fork.thread.id);
            await turn(cold.rpc, fork.thread.id, true);
            expect(networkRequests).toBe(3); expect(proofs).toHaveLength(3); expect(approvals).toBe(0);
            expect(calls.some(c => c.model === MINIMAX_MODEL)).toBe(true);
            expect(calls.some(c => c.model === 'gpt-6.1-sol')).toBe(true);
        } finally {
            for (const proc of processes) await stop(proc);
            for (const stream of streams) stream.close();
            server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
            await rm(home, { recursive: true, force: true });
        }
    }, 90000);
});
