/**
 * maintenanceRequestGateTests.ts — Bun test suite for maintenanceRequestGate.ts.
 *
 * The lead integrates this file as `maintenanceRequestGate.test.ts`; the import
 * path stays valid because the module keeps its name.
 *
 * Two groups:
 *  1. Real HTTP behaviour of the gate: forwarding, SSE streaming, denial
 *     (false / thrown / missing / non-boolean), route + method + upgrade
 *     rejection, upstream allowlist, exact official base path, no redirect
 *     following, fixed provider and binding, client disconnect and close()
 *     cleanup, the 32 MiB body limit, hop-by-hop headers named by a Connection
 *     header, compressed upstream bodies, upstream stream failures, upstream
 *     connection failures and a client that aborts mid-body.
 *  2. The native Codex tool-continuation scenario against the installed
 *     Codex 0.160 binary. It is opt-in: set HAPI_RUN_NATIVE_GATE_TESTS=1 and
 *     optionally CODEX_BIN to the absolute path of the executable.
 *
 * Nothing in this file was executed by its author (no shell). Every dynamic
 * result is the lead's to run and record.
 */
import { describe, expect, it } from 'bun:test';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { startMaintenanceRequestGate, type MaintenanceGateContext, type MaintenanceGateDecision, type MaintenanceRequestGate, type MaintenanceRequestGateCounts } from './maintenanceRequestGate';

type UpstreamRequest = { path: string; headers: Record<string, string | string[] | undefined>; body: string };
type UpstreamResponder = (request: IncomingMessage, response: ServerResponse, body: string, index: number) => void;

type FakeUpstream = {
    url: string;
    requests: UpstreamRequest[];
    /** Number of upstream connections that were closed. */
    closed: number;
    close: () => Promise<void>;
};

async function startUpstream(responder: UpstreamResponder): Promise<FakeUpstream> {
    const requests: UpstreamRequest[] = [];
    const state = { closed: 0 };
    const server = createServer((request, response) => {
        // Some cases destroy the socket on purpose; that must not crash the run.
        response.on('error', () => { /* the peer is gone */ });
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(Buffer.from(chunk)));
        // The socket close is the unambiguous "the peer went away" signal.
        request.socket.once('close', () => { state.closed++; });
        request.once('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            requests.push({ path: request.url ?? '', headers: request.headers, body });
            responder(request, response, body, requests.length - 1);
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        get closed() { return state.closed; },
        close: () => new Promise<void>(resolve => {
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => resolve());
        })
    };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

/** Raw WebSocket upgrade attempt; returns the status line of the reply. */
function rawUpgrade(baseUrl: string): Promise<string> {
    const url = new URL(baseUrl);
    return new Promise((resolve, reject) => {
        const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
            socket.write(`GET ${url.pathname}/responses HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\n`
                + 'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
        });
        let data = '';
        socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error('upgrade timed out')); });
        socket.on('data', chunk => {
            data += chunk.toString();
            if (data.includes('\r\n\r\n')) { socket.destroy(); resolve(data.split('\r\n')[0]); }
        });
        socket.on('error', error => reject(error));
    });
}

type RawResponse = { status: number; headers: Record<string, string>; body: string };

/**
 * Raw HTTP/1.1 POST over a socket: the exact bytes reach the server, so a
 * client library cannot normalise away the headers under test.
 */
function rawPost(baseUrl: string, path: string, headers: Record<string, string>, body: string): Promise<RawResponse> {
    const url = new URL(baseUrl);
    return new Promise<RawResponse>((resolve, reject) => {
        const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
            const head = [
                `POST ${path} HTTP/1.1`,
                `Host: ${url.host}`,
                ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
                `Content-Length: ${Buffer.byteLength(body)}`,
                '', body
            ].join('\r\n');
            socket.write(head);
        });
        let data = '';
        let done = false;
        const finish = (): void => {
            if (done) return;
            const separator = data.indexOf('\r\n\r\n');
            if (separator < 0) return;
            const lines = data.slice(0, separator).split('\r\n');
            const status = Number(lines[0].split(' ')[1] ?? 0);
            const parsed: Record<string, string> = {};
            for (const line of lines.slice(1)) {
                const index = line.indexOf(':');
                if (index > 0) parsed[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
            }
            const rest = data.slice(separator + 4);
            const length = Number(parsed['content-length'] ?? '-1');
            // Wait for the announced body, otherwise the headers are enough.
            if (length >= 0 && Buffer.byteLength(rest) < length) return;
            done = true;
            socket.destroy();
            resolve({ status, headers: parsed, body: rest });
        };
        socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error('raw request timed out')); });
        socket.on('data', chunk => { data += chunk.toString(); finish(); });
        socket.on('close', () => {
            if (done) return;
            if (data.includes('\r\n\r\n')) { finish(); return; }
            done = true;
            reject(new Error('raw request closed before a response'));
        });
        socket.on('error', error => reject(error));
    });
}

