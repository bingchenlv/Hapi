import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { startMiniMaxReviewRouter } from './minimaxReviewRouter';

const cleanup: Array<() => Promise<unknown>> = [];
const capabilities = new Map<string, string>();
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function endpoint(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/responses`;
}
const done = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"mock"}}\n\n';
const auth = { authorization: 'Bearer isolated-openai-credential', 'content-type': 'application/json' };
const reviewHeaders = { ...auth, 'x-openai-subagent': 'guardian' };
const post = (base: string, model: string, headers: Record<string, string> = auth, extra = {}) => fetch(`${base}/responses`, {
    method: 'POST', headers: {...headers, 'x-hapi-minimax-router':capabilities.get(base)!}, body: JSON.stringify({ model, input: [], ...extra })
});
async function router(options: Parameters<typeof startMiniMaxReviewRouter>[0]) {
    const value = await startMiniMaxReviewRouter(options); cleanup.push(value.close); capabilities.set(value.baseUrl, value.capability); return value;
}

describe('native MiniMax/OpenAI review transport', () => {
    const marker = JSON.stringify({ request_kind: 'compaction', compaction: {
        implementation: 'responses', phase: 'pre_turn', reason: 'model_downshift'
    } });
    it.each(['model_downshift', 'comp_hash_changed'])('adapts native old-model %s compaction on the new MiniMax provider, without OpenAI auth', async reason => {
        let payload: any; let received: IncomingMessage['headers'] = {};
        const url = await endpoint((req, res) => {
            received = req.headers; const chunks: Buffer[] = [];
            req.on('data', part => chunks.push(part)); req.on('end', () => { payload = JSON.parse(Buffer.concat(chunks).toString()); res.end(done); });
        });
        const value = await router({ minimaxUrl: url, credential: async () => 'fake-mm' });
        const extra = { reasoning: { effort: 'ultra', summary: 'none' }, input: [{ role: 'user', content: 'checkpoint' }] };
        const nativeMarker = JSON.stringify({ request_kind: 'compaction', compaction: { implementation: 'responses', phase: 'pre_turn', reason } });
        expect((await post(value.baseUrl, 'gpt-6.1-sol', { ...auth, 'x-codex-turn-metadata': nativeMarker }, extra)).status).toBe(200);
        expect(payload).toEqual({ model: 'MiniMax-M3.1-Flash', ...extra, reasoning: { effort: 'max', summary: 'none' } });
        expect(received.authorization).toBe('Bearer fake-mm');
        expect(received['x-codex-turn-metadata']).toBeUndefined();
        expect(value.counts()).toEqual({ taskRequests: 1, reviewRequests: 0 });
        expect(value.isBlocked()).toBe(false);
    });
    it('never classifies prompt text, forged capability, malformed metadata or tools as old-model compaction', async () => {
        const upstream = vi.fn((req: IncomingMessage, res: ServerResponse) => { req.resume(); res.end(done); });
        const url = await endpoint(upstream); const value = await router({ minimaxUrl: url, credential: async () => 'fake-mm' });
        for (const [headers, extra] of [
            [auth, { input: [{ role: 'user', content: marker }] }],
            [{ ...auth, 'x-codex-turn-metadata': '{invalid' }, {}],
            [{ ...auth, 'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn' }) }, {}],
            [{ ...auth, 'x-codex-turn-metadata': marker }, { tools: [{ type: 'function' }] }],
            [{ ...auth, 'x-codex-turn-metadata': marker }, { tools: {} }],
        ] as Array<[Record<string, string>, object]>) {
            const response = await post(value.baseUrl, 'gpt-6.1-sol', headers, extra);
            expect(response.status).toBe(400); await response.text();
        }
        const untrusted = await fetch(`${value.baseUrl}/responses`, { method: 'POST', headers: { ...auth, 'x-codex-turn-metadata': marker }, body: JSON.stringify({ model: 'gpt-6.1-sol' }) });
        expect(untrusted.status).toBe(403); await untrusted.text();
        expect(upstream).not.toHaveBeenCalled(); expect(value.isBlocked()).toBe(false);
    });
    it('gives guardian review precedence over compaction and leaves ordinary task reasoning unchanged', async () => {
        let payload: any;
        const url = await endpoint((req, res) => { const chunks: Buffer[] = []; req.on('data', p => chunks.push(p)); req.on('end', () => { payload = JSON.parse(Buffer.concat(chunks).toString()); res.end(done); }); });
        const value = await router({ minimaxUrl: url, credential: async () => 'fake-mm' });
        for (const headers of [{ ...reviewHeaders, 'x-codex-turn-metadata': marker }, { ...auth, 'x-codex-guardian': 'reviewer', 'x-codex-turn-metadata': marker }]) {
            const denied = await post(value.baseUrl, 'gpt-6.1-sol', headers);
            expect(denied.status).toBe(400); await denied.text(); value.reset();
        }
        await (await post(value.baseUrl, 'MiniMax-M3.1-Flash', auth, { reasoning: { effort: 'ultra' } })).text();
        expect(payload.reasoning.effort).toBe('ultra'); expect(value.counts().reviewRequests).toBe(0);
    });
    it('distinguishes compaction, generation and review failures without leaking credentials', async () => {
        const credential = async () => { throw new Error('private credential must never appear'); };
        const value = await router({ credential });
        for (const [model, headers, phase] of [
            ['MiniMax-M3.1-Flash', auth, 'task_generation'],
            ['gpt-6.1-sol', { ...auth, 'x-codex-turn-metadata': marker }, 'history_compaction']
        ] as Array<[string, Record<string, string>, string]>) {
            const response = await post(value.baseUrl, model, headers); const error = await response.json() as { error: { code: string; message: string } };
            expect(error.error.code).toBe(`hapi_${phase}_transport_unavailable`);
            expect(error.error.message).not.toContain('approval'); expect(JSON.stringify(error)).not.toContain('private credential');
        }
        const denied = await post(value.baseUrl, 'codex-auto-review', { 'x-openai-subagent': 'guardian' });
        expect((await denied.json() as { error: { message: string } }).error.message).toContain('no approval was granted');
    });
    it('requires an engine-held capability before reading or routing a request', async () => {
        const upstream = vi.fn((req: IncomingMessage, res: ServerResponse) => {req.resume(); res.end(done);});
        const failure = vi.fn(); const url = await endpoint(upstream);
        const value = await router({openaiUrl:url,minimaxUrl:url,credential:async () => 'fake-mm',onReviewUnavailable:failure});
        const response = await fetch(`${value.baseUrl}/responses`, {method:'POST',headers:reviewHeaders,body:JSON.stringify({model:'codex-auto-review'})});
        expect(response.status).toBe(403); await response.text();
        const invalid = await fetch(`${value.baseUrl}/responses`, {method:'POST',headers:{...reviewHeaders,'x-hapi-minimax-router':'é'.repeat(64)},body:'{}'});
        expect(invalid.status).toBe(403); await invalid.text();
        expect(upstream).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled(); expect(value.isBlocked()).toBe(false);
    });
    it('reconstructs MiniMax authentication and drops all OpenAI identity headers', async () => {
        let received: IncomingMessage['headers'] = {};
        const url = await endpoint((req, res) => { received = req.headers; req.resume(); res.end(done); });
        const value = await router({ minimaxUrl: url, credential: async () => 'isolated-mini-credential' });
        await (await post(value.baseUrl, 'MiniMax-M3.1-Flash', { ...auth, cookie: 'private', 'chatgpt-account-id': 'private', 'x-openai-subagent': 'not-guardian' })).text();
        expect(received.authorization).toBe('Bearer isolated-mini-credential');
        expect(received.cookie).toBeUndefined(); expect(received['chatgpt-account-id']).toBeUndefined();
        expect(received['x-openai-subagent']).toBeUndefined();
        expect(received['x-hapi-minimax-router']).toBeUndefined();
    });
    it('preserves native OpenAI review instructions/schema and removes the foreign parent response', async () => {
        let received: IncomingMessage['headers'] = {}; let payload: any;
        const url = await endpoint((req, res) => {
            received = req.headers; const data: Buffer[] = [];
            req.on('data', part => data.push(part)); req.on('end', () => { payload = JSON.parse(Buffer.concat(data).toString()); res.end(done); });
        });
        const key = vi.fn(async () => 'must-not-be-read');
        const value = await router({ openaiUrl: url, credential: key });
        const extra = { instructions: 'unchanged native policy', text: { format: { type: 'json_schema', schema: { required: ['outcome'] } } },
            metadata: { parent_response_id: 'minimax-response', keep: 'unchanged' } };
        await (await post(value.baseUrl, 'codex-auto-review', { ...reviewHeaders, 'chatgpt-account-id': 'account' }, extra)).text();
        expect(received.authorization).toBe(auth.authorization); expect(received['chatgpt-account-id']).toBe('account');
        expect(payload).toMatchObject({ instructions: extra.instructions, text: extra.text, metadata: { keep: 'unchanged' } });
        expect(payload.metadata.parent_response_id).toBeUndefined(); expect(key).not.toHaveBeenCalled();
        expect(received['x-hapi-minimax-router']).toBeUndefined();
    });
    it('rejects unknown routes/models, absent auth and MiniMax self-review without upstream traffic', async () => {
        const upstream = vi.fn((req: IncomingMessage, res: ServerResponse) => { req.resume(); res.end(done); });
        const url = await endpoint(upstream); const value = await router({ openaiUrl: url, minimaxUrl: url });
        expect((await fetch(`${value.baseUrl}/models`)).status).toBe(404);
        expect((await post(value.baseUrl, 'arbitrary-model', reviewHeaders)).status).toBe(400);
        value.reset(); expect((await post(value.baseUrl, 'codex-auto-review', { 'x-openai-subagent': 'guardian' })).status).toBe(401);
        value.reset(); expect((await post(value.baseUrl, 'MiniMax-M3.1-Flash', reviewHeaders)).status).toBe(400);
        expect(upstream).not.toHaveBeenCalled();
    });
    it('opens the failure circuit once, blocks native retries and resets only explicitly', async () => {
        let calls = 0; const failure = vi.fn();
        const url = await endpoint((req, res) => { req.resume(); calls++; res.writeHead(503); res.end('failure'); });
        const value = await router({ openaiUrl: url, onReviewUnavailable: failure });
        for (let i = 0; i < 3; i++) await (await post(value.baseUrl, 'codex-auto-review', reviewHeaders)).text();
        expect(calls).toBe(1); expect(value.isBlocked()).toBe(true); expect(failure).toHaveBeenCalledOnce();
        value.reset(); await (await post(value.baseUrl, 'codex-auto-review', reviewHeaders)).text();
        expect(calls).toBe(2); expect(failure).toHaveBeenCalledTimes(2);
    });
    it('does not follow upstream redirects or send authentication to their destination', async () => {
        const target = vi.fn((req: IncomingMessage, res: ServerResponse) => { req.resume(); res.end(done); });
        const remote = await endpoint(target);
        const url = await endpoint((req, res) => { req.resume(); res.writeHead(307, { location: remote }); res.end(); });
        const value = await router({ openaiUrl: url });
        const response = await fetch(`${value.baseUrl}/responses`, { method: 'POST', redirect: 'manual', headers: {...reviewHeaders,'x-hapi-minimax-router':value.capability}, body: JSON.stringify({ model: 'codex-auto-review' }) });
        await response.text(); expect(response.status).toBe(502); expect(response.headers.get('location')).toBeNull(); expect(target).not.toHaveBeenCalled(); expect(value.isBlocked()).toBe(true);
    });
    it('detects truncated review streams, total timeouts and cancels disconnected callers', async () => {
        let closed = false;
        const url = await endpoint((req, res) => { req.resume(); res.once('close', () => { closed = true; }); });
        const value = await router({ openaiUrl: url, timeoutMs: 40 });
        expect((await post(value.baseUrl, 'codex-auto-review', reviewHeaders)).status).toBe(502);
        await vi.waitFor(() => expect(closed).toBe(true)); expect(value.isBlocked()).toBe(true);
        const partial = await endpoint((req, res) => { req.resume(); res.end('event: response.created\n\n'); });
        const other = await router({ openaiUrl: partial });
        await (await post(other.baseUrl, 'codex-auto-review', reviewHeaders)).text();
        await vi.waitFor(() => expect(other.isBlocked()).toBe(true));
    });
    it('keeps independent runtime circuits isolated', async () => {
        const failed = await endpoint((req, res) => { req.resume(); res.writeHead(500); res.end(); });
        const ok = await endpoint((req, res) => { req.resume(); res.end(done); });
        const a = await router({ openaiUrl: failed }); const b = await router({ openaiUrl: ok });
        await (await post(a.baseUrl, 'codex-auto-review', reviewHeaders)).text();
        await (await post(b.baseUrl, 'codex-auto-review', reviewHeaders)).text();
        expect(a.isBlocked()).toBe(true); expect(b.isBlocked()).toBe(false);
    });
    it('includes an unfinished request body in the total review deadline without upstream traffic', async () => {
        const upstream = vi.fn((req: IncomingMessage, res: ServerResponse) => { req.resume(); res.end(done); });
        const url = await endpoint(upstream); const failure = vi.fn();
        const value = await router({ openaiUrl: url, timeoutMs: 50, onReviewUnavailable: failure });
        const status = await new Promise<number | undefined>((resolve, reject) => {
            const request = httpRequest(`${value.baseUrl}/responses`, { method: 'POST',
                headers: { ...reviewHeaders, 'x-hapi-minimax-router': value.capability } },
                response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
            request.once('error', reject);
            request.write('{"model":"codex-auto-review","input":['); // deliberately never end the body
        });
        expect(status).toBe(502); expect(failure).toHaveBeenCalledOnce();
        expect(upstream).not.toHaveBeenCalled(); expect(value.counts().reviewRequests).toBe(0);
    });
    it('does not latch review failure when the caller disconnects while sending its body', async () => {
        const failure = vi.fn(); const value = await router({ onReviewUnavailable: failure, timeoutMs: 50 });
        const request = httpRequest(`${value.baseUrl}/responses`, { method: 'POST',
            headers: { ...reviewHeaders, 'x-hapi-minimax-router': value.capability } });
        request.on('error', () => {});
        request.write('{"model":"codex-auto-review"');
        await new Promise(resolve => setTimeout(resolve, 10)); request.destroy();
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(failure).not.toHaveBeenCalled(); expect(value.isBlocked()).toBe(false);
        expect(value.counts().reviewRequests).toBe(0);
    });
    it('keeps MiniMax task transport usable after a review rate-limit failure', async () => {
        const openai = await endpoint((req, res) => { req.resume(); res.writeHead(429); res.end('rate limited'); });
        const minimax = await endpoint((req, res) => { req.resume(); res.end(done); });
        const value = await router({ openaiUrl: openai, minimaxUrl: minimax, credential: async () => 'fake-mm' });
        expect((await post(value.baseUrl, 'codex-auto-review', reviewHeaders)).status).toBe(429);
        expect((await post(value.baseUrl, 'MiniMax-M3.1-Flash')).status).toBe(200);
        expect(value.counts()).toEqual({ reviewRequests: 1, taskRequests: 1 });
        expect(value.isBlocked()).toBe(true);
    });
    it('cancels a disconnected review without changing other sessions to manual mode', async () => {
        let started = false; let closed = false; const failure = vi.fn();
        const url = await endpoint((req, res) => { req.resume(); started = true; res.once('close', () => { closed = true; }); });
        const value = await router({ openaiUrl: url, onReviewUnavailable: failure });
        const abort = new AbortController();
        const pending = fetch(`${value.baseUrl}/responses`, {method:'POST', headers:{...reviewHeaders,'x-hapi-minimax-router':value.capability}, body:JSON.stringify({model:'codex-auto-review'}), signal:abort.signal});
        void pending.catch(() => {});
        await vi.waitFor(() => expect(started).toBe(true)); abort.abort(); await expect(pending).rejects.toThrow();
        await vi.waitFor(() => expect(closed).toBe(true)); expect(value.isBlocked()).toBe(false); expect(failure).not.toHaveBeenCalled();
    });
});
