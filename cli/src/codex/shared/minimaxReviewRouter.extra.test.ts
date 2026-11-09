/**
 * Supplemental review-transport tests for the pre-release candidate.
 *
 * Target under review : cli/src/codex/shared/minimaxReviewRouter.ts (the transport only).
 * How to run           : copy this file to cli/src/codex/shared/review-extra.test.ts
 *                       and run it with Vitest next to minimaxReviewRouter.test.ts.
 *
 * Rules honoured by this file
 *  - No real upstream and no real credential: every upstream is a local fake http server on
 *    127.0.0.1 with an ephemeral port, and the MiniMax credential is always injected as the
 *    fake token 'fake-mm'. The default credential helper (/usr/bin/python3 native_auth.py)
 *    is never reached.
 *  - Every fake server and every router instance is closed in afterEach, in reverse order.
 *  - Every response body is consumed, so no socket stays half read when the test ends.
 *  - The OpenAI token used here is the fake token 'fake-oa'.
 *
 * Adopted from MiniMax; lead updated defect characterizations to assert repaired behaviour.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { startMiniMaxReviewRouter } from './minimaxReviewRouter';

const cleanup: Array<() => Promise<unknown>> = [];
const capabilities = new Map<string, string>();
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function endpoint(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    const server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/responses`;
}

async function router(options: Parameters<typeof startMiniMaxReviewRouter>[0]) {
    const value = await startMiniMaxReviewRouter(options);
    cleanup.push(value.close); capabilities.set(value.baseUrl, value.capability);
    return value;
}

const done = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"mock"}}\n\n';
const auth = { authorization: 'Bearer fake-oa', 'content-type': 'application/json' };
const reviewHeaders = { ...auth, 'x-openai-subagent': 'guardian' };
const compatReviewHeaders = { ...auth, 'x-codex-guardian': 'reviewer' };

const post = (base: string, model: string, headers: Record<string, string> = auth) =>
    fetch(`${base}/responses`, { method: 'POST', headers: {...headers, 'x-hapi-minimax-router':capabilities.get(base)!}, body: JSON.stringify({ model, input: [] }) });

const rawPost = (base: string, body: string | Buffer, headers: Record<string, string>) =>
    fetch(`${base}/responses`, { method: 'POST', headers: {...headers, 'x-hapi-minimax-router':capabilities.get(base)!}, body });

const sse = (res: ServerResponse, body: Buffer) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body); };

describe('supplemental: chunked SSE byte transparency', () => {
    it('forwards the upstream SSE bytes unchanged, including a UTF-8 character split across chunks', async () => {
        const head = Buffer.from('event: response.output_text.delta\ndata: {"delta":"', 'utf8');
        const cjk = Buffer.from('\u5ba1', 'utf8'); // three bytes, deliberately split
        const tail = Buffer.from('"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n', 'utf8');
        const expected = Buffer.concat([head, cjk, tail]);
        const url = await endpoint((req, res) => {
            req.resume();
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(head);
            res.write(cjk.subarray(0, 1));
            res.write(cjk.subarray(1));
            res.end(tail);
        });
        const value = await router({ openaiUrl: url });
        const response = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        const received = Buffer.from(await response.arrayBuffer());
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(received.equals(expected)).toBe(true);
        expect(value.isBlocked()).toBe(false);
    });

    it('forwards the MiniMax task body byte for byte', async () => {
        let received = Buffer.alloc(0);
        const url = await endpoint((req, res) => {
            const data: Buffer[] = [];
            req.on('data', part => data.push(part));
            req.on('end', () => { received = Buffer.concat(data); res.end(done); });
        });
        const value = await router({ minimaxUrl: url, credential: async () => 'fake-mm' });
        const body = '{ "model" : "MiniMax-M3.1-Flash" ,  "input" : [ ] }';
        await (await rawPost(value.baseUrl, body, { 'content-type': 'application/json' })).text();
        expect(received.toString('utf8')).toBe(body);
    });

    it('routes only the exact path and method, and never reaches the upstream for the rest', async () => {
        const upstream = vi.fn((req: IncomingMessage, res: ServerResponse) => { req.resume(); res.end(done); });
        const url = await endpoint(upstream);
        const value = await router({ openaiUrl: url, minimaxUrl: url, credential: async () => 'fake-mm' });
        const query = await fetch(`${value.baseUrl}/responses?trace=1`, { method: 'POST', headers: reviewHeaders, body: '{}' });
        expect(query.status).toBe(404);
        await query.text();
        const method = await fetch(`${value.baseUrl}/responses`, { method: 'GET', headers: reviewHeaders });
        expect(method.status).toBe(404);
        await method.text();
        const other = await fetch(`${value.baseUrl}/models`, { method: 'POST', headers: reviewHeaders, body: '{}' });
        expect(other.status).toBe(404);
        await other.text();
        expect(upstream).not.toHaveBeenCalled();
        expect(value.isBlocked()).toBe(false);
    });
});

describe('supplemental: guardian flags, unknown and spoofed', () => {
    it('accepts the native guardian flag and the compatible reviewer flag as review traffic', async () => {
        const seen: IncomingMessage['headers'][] = [];
        const url = await endpoint((req, res) => { seen.push(req.headers); req.resume(); res.end(done); });
        const value = await router({ openaiUrl: url, minimaxUrl: url, credential: async () => 'fake-mm' });
        const first = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        const second = await post(value.baseUrl, 'gpt-5.6-luna', compatReviewHeaders);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        await first.text();
        await second.text();
        expect(seen).toHaveLength(2);
        expect(seen.every(headers => headers.authorization === 'Bearer fake-oa')).toBe(true);
        expect(value.isBlocked()).toBe(false);
    });

    it('never treats an unknown flag value as review traffic and never opens the circuit for it', async () => {
        const upstream = vi.fn((req: IncomingMessage, res: ServerResponse) => { req.resume(); res.end(done); });
        const url = await endpoint(upstream);
        const value = await router({ openaiUrl: url, minimaxUrl: url, credential: async () => 'fake-mm' });
        const variants: Array<Record<string, string>> = [
            { 'x-openai-subagent': 'Guardian' },
            { 'x-openai-subagent': 'guardian2' },
            { 'x-openai-subagent': 'not-guardian' },
            { 'x-codex-guardian': 'REVIEWER' },
            { 'x-codex-guardian': 'review' }
        ];
        for (const variant of variants) {
            const response = await post(value.baseUrl, 'codex-auto-review', { ...auth, ...variant });
            expect(response.status).toBe(400);
            await response.text();
        }
        expect(upstream).not.toHaveBeenCalled();
        expect(value.isBlocked()).toBe(false);
    });

    it('ignores a duplicated guardian header instead of guessing', async () => {
        const upstream = vi.fn((req: IncomingMessage, res: ServerResponse) => { req.resume(); res.end(done); });
        const url = await endpoint(upstream);
        const value = await router({ openaiUrl: url, minimaxUrl: url, credential: async () => 'fake-mm' });
        const headers = new Headers({ ...auth });
        headers.append('x-openai-subagent', 'guardian');
        headers.append('x-openai-subagent', 'other');
        headers.set('x-hapi-minimax-router', value.capability);
        const response = await fetch(`${value.baseUrl}/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'codex-auto-review' }) });
        expect(response.status).toBe(400);
        await response.text();
        expect(upstream).not.toHaveBeenCalled();
        expect(value.isBlocked()).toBe(false);
    });

    it('refuses a MiniMax model that claims to be a native review and opens the circuit', async () => {
        const upstream = vi.fn((req: IncomingMessage, res: ServerResponse) => { req.resume(); res.end(done); });
        const url = await endpoint(upstream);
        const failure = vi.fn();
        const value = await router({ openaiUrl: url, minimaxUrl: url, credential: async () => 'fake-mm', onReviewUnavailable: failure });
        const native = await post(value.baseUrl, 'MiniMax-M3.1-Flash', reviewHeaders);
        expect(native.status).toBe(400);
        await native.text();
        expect(value.isBlocked()).toBe(true);
        expect(failure).toHaveBeenCalledOnce();
        value.reset();
        const compatible = await post(value.baseUrl, 'MiniMax-M3.1-Flash', compatReviewHeaders);
        expect(compatible.status).toBe(400);
        await compatible.text();
        expect(value.isBlocked()).toBe(true);
        expect(failure).toHaveBeenCalledTimes(2);
        expect(upstream).not.toHaveBeenCalled();
    });

    it('keeps the OpenAI credential and the MiniMax credential on separate paths', async () => {
        const seen: Array<{ authorization?: string; body: string }> = [];
        const url = await endpoint((req, res) => {
            const data: Buffer[] = [];
            req.on('data', part => data.push(part));
            req.on('end', () => {
                seen.push({ authorization: req.headers.authorization, body: Buffer.concat(data).toString('utf8') });
                res.end(done);
            });
        });
        const credential = vi.fn(async () => 'fake-mm');
        const value = await router({ openaiUrl: url, minimaxUrl: url, credential });
        await (await post(value.baseUrl, 'codex-auto-review', reviewHeaders)).text();
        await (await post(value.baseUrl, 'MiniMax-M3.1-Flash', auth)).text();
        expect(seen).toHaveLength(2);
        const review = seen.find(item => item.body.includes('codex-auto-review'));
        const task = seen.find(item => item.body.includes('MiniMax-M3.1-Flash'));
        expect(review?.authorization).toBe('Bearer fake-oa');
        expect(task?.authorization).toBe('Bearer fake-mm');
        expect(seen.some(item => item.authorization === 'Bearer fake-oa' && item.body.includes('MiniMax-M3.1-Flash'))).toBe(false);
        expect(seen.some(item => item.authorization === 'Bearer fake-mm' && item.body.includes('codex-auto-review'))).toBe(false);
        expect(credential).toHaveBeenCalledTimes(1);
    });
});

describe('supplemental: transport failure versus a review rejection', () => {
    it('treats a completed rejection as a normal success and keeps the circuit closed', async () => {
        const rejection = 'event: response.output_text.delta\ndata: {"delta":"deny: the change is not approved"}\n\n' + done;
        const failure = vi.fn();
        const url = await endpoint((req, res) => { req.resume(); res.end(rejection); });
        const value = await router({ openaiUrl: url, onReviewUnavailable: failure });
        const response = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).toContain('deny: the change is not approved');
        expect(value.isBlocked()).toBe(false);
        expect(failure).not.toHaveBeenCalled();
    });

    it('opens the circuit once for a failing upstream and never replays the request', async () => {
        let calls = 0;
        const failure = vi.fn();
        const url = await endpoint((req, res) => { req.resume(); calls++; res.writeHead(500); res.end('boom'); });
        const value = await router({ openaiUrl: url, onReviewUnavailable: failure });
        for (let index = 0; index < 3; index++) await (await post(value.baseUrl, 'codex-auto-review', reviewHeaders)).text();
        expect(calls).toBe(1);
        expect(value.isBlocked()).toBe(true);
        expect(failure).toHaveBeenCalledOnce();
        const blocked = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(blocked.status).toBe(503);
        expect(await blocked.text()).toContain('no approval was granted');
        expect(calls).toBe(1);
    });

    it('cuts a silent upstream at the single total deadline and reports it as a transport error', async () => {
        let calls = 0;
        const url = await endpoint((req, res) => { req.resume(); calls++; });
        const value = await router({ openaiUrl: url, timeoutMs: 80 });
        const response = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(response.status).toBe(502);
        expect(await response.text()).toContain('no approval was granted');
        expect(calls).toBe(1);
        await vi.waitFor(() => expect(value.isBlocked()).toBe(true));
    });

    it('cuts a progressing stream at the total deadline after the status was already forwarded', async () => {


        let calls = 0;
        const url = await endpoint((req, res) => {
            req.resume(); calls++;
            const timer = setInterval(() => res.write('event: response.in_progress\n\n'), 10);
            res.once('close', () => clearInterval(timer));
        });
        const value = await router({ openaiUrl: url, timeoutMs: 150 });
        const response = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(response.status).toBe(200);
        await expect(response.text()).rejects.toThrow();
        expect(calls).toBe(1);
        await vi.waitFor(() => expect(value.isBlocked()).toBe(true));
    });

    it('reports a truncated review stream as unavailable although the status was already 200', async () => {
        const failure = vi.fn();
        const url = await endpoint((req, res) => { req.resume(); res.end('event: response.created\n\n'); });
        const value = await router({ openaiUrl: url, onReviewUnavailable: failure });
        const response = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(response.status).toBe(200);
        await response.text();
        await vi.waitFor(() => expect(value.isBlocked()).toBe(true));
        expect(failure).toHaveBeenCalledOnce();
    });
});

describe('supplemental: compression safety', () => {
    it('rejects a compressed request body before any upstream traffic and reports the review as unavailable', async () => {
        const upstream = vi.fn((req: IncomingMessage, res: ServerResponse) => { req.resume(); res.end(done); });
        const failure = vi.fn();
        const url = await endpoint(upstream);
        const value = await router({ openaiUrl: url, minimaxUrl: url, credential: async () => 'fake-mm', onReviewUnavailable: failure });
        const response = await rawPost(value.baseUrl, gzipSync(Buffer.from(JSON.stringify({ model: 'codex-auto-review' }))),
            { ...reviewHeaders, 'content-encoding': 'gzip' });
        expect(response.status).toBe(415);
        expect(await response.text()).toContain('no approval was granted');
        expect(upstream).not.toHaveBeenCalled();
        expect(value.isBlocked()).toBe(true);
        expect(failure).toHaveBeenCalledOnce();
    });

    it('accepts an identity encoded body', async () => {
        const url = await endpoint((req, res) => { req.resume(); res.end(done); });
        const value = await router({ openaiUrl: url });
        const response = await rawPost(value.baseUrl, JSON.stringify({ model: 'codex-auto-review' }),
            { ...reviewHeaders, 'content-encoding': 'identity' });
        expect(response.status).toBe(200);
        await response.text();
        expect(value.isBlocked()).toBe(false);
    });

    it('regression D4: a compressed task request does not change review mode', async () => {




        const failure = vi.fn();
        const url = await endpoint((req, res) => { req.resume(); res.end(done); });
        const value = await router({ openaiUrl: url, minimaxUrl: url, credential: async () => 'fake-mm', onReviewUnavailable: failure });
        const response = await rawPost(value.baseUrl, gzipSync(Buffer.from(JSON.stringify({ model: 'MiniMax-M3.1-Flash' }))),
            { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        expect(response.status).toBe(415);
        await response.text();
        expect(value.isBlocked()).toBe(false);
        expect(failure).not.toHaveBeenCalled();
    });

    it('regression D3: rejects unsupported compressed review output before forwarding', async () => {




        const url = await endpoint((req, res) => {
            req.resume();
            res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
            res.end(gzipSync(Buffer.from(done, 'utf8')));
        });
        const value = await router({ openaiUrl: url });
        const response = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(response.status).toBe(502);
        expect(await response.text()).toContain('no approval was granted');
        await vi.waitFor(() => expect(value.isBlocked()).toBe(true));
    });
});

describe('supplemental: independent requests are never cached and never replayed', () => {
    it('serves every review request independently', async () => {
        let calls = 0;
        const url = await endpoint((req, res) => {
            req.resume(); calls++;
            res.end(done.replace('"id":"mock"', `"id":"mock-${calls}"`));
        });
        const value = await router({ openaiUrl: url });
        const first = await (await post(value.baseUrl, 'codex-auto-review', reviewHeaders)).text();
        const second = await (await post(value.baseUrl, 'codex-auto-review', reviewHeaders)).text();
        expect(calls).toBe(2);
        expect(first).toContain('mock-1');
        expect(second).toContain('mock-2');
        expect(value.counts().reviewRequests).toBe(2);
        expect(value.counts().taskRequests).toBe(0);
    });

    it('fetches the MiniMax credential per task request and never for review traffic', async () => {
        const credential = vi.fn(async () => 'fake-mm');
        const url = await endpoint((req, res) => { req.resume(); res.end(done); });
        const value = await router({ openaiUrl: url, minimaxUrl: url, credential });
        await (await post(value.baseUrl, 'codex-auto-review', reviewHeaders)).text();
        expect(credential).not.toHaveBeenCalled();
        await (await post(value.baseUrl, 'MiniMax-M3.1-Flash', auth)).text();
        await (await post(value.baseUrl, 'MiniMax-M3.1-Flash', auth)).text();
        expect(credential).toHaveBeenCalledTimes(2);
        expect(value.counts().taskRequests).toBe(2);
    });

    it('keeps the MiniMax task path alive while the review circuit is open', async () => {
        const reviewCalls: string[] = [];
        const taskCalls: string[] = [];
        const failure = vi.fn();
        const url = await endpoint((req, res) => {
            const data: Buffer[] = [];
            req.on('data', part => data.push(part));
            req.on('end', () => {
                const body = Buffer.concat(data).toString('utf8');
                if (body.includes('codex-auto-review')) {
                    reviewCalls.push(req.headers.authorization ?? '');
                    res.writeHead(500); res.end('boom');
                } else {
                    taskCalls.push(req.headers.authorization ?? '');
                    res.end(done);
                }
            });
        });
        const value = await router({ openaiUrl: url, minimaxUrl: url, credential: async () => 'fake-mm', onReviewUnavailable: failure });
        const failed = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(failed.status).toBe(500);
        await failed.text();
        await vi.waitFor(() => expect(value.isBlocked()).toBe(true));
        const task = await post(value.baseUrl, 'MiniMax-M3.1-Flash', auth);
        expect(task.status).toBe(200);
        await task.text();
        expect(reviewCalls).toEqual(['Bearer fake-oa']);
        expect(taskCalls).toEqual(['Bearer fake-mm']);
    });

    it('answers a blocked review locally with 503 and without any upstream traffic', async () => {
        let calls = 0;
        const url = await endpoint((req, res) => { req.resume(); calls++; res.writeHead(500); res.end('boom'); });
        const value = await router({ openaiUrl: url });
        await (await post(value.baseUrl, 'codex-auto-review', reviewHeaders)).text();
        await vi.waitFor(() => expect(value.isBlocked()).toBe(true));
        const blocked = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(blocked.status).toBe(503);
        expect(await blocked.text()).toContain('no approval was granted');
        expect(calls).toBe(1);
    });
});

describe('supplemental: regressions and explicit transport policy', () => {
    it('regression D1: detects completion at the beginning of a large frame', async () => {








        const frame = `event: response.completed\ndata: {"type":"response.completed","pad":"${'x'.repeat(64_000)}"}\n\n`;
        const url = await endpoint((req, res) => { req.resume(); sse(res, Buffer.from(frame, 'utf8')); });
        const failure = vi.fn();
        const value = await router({ openaiUrl: url, onReviewUnavailable: failure });
        const response = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(response.status).toBe(200);
        await response.text();
        await vi.waitFor(() => expect(value.isBlocked()).toBe(false));
        expect(failure).not.toHaveBeenCalled();
    });

    it('regression D1: detects completion beyond the old 4096 character limit', async () => {



        const frame = `data: {"type"${' '.repeat(5_000)}: "response.completed"}\n\n`;
        const url = await endpoint((req, res) => { req.resume(); sse(res, Buffer.from(frame, 'utf8')); });
        const value = await router({ openaiUrl: url });
        const response = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(response.status).toBe(200);
        await response.text();
        await vi.waitFor(() => expect(value.isBlocked()).toBe(false));
    });

    it('regression D1: detects completion at the end of a large frame', async () => {


        const frame = `data: {"pad":"${'x'.repeat(64_000)}"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n`;
        const url = await endpoint((req, res) => { req.resume(); sse(res, Buffer.from(frame, 'utf8')); });
        const value = await router({ openaiUrl: url });
        const response = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(response.status).toBe(200);
        await response.text();
        expect(value.isBlocked()).toBe(false);
    });

    it('regression D2: malformed review input triggers manual recovery', async () => {




        const failure = vi.fn();
        const upstream = vi.fn((req: IncomingMessage, res: ServerResponse) => { req.resume(); res.end(done); });
        const url = await endpoint(upstream);
        const value = await router({ openaiUrl: url, onReviewUnavailable: failure });
        const broken = await rawPost(value.baseUrl, 'this is not json', reviewHeaders);
        expect(broken.status).toBe(502);
        expect(await broken.text()).toContain('no approval was granted');
        const array = await rawPost(value.baseUrl, '[1,2]', reviewHeaders);
        expect(array.status).toBe(400);
        await array.text();
        expect(upstream).not.toHaveBeenCalled();
        expect(value.isBlocked()).toBe(true);
        expect(failure).toHaveBeenCalledOnce();
    });

    it('regression D5: accepts a case-insensitive bearer scheme', async () => {



        const upstream = vi.fn((req: IncomingMessage, res: ServerResponse) => { req.resume(); res.end(done); });
        const failure = vi.fn();
        const url = await endpoint(upstream);
        const value = await router({ openaiUrl: url, onReviewUnavailable: failure });
        const response = await post(value.baseUrl, 'codex-auto-review', { ...reviewHeaders, authorization: 'bearer fake-oa' });
        expect(response.status).toBe(200);
        await response.text();
        expect(upstream).toHaveBeenCalledOnce();
        expect(value.isBlocked()).toBe(false);
        expect(failure).not.toHaveBeenCalled();
    });

    it('policy: rate limits require explicit recovery and are never retried automatically', async () => {



        let calls = 0;
        const url = await endpoint((req, res) => { req.resume(); calls++; res.writeHead(429); res.end('slow down'); });
        const value = await router({ openaiUrl: url });
        const limited = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(limited.status).toBe(429);
        await limited.text();
        await vi.waitFor(() => expect(value.isBlocked()).toBe(true));
        const blocked = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(blocked.status).toBe(503);
        await blocked.text();
        expect(calls).toBe(1);
        value.reset();
        const again = await post(value.baseUrl, 'codex-auto-review', reviewHeaders);
        expect(again.status).toBe(429);
        await again.text();
        expect(calls).toBe(2);
    });

    it('regression D8: preserves review bytes when no foreign parent needs removal', async () => {




        let payload = '';
        const url = await endpoint((req, res) => {
            const data: Buffer[] = [];
            req.on('data', part => data.push(part));
            req.on('end', () => { payload = Buffer.concat(data).toString('utf8'); res.end(done); });
        });
        const value = await router({ openaiUrl: url });
        await (await rawPost(value.baseUrl, '{"model":"codex-auto-review",  "metadata":{"value":1e400,"dup":1,"dup":2}}', reviewHeaders)).text();
        expect(payload).toContain('1e400');
        expect(payload).not.toContain('"value":null');
        expect(payload.match(/"dup"/g)).toHaveLength(2);
    });

    it('policy: strips unneeded cookies and retains native bearer authentication', async () => {




        let received: IncomingMessage['headers'] = {};
        const url = await endpoint((req, res) => { received = req.headers; req.resume(); res.end(done); });
        const value = await router({ openaiUrl: url });
        await (await post(value.baseUrl, 'codex-auto-review', { ...reviewHeaders, cookie: 'session=fake-oa-cookie' })).text();
        expect(received.cookie).toBeUndefined();
        expect(received.authorization).toBe('Bearer fake-oa');
    });
});