/** POST a body and report what the client observed (status, bytes, failure). */
type RelayOutcome = { status: number; bytes: number; failed: boolean };

async function postAndRead(baseUrl: string, body: string | Buffer): Promise<RelayOutcome> {
    return new Promise<RelayOutcome>((resolve, reject) => {
        const request = httpRequest(`${baseUrl}/responses`, { method: 'POST' }, response => {
            let bytes = 0;
            const finish = (failed: boolean): void => resolve({ status: response.statusCode ?? 0, bytes, failed });
            response.on('data', chunk => { bytes += chunk.length; });
            response.once('end', () => finish(false));
            response.once('aborted', () => finish(true));
            response.once('error', () => finish(true));
        });
        request.on('error', () => resolve({ status: 0, bytes: 0, failed: true }));
        request.end(body);
    });
}

/** POST a raw body and report the status and the response text. */
type RawPostOutcome = { status: number; body: string };

function postRawBody(baseUrl: string, payload: Buffer): Promise<RawPostOutcome> {
    return new Promise<RawPostOutcome>((resolve, reject) => {
        const request = httpRequest(`${baseUrl}/responses`, {
            method: 'POST', headers: { 'content-type': 'application/json' }
        }, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject);
        request.end(payload);
    });
}

describe('maintenance request gate', () => {
    it('refuses ambiguous base paths and raw or encoded control characters', async () => {
        const gate = async () => ({ allowed: true });
        for (const upstreamBaseUrl of [
            'http://127.0.0.1:9//outside.invalid',
            'http://127.0.0.1:9/\\outside.invalid',
            'http://127.0.0.1:9/a b',
            'http://127.0.0.1:9/%0a',
            'http://127.0.0.1:9/%00',
            'http://127.0.0.1:9/%7f',
            'http://127.0.0.1:9/%2f%2foutside.invalid',
            'http://127.0.0.1:9/%5coutside.invalid',
            'http://127.0.0.1:9/%zz',
            'http://127.0.0.1:9/a\tb'
        ]) {
            let service: Awaited<ReturnType<typeof startMaintenanceRequestGate>> | undefined;
            let rejected = false;
            try { service = await startMaintenanceRequestGate({ provider: 'openai', binding: 'origin-guard', upstreamBaseUrl, gate, allowLoopbackTest: true }); }
            catch { rejected = true; }
            finally { await service?.close(); }
            expect(rejected, upstreamBaseUrl).toBe(true);
        }
    });

    it('keeps a permitted base path on the configured origin', async () => {
        const upstream = await startUpstream((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}'); });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'origin-guard', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true, gate: async () => ({ allowed: true })
        });
        try {
            const response = await fetch(`${service.baseUrl}/responses`, { method: 'POST', body: '{}' });
            expect(response.status).toBe(200);
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].path).toBe('/v1/responses');
            expect(upstream.requests[0].headers.host).toBe(new URL(upstream.url).host);
        } finally {
            await service.close();
            await upstream.close();
        }
    });

    it('forwards POST /responses to the fixed upstream and returns its body', async () => {
        const upstream = await startUpstream((_request, response, body) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: true, model: JSON.parse(body).model }));
        });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true, gate: async () => ({ allowed: true })
        });
        try {
            const response = await fetch(`${service.baseUrl}/responses`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer model-token' },
                body: JSON.stringify({ model: 'gpt-test', input: [] })
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ ok: true, model: 'gpt-test' });
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].path).toBe('/v1/responses');
            expect(upstream.requests[0].headers.authorization).toBe('Bearer model-token');
            expect(upstream.requests[0].headers.cookie).toBeUndefined();
            expect(upstream.requests[0].headers['proxy-authorization']).toBeUndefined();
            expect(service.counts()).toEqual({ received: 1, blocked: 0, forwarded: 1 });
        } finally {
            await service.close();
            await upstream.close();
        }
    });

    it('streams upstream SSE bytes to the client', async () => {
        const upstream = await startUpstream((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            response.write('event: response.created\ndata: {"id":"1"}\n\n');
            setTimeout(() => {
                response.write('event: response.completed\ndata: {"id":"1"}\n\n');
                response.end();
            }, 30);
        });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true, gate: async () => ({ allowed: true })
        });
        try {
            const response = await fetch(`${service.baseUrl}/responses`, { method: 'POST', body: '{}' });
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/event-stream');
            const decoder = new TextDecoder();
            let text = '';
            for await (const chunk of response.body!) text += decoder.decode(chunk as Uint8Array, { stream: true });
            expect(text).toContain('event: response.created');
            expect(text).toContain('event: response.completed');
            expect(service.counts()).toEqual({ received: 1, blocked: 0, forwarded: 1 });
        } finally {
            await service.close();
            await upstream.close();
        }
    });

    it('blocks false, thrown, missing and non-boolean decisions with zero upstream requests', async () => {
        const decisions: Record<string, (context: MaintenanceGateContext) => Promise<MaintenanceGateDecision>> = {
            false: async () => ({ allowed: false }),
            thrown: async () => { throw new Error('quota probe failed'); },
            missing: async () => ({}) as unknown as MaintenanceGateDecision,
            nonBoolean: async () => ({ allowed: 'true' }) as unknown as MaintenanceGateDecision
        };
        const observed: Record<string, unknown> = {};
        for (const [name, decision] of Object.entries(decisions)) {
            const upstream = await startUpstream((_request, response) => { response.writeHead(200); response.end('{}'); });
            const service = await startMaintenanceRequestGate({
                provider: 'minimax', binding: 'binding-mm', upstreamBaseUrl: `${upstream.url}/v1`,
                allowLoopbackTest: true, gate: decision
            });
            const response = await fetch(`${service.baseUrl}/responses`, { method: 'POST', body: '{}' });
            observed[name] = {
                status: response.status,
                upstreamRequests: upstream.requests.length,
                counts: service.counts()
            };
            await service.close();
            await upstream.close();
        }
        const expected = { received: 1, blocked: 1, forwarded: 0 };
        expect(observed).toEqual({
            false: { status: 403, upstreamRequests: 0, counts: expected },
            thrown: { status: 403, upstreamRequests: 0, counts: expected },
            missing: { status: 403, upstreamRequests: 0, counts: expected },
            nonBoolean: { status: 403, upstreamRequests: 0, counts: expected }
        });
    });

    it('refuses a hanging gate decision with 403 after the local deadline and drops the late decision', async () => {
        const upstream = await startUpstream((_request, response) => { response.writeHead(200); response.end('{}'); });
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        // The decision is released only after the deadline answer was observed.
        const deferred: { release: () => void } = { release: () => { /* replaced below */ } };
        const pending = new Promise<boolean>(resolve => { deferred.release = () => resolve(true); });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true,
            gate: async () => { await pending; return { allowed: true }; }
        });
        try {
            // Real HTTP and real time: no fake clock is used here.
            const response = await fetch(`${service.baseUrl}/responses`, { method: 'POST', body: '{}' });
            expect(response.status).toBe(403);
            const payload = await response.json() as { error: { code: string } };
            expect(payload.error.code).toBe('maintenance_gate_timeout');
            // The late decision is dropped: it must not start an upstream
            // request, must not be replayed and must not raise an unhandled
            // rejection.
            deferred.release();
            await new Promise(resolve => setTimeout(resolve, 250));
            expect(upstream.requests).toHaveLength(0);
            expect(service.counts()).toEqual({ received: 1, blocked: 1, forwarded: 0 });
            expect(unhandled).toEqual([]);
        } finally {
            deferred.release();
            process.off('unhandledRejection', onUnhandled);
            await service.close();
            await upstream.close();
        }
    }, 45_000);

    it('rejects other methods, other paths and WebSocket upgrades before any upstream connection', async () => {
        const contexts: MaintenanceGateContext[] = [];
        const upstream = await startUpstream((_request, response) => { response.writeHead(200); response.end('{}'); });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true,
            gate: async context => { contexts.push(context); return { allowed: true }; }
        });
        try {
            expect((await fetch(`${service.baseUrl}/responses`)).status).toBe(405);
            expect((await fetch(`${service.baseUrl}/chat/completions`, { method: 'POST', body: '{}' })).status).toBe(404);
            expect((await fetch(`${service.baseUrl}/responses/compact`, { method: 'POST', body: '{}' })).status).toBe(200);
            expect(await rawUpgrade(service.baseUrl)).toContain('403');
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].path).toBe('/v1/responses/compact');
            // Only the allowed route reached the gate callback, with the relative path.
            expect(contexts).toEqual([{ provider: 'openai', binding: 'binding-1', path: '/responses/compact' }]);
            expect(service.counts()).toEqual({ received: 4, blocked: 3, forwarded: 1 });
        } finally {
            await service.close();
            await upstream.close();
        }
    });

    it('refuses to start with an upstream outside the provider allowlist', async () => {
        const gate = async () => ({ allowed: true });
        await expect(startMaintenanceRequestGate({ provider: 'openai', binding: 'b', upstreamBaseUrl: 'https://api.minimax.cn/v1', gate })).rejects.toThrow();
        await expect(startMaintenanceRequestGate({ provider: 'minimax', binding: 'b', upstreamBaseUrl: 'https://api.openai.com/v1', gate })).rejects.toThrow();
        await expect(startMaintenanceRequestGate({ provider: 'openai', binding: 'b', upstreamBaseUrl: 'https://evil.example/v1', gate })).rejects.toThrow();
        await expect(startMaintenanceRequestGate({ provider: 'openai', binding: 'b', upstreamBaseUrl: 'http://127.0.0.1:9/v1', gate })).rejects.toThrow();
        const official = await startMaintenanceRequestGate({ provider: 'openai', binding: 'b', upstreamBaseUrl: 'https://chatgpt.com/backend-api/codex', gate });
        await official.close();
    });

    it('accepts only the exact configured official base path, without query or fragment', async () => {
        for (const upstreamBaseUrl of [
            'https://api.openai.com/v1-other',
            'https://api.openai.com/v1/arbitrary',
            'https://chatgpt.com/backend-api/codex-other',
            'https://api.openai.com/v1?override=true',
            'https://api.openai.com/v1#fragment',
            'https://user:secret@api.openai.com/v1',
            'https://api.openai.com:8443/v1'
        ]) {
            let service: Awaited<ReturnType<typeof startMaintenanceRequestGate>> | undefined;
            let rejected = false;
            try { service = await startMaintenanceRequestGate({ provider: 'openai', binding: 'boundary-test', upstreamBaseUrl, gate: async () => ({ allowed: true }) }); }
            catch { rejected = true; }
            finally { await service?.close(); }
            expect(rejected, upstreamBaseUrl).toBe(true);
        }
        // The exact official paths are still accepted.
        for (const upstreamBaseUrl of ['https://api.openai.com/v1', 'https://chatgpt.com/backend-api/codex']) {
            const service = await startMaintenanceRequestGate({ provider: 'openai', binding: 'boundary-test', upstreamBaseUrl, gate: async () => ({ allowed: true }) });
            await service.close();
        }
    });

    it('does not follow upstream redirects and never retries', async () => {
        const target = await startUpstream((_request, response) => { response.writeHead(200); response.end('redirect-target'); });
        const upstream = await startUpstream((_request, response) => {
            response.writeHead(302, { location: `${target.url}/v1/responses` });
            response.end();
        });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true, gate: async () => ({ allowed: true })
        });
        try {
            const response = await fetch(`${service.baseUrl}/responses`, { method: 'POST', body: '{}' });
            expect(response.status).toBe(502);
            expect(upstream.requests).toHaveLength(1);
            expect(target.requests).toHaveLength(0);
            expect(service.counts()).toEqual({ received: 1, blocked: 1, forwarded: 0 });
        } finally {
            await service.close();
            await upstream.close();
            await target.close();
        }
    });

    it('keeps provider and binding fixed and ignores client attempts to select them', async () => {
        const contexts: MaintenanceGateContext[] = [];
        const upstream = await startUpstream((_request, response) => { response.writeHead(200); response.end('{}'); });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true,
            gate: async context => { contexts.push(context); return { allowed: true }; }
        });
        try {
            await new Promise<void>((resolve, reject) => {
                const request = httpRequest(`${service.baseUrl}/responses`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', host: 'evil.example', 'x-provider': 'minimax', 'x-binding': 'other-binding' }
                }, response => { response.resume(); response.once('end', () => resolve()); });
                request.on('error', reject);
                request.end(JSON.stringify({ model: 'gpt-test', provider: 'minimax', binding: 'other-binding' }));
            });
            expect(contexts).toHaveLength(1);
            expect(contexts[0]).toEqual({ provider: 'openai', binding: 'binding-1', path: '/responses' });
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].headers.host).toBe(new URL(upstream.url).host);
            expect(upstream.requests[0].headers['x-provider']).toBe('minimax');
        } finally {
            await service.close();
            await upstream.close();
        }
    });

    it('closes the upstream when the client disconnects and stops serving after close()', async () => {
        const upstream = await startUpstream(() => { /* never answers: the request stays in flight */ });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true, gate: async () => ({ allowed: true })
        });
        const controller = new AbortController();
        const pending = fetch(`${service.baseUrl}/responses`, { method: 'POST', body: '{}', signal: controller.signal }).catch(() => undefined);
        await waitFor(() => upstream.requests.length === 1, 5_000, 'the upstream request');
        controller.abort();
        await pending;
        await waitFor(() => upstream.closed >= 1, 5_000, 'the upstream socket to close');
        expect(upstream.closed).toBeGreaterThanOrEqual(1);
        await waitFor(() => service.counts().blocked === 1, 5_000, 'the disconnected request to be counted');
        // The upstream request had already been sent, so this request is
        // blocked: that includes a request whose upstream call went out but
        // whose response was never relayed. It is not "no upstream traffic"
        // and it is never replayed automatically.
        expect(upstream.requests).toHaveLength(1);
        expect(service.counts()).toEqual({ received: 1, blocked: 1, forwarded: 0 });
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(upstream.requests).toHaveLength(1);
        await service.close();
        let failed = false;
        try { await fetch(`${service.baseUrl}/responses`, { method: 'POST', body: '{}' }); } catch { failed = true; }
        expect(failed).toBe(true);
        await upstream.close();
    });

    it('refuses a body above the 32 MiB limit with 413 and zero upstream requests', async () => {
        const upstream = await startUpstream((_request, response) => { response.writeHead(200); response.end('{}'); });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true, gate: async () => ({ allowed: true })
        });
        try {
            const payload = Buffer.alloc(32 * 1024 * 1024 + 1, 0x61);
            const outcome = await new Promise<{ status: number; body: string }>((resolve, reject) => {
                const request = httpRequest(`${service.baseUrl}/responses`, {
                    method: 'POST', headers: { 'content-type': 'application/json' }
                }, response => {
                    const chunks: Buffer[] = [];
                    response.on('data', chunk => chunks.push(Buffer.from(chunk)));
                    response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
                });
                request.on('error', reject);
                request.end(payload);
            });
            expect(outcome.status).toBe(413);
            expect(JSON.parse(outcome.body).error.code).toBe('maintenance_body_too_large');
            // The limit is enforced before the gate is consulted and before any
            // upstream connection exists.
            expect(upstream.requests).toHaveLength(0);
            expect(service.counts()).toEqual({ received: 1, blocked: 1, forwarded: 0 });
        } finally {
            await service.close();
            await upstream.close();
        }
    });

    it('accepts a body of exactly 32 MiB and refuses 32 MiB + 1 byte before the gate is consulted', async () => {
        const upstream = await startUpstream((_request, response) => { response.writeHead(200); response.end('{}'); });
        let gateCalls = 0;
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true,
            gate: async () => { gateCalls++; return { allowed: true }; }
        });
        try {
            // Exactly 32 MiB is within the limit and is forwarded.
            const accepted = await postRawBody(service.baseUrl, Buffer.alloc(32 * 1024 * 1024, 0x61));
            expect(accepted.status).toBe(200);
            expect(gateCalls).toBe(1);
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].body.length).toBe(32 * 1024 * 1024);
            expect(service.counts()).toEqual({ received: 1, blocked: 0, forwarded: 1 });

            // One byte more is refused before the gate is consulted: the gate
            // call count does not grow and no upstream request is made. The
            // reader may still drain the remaining bytes (the drain
            // allowance), so the total bytes read can exceed 32 MiB.
            const refused = await postRawBody(service.baseUrl, Buffer.alloc(32 * 1024 * 1024 + 1, 0x61));
            expect(refused.status).toBe(413);
            expect(JSON.parse(refused.body).error.code).toBe('maintenance_body_too_large');
            expect(gateCalls).toBe(1);
            expect(upstream.requests).toHaveLength(1);
            expect(service.counts()).toEqual({ received: 2, blocked: 1, forwarded: 1 });
        } finally {
            await service.close();
            await upstream.close();
        }
    }, 60_000);

    it('never forwards hop-by-hop headers named by a Connection header', async () => {
        const upstream = await startUpstream((_request, response) => {
            response.writeHead(200, {
                'content-type': 'text/plain',
                'content-length': '4',
                connection: 'x-upstream-hop',
                'x-upstream-hop': 'upstream-secret',
                'x-kept': 'kept-value'
            });
            response.end('body');
        });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true, gate: async () => ({ allowed: true })
        });
        try {
            const path = new URL(`${service.baseUrl}/responses`).pathname;
            const response = await rawPost(service.baseUrl, path, {
                'content-type': 'application/json',
                connection: 'x-client-hop',
                'x-client-hop': 'client-secret',
                'x-kept': 'kept-value'
            }, '{}');
            expect(response.status).toBe(200);
            expect(response.body).toBe('body');
            // Client side: the header named by the client Connection header is
            // gone, and the hop token list itself is not propagated upstream.
            // (The upstream may still see Node's own Connection header.)
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].headers['x-client-hop']).toBeUndefined();
            expect(String(upstream.requests[0].headers.connection ?? '')).not.toContain('x-client-hop');
            expect(upstream.requests[0].headers['x-kept']).toBe('kept-value');
            // Upstream side: the header named by the upstream Connection header
            // is gone (the server may add its own Connection header).
            expect(response.headers['x-upstream-hop']).toBeUndefined();
            expect(String(response.headers.connection ?? '')).not.toContain('x-upstream-hop');
            expect(response.headers['x-kept']).toBe('kept-value');
            expect(service.counts()).toEqual({ received: 1, blocked: 0, forwarded: 1 });
        } finally {
            await service.close();
            await upstream.close();
        }
    });

    it('decodes a compressed upstream body instead of relaying it under a stripped header', async () => {
        const upstream = await startUpstream((_request, response) => {
            const payload = gzipSync(Buffer.from(JSON.stringify({ ok: true })));
            response.writeHead(200, {
                'content-type': 'application/json',
                'content-encoding': 'gzip',
                'content-length': String(payload.length)
            });
            response.end(payload);
        });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true, gate: async () => ({ allowed: true })
        });
        try {
            const response = await fetch(`${service.baseUrl}/responses`, { method: 'POST', body: '{}' });
            expect(response.status).toBe(200);
            // The body is decoded here, so the encoding header must not claim
            // that the relayed bytes are still compressed.
            expect(response.headers.get('content-encoding')).toBeNull();
            expect(await response.json()).toEqual({ ok: true });
            expect(service.counts()).toEqual({ received: 1, blocked: 0, forwarded: 1 });
        } finally {
            await service.close();
            await upstream.close();
        }
    });

    it('refuses an unsupported content encoding with 502 and relays no bytes', async () => {
        const upstream = await startUpstream((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'exotic' });
            response.end('opaque-bytes');
        });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true, gate: async () => ({ allowed: true })
        });
        try {
            const response = await fetch(`${service.baseUrl}/responses`, { method: 'POST', body: '{}' });
            expect(response.status).toBe(502);
            const payload = await response.json() as { error: { code: string } };
            expect(payload.error.code).toBe('maintenance_upstream_encoding_rejected');
            expect(service.counts()).toEqual({ received: 1, blocked: 1, forwarded: 0 });
        } finally {
            await service.close();
            await upstream.close();
        }
    });

    for (const refusedStatus of [302, 200]) {
        it(`contains stream errors while discarding a ${refusedStatus === 302 ? 'redirect' : 'unsupported encoding'} body`, async () => {
            const upstream = await startUpstream((_request, response, _body, index) => {
                if (index > 0) { response.writeHead(200); response.end('healthy'); return; }
                response.writeHead(refusedStatus, {
                    'content-type': 'text/plain', 'content-length': '4096',
                    ...(refusedStatus === 302
                        ? { location: 'http://127.0.0.1:9/must-not-follow' }
                        : { 'content-encoding': 'exotic' })
                });
                response.write('incomplete');
                setTimeout(() => response.socket?.destroy(), 20);
            });
            const service = await startMaintenanceRequestGate({
                provider: 'openai', binding: 'early-stream-error', upstreamBaseUrl: `${upstream.url}/v1`,
                allowLoopbackTest: true, gate: async () => ({ allowed: true })
            });
            try {
                const refused = await fetch(`${service.baseUrl}/responses`, { method: 'POST', body: '{}' });
                expect(refused.status).toBe(502);
                const payload = await refused.json() as { error: { code: string } };
                expect(payload.error.code).toBe(refusedStatus === 302
                    ? 'maintenance_upstream_redirect_rejected' : 'maintenance_upstream_encoding_rejected');
                await waitFor(() => upstream.closed > 0, 5_000, 'discarded upstream socket close');
                const healthy = await fetch(`${service.baseUrl}/responses`, { method: 'POST', body: '{}' });
                expect(healthy.status).toBe(200);
                expect(await healthy.text()).toBe('healthy');
                expect(upstream.requests).toHaveLength(2);
                expect(service.counts()).toEqual({ received: 2, blocked: 1, forwarded: 1 });
            } finally {
                await service.close();
                await upstream.close();
            }
        });
    }

    it('ends the client response when the upstream stream fails and never retries', async () => {
        const upstream = await startUpstream((_request, response) => {
            // The upstream announces 4096 bytes but dies after 64 of them.
            response.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': '4096' });
            response.write('x'.repeat(64));
            setTimeout(() => { response.socket?.destroy(); }, 20);
        });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true, gate: async () => ({ allowed: true })
        });
        try {
            const outcome = await postAndRead(service.baseUrl, '{}');
            // The client must not be left with a silently truncated body.
            expect(outcome.failed || outcome.bytes < 4096).toBe(true);
            // No retry: exactly one upstream request, and the relayed response
            // is still reported as forwarded (never as "zero upstream").
            expect(upstream.requests).toHaveLength(1);
            expect(service.counts()).toEqual({ received: 1, blocked: 0, forwarded: 1 });
        } finally {
            await service.close();
            await upstream.close();
        }
    });

    it('reports 502 and blocks the request when the upstream connection fails', async () => {
        const upstream = await startUpstream((_request, response) => { response.writeHead(200); response.end('{}'); });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true, gate: async () => ({ allowed: true })
        });
        await upstream.close();
        try {
            const response = await fetch(`${service.baseUrl}/responses`, { method: 'POST', body: '{}' });
            expect(response.status).toBe(502);
            const payload = await response.json() as { error: { code: string } };
            expect(payload.error.code).toBe('maintenance_upstream_error');
            expect(service.counts()).toEqual({ received: 1, blocked: 1, forwarded: 0 });
        } finally {
            await service.close();
        }
    });

    it('opens no upstream connection and raises no unhandled rejection when the client aborts mid-body', async () => {
        const upstream = await startUpstream((_request, response) => { response.writeHead(200); response.end('{}'); });
        const service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'binding-1', upstreamBaseUrl: `${upstream.url}/v1`,
            allowLoopbackTest: true, gate: async () => ({ allowed: true })
        });
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
        const onUncaught = (error: unknown): void => { unhandled.push(error); };
        process.on('unhandledRejection', onUnhandled);
        process.on('uncaughtException', onUncaught);
        try {
            const url = new URL(`${service.baseUrl}/responses`);
            const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
                socket.write(`POST ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n`
                    + 'Content-Type: application/json\r\nContent-Length: 4096\r\n\r\npartial-body');
                setTimeout(() => socket.destroy(), 25);
            });
            await new Promise<void>(resolve => socket.once('close', () => resolve()));
            await waitFor(() => service.counts().blocked === 1, 5_000, 'the aborted request to be counted');
            expect(upstream.requests).toHaveLength(0);
            expect(service.counts()).toEqual({ received: 1, blocked: 1, forwarded: 0 });
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
            process.off('uncaughtException', onUncaught);
            await service.close();
            await upstream.close();
        }
    });
});

/* ------------------------------------------------------------------ */
/* Native Codex tool continuation (opt-in; executed by the lead).       */
/* ------------------------------------------------------------------ */

const NATIVE_ENABLED = process.env.HAPI_RUN_NATIVE_GATE_TESTS === '1';
const nativeSuite = NATIVE_ENABLED ? describe : describe.skip;

async function resolveCodexBinary(): Promise<string> {
    const candidates = [
        process.env.CODEX_BIN,
        '/usr/local/bin/codex',
        '/usr/bin/codex',
        '/home/ubuntu/.local/bin/codex',
        '/home/ubuntu/.codex/bin/codex'
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const candidate of candidates) {
        try {
            const info = await stat(candidate);
            if (info.isFile()) return candidate;
        } catch { /* try the next candidate */ }
    }
    throw new Error('No installed Codex binary found. Set CODEX_BIN to the absolute path of the Codex 0.160 executable.');
}

async function readCodexVersion(binary: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', chunk => { out += chunk.toString(); });
        child.once('error', reject);
        child.once('close', () => resolve(out.trim()));
    });
}

type NativeOutcome = {
    status: string;
    upstreamResponses: number;
    counts: MaintenanceRequestGateCounts;
    gatePaths: string[];
    approvals: number;
    proof: string;
    stderr: string;
    events: string[];
};

/** One native turn: the first answer asks for a harmless exec_command, the second answer completes. */
async function runNativeScenario(binary: string, denyAfterFirst: boolean): Promise<NativeOutcome> {
    const home = await mkdtemp('/tmp/hapi-gate-native-');
    const cwd = join(home, 'work');
    await mkdir(cwd);
    const proof = join(cwd, 'gate-proof.txt');
    let upstreamResponses = 0;
    const upstream = createServer((request, response) => {
        // Transport failures of the fixture are contained here; the
        // assertions below still decide the result.
        request.on('error', () => { /* the peer is gone */ });
        response.on('error', () => { /* the peer is gone */ });
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(Buffer.from(chunk)));
        request.once('end', () => {
            // This fixture serves exactly POST /v1/responses; every other
            // route is refused with 404 and is never counted.
            if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
            upstreamResponses++;
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: unknown[] };
            const outputs = Array.isArray(payload.input)
                ? payload.input.filter(item => (item as { type?: string })?.type === 'function_call_output')
                : [];
            const id = randomUUID();
            const item = outputs.length === 0
                ? {
                    type: 'function_call', call_id: `exec_${id}`, name: 'exec_command',
                    arguments: JSON.stringify({ cmd: `printf GATE_PROOF > ${JSON.stringify(proof)}`, workdir: cwd })
                }
                : { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'done' }] };
            const frames = [
                { type: 'response.created', response: { id } },
                { type: 'response.output_item.done', item },
                { type: 'response.completed', response: { id, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }
            ];
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
        });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    let gateCalls = 0;
    const gatePaths: string[] = [];
    let service: MaintenanceRequestGate | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    try {
        service = await startMaintenanceRequestGate({
            provider: 'openai', binding: 'native-gate-fixture',
            upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
            allowLoopbackTest: true,
            gate: async context => {
                gateCalls++;
                gatePaths.push(context.path);
                return { allowed: denyAfterFirst ? gateCalls === 1 : true };
            }
        });

        // The provider base_url is the gate base URL: Codex appends "/responses" to it.
        const settings: Record<string, unknown> = {
            'model_providers.isolated_gate.name': 'Isolated Maintenance Gate',
            'model_providers.isolated_gate.base_url': service.baseUrl,
            'model_providers.isolated_gate.wire_api': 'responses',
            'model_providers.isolated_gate.requires_openai_auth': false,
            'model_providers.isolated_gate.supports_websockets': false,
            'model_providers.isolated_gate.request_max_retries': 0,
            'model_providers.isolated_gate.stream_max_retries': 0,
            'analytics.enabled': false, 'feedback.enabled': false, project_doc_max_bytes: 0,
            web_search: 'disabled', 'features.plugins': false, 'features.remote_plugin': false, 'features.apps': false
        };
        const args = Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);

        // MCP/apps tools are approved automatically. The previous fixture asked
        // for a prompt ("prompt"), which would stall the native turn instead
        // of letting the tool call run.
        await writeFile(join(home, 'config.toml'), '[apps._default]\ndefault_tools_approval_mode = "approve"\n');
        // Slim environment on purpose: if the native binary needs more, add it here explicitly.
        // The key is a local placeholder; no real credential and no official
        // model call is possible because the provider base URL is the gate.
        const env = {
            PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: home, TMPDIR: '/tmp',
            LANG: process.env.LANG ?? 'C.UTF-8', OPENAI_API_KEY: 'isolated-local-key'
        };
        child = spawn(binary, ['app-server', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
        const events: any[] = [];
        const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
        let serial = 0;
        let approvals = 0;
        const lines = createInterface({ input: child.stdout! });
        lines.on('line', line => {
            let value: any;
            try { value = JSON.parse(line); } catch { return; }
            if (value.method) { events.push(value); if (value.id != null) approvals++; return; }
            const waiting = pending.get(value.id);
            pending.delete(value.id);
            if (!waiting) return;
            if (value.error) waiting.reject(new Error(JSON.stringify(value.error)));
            else waiting.resolve(value.result);
        });
        const rpc = (method: string, params: unknown, timeoutMs = 30_000): Promise<any> => new Promise((resolve, reject) => {
            const id = ++serial;
            const timer = setTimeout(() => reject(new Error(`Native ${method} timed out: ${stderr.slice(-1200)}`)), timeoutMs);
            pending.set(id, {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); }
            });
            child!.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
        });
        await rpc('initialize', { clientInfo: { name: 'maintenance-gate-native-proof', version: '1' }, capabilities: { experimentalApi: true } });
        child.stdin!.write(JSON.stringify({ method: 'initialized' }) + '\n');
        const thread = await rpc('thread/start', {
            cwd, model: 'gpt-6.1-sol', modelProvider: 'isolated_gate',
            sandbox: 'danger-full-access', approvalPolicy: 'never'
        });
        const begun = await rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'GATE_PROBE' }] });
        await waitFor(() => events.some(event => event.method === 'turn/completed' && event.params?.turn?.id === begun.turn.id), 60_000, 'the native turn to complete');
        const ended = events.find(event => event.method === 'turn/completed' && event.params?.turn?.id === begun.turn.id);
        const proofText = await readFile(proof, 'utf8').catch(() => '');
        return {
            status: String(ended?.params?.turn?.status ?? 'unknown'),
            upstreamResponses,
            counts: service.counts(),
            gatePaths,
            approvals,
            proof: proofText,
            stderr: stderr.slice(-1200),
            events: events.map(event => String(event.method))
        };
    } finally {
        if (child) {
            child.kill('SIGTERM');
            await new Promise<void>(resolve => {
                const timer = setTimeout(() => { child!.kill('SIGKILL'); resolve(); }, 3_000);
                child!.once('exit', () => { clearTimeout(timer); resolve(); });
            });
        }
        await service?.close();
        (upstream as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
        await rm(home, { recursive: true, force: true });
    }
}

nativeSuite('native Codex tool continuation through the gate', () => {
    it('completes the tool continuation when the gate allows every request', async () => {
        const binary = await resolveCodexBinary();
        const version = await readCodexVersion(binary);
        if (!version.includes('0.160')) {
            throw new Error(`CONTRACT.md pins Codex 0.160, but ${binary} reports "${version}". Set CODEX_BIN to the pinned executable.`);
        }
        const outcome = await runNativeScenario(binary, false);
        expect({
            status: outcome.status,
            upstreamResponses: outcome.upstreamResponses,
            forwarded: outcome.counts.forwarded,
            blocked: outcome.counts.blocked,
            gatePaths: outcome.gatePaths,
            approvals: outcome.approvals,
            proof: outcome.proof,
            stderr: outcome.stderr.slice(0, 300)
        }).toMatchObject({ status: 'completed', approvals: 0, proof: 'GATE_PROOF' });
        // The exact count of 2 is a property of this fixed fixture (the tool
        // call plus the follow-up); it is not a general rule about how many
        // upstream calls a real task may make.
        expect(outcome.upstreamResponses).toBe(2);
        expect(outcome.counts.received).toBe(2);
        expect(outcome.counts.forwarded).toBe(2);
        expect(outcome.counts.blocked).toBe(0);
        expect(new Set(outcome.gatePaths)).toEqual(new Set(['/responses']));
    }, 180_000);

    it('blocks the post-tool model request with 403 and ends the native turn as failed', async () => {
        const binary = await resolveCodexBinary();
        const version = await readCodexVersion(binary);
        if (!version.includes('0.160')) {
            throw new Error(`CONTRACT.md pins Codex 0.160, but ${binary} reports "${version}". Set CODEX_BIN to the pinned executable.`);
        }
        const outcome = await runNativeScenario(binary, true);
        expect({
            status: outcome.status,
            upstreamResponses: outcome.upstreamResponses,
            forwarded: outcome.counts.forwarded,
            blocked: outcome.counts.blocked,
            gatePaths: outcome.gatePaths,
            approvals: outcome.approvals,
            proof: outcome.proof,
            stderr: outcome.stderr.slice(0, 300)
        }).toMatchObject({ status: 'failed', upstreamResponses: 1, forwarded: 1, approvals: 0, proof: 'GATE_PROOF' });
        expect(outcome.counts.received).toBe(2);
        expect(outcome.counts.blocked).toBe(1);
        expect(outcome.gatePaths.length).toBe(2);
    }, 180_000);
});
