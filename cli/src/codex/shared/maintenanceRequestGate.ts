/**
 * maintenanceRequestGate.ts — reusable per-request gate for the maintenance path.
 *
 * Transport only. Policy is delegated to the injected `gate` callback, which is
 * consulted after a bounded read of the request and before any upstream HTTP
 * request is initiated. See CONTRACT.md §5-§6.
 *
 * Fixed properties:
 *  - the listener is 127.0.0.1 on a random port under a random 32-byte path
 *    prefix; that prefix is the capability and is never logged or echoed;
 *  - provider and binding come from configuration, never from the request;
 *  - only POST <base>/responses and POST <base>/responses/compact are served;
 *    other methods, other paths and WebSocket upgrades are refused before any
 *    upstream connection exists;
 *  - the upstream is fixed by configuration and limited to the official HTTPS
 *    origin and the exact base path of that provider ('/v1' for the OpenAI and
 *    MiniMax APIs, '/backend-api/codex' for chatgpt.com). A query, a fragment,
 *    userinfo or a port disqualifies the URL; a path that merely starts with
 *    the base path (e.g. '/v1-other', '/v1/arbitrary') is refused as well.
 *    Loopback (127.0.0.1, plain HTTP) is reachable only with the explicit
 *    allowLoopbackTest switch. No other host, no redirect following;
 *  - no automatic retry, no body/Authorization/capability logging;
 *  - close() only tears down this service's own sockets and outbound requests.
 *
 * Cancellation evidence (measured, not guessed): consuming a request body
 * leaves `request.destroyed === true` while `request.aborted === false`,
 * `complete === true` and the response is still writable (Bun 1.4.0 probe,
 * body-lifecycle.json). Only `request.aborted`, `response.destroyed` and
 * `response.writableEnded` are used as "the client is gone" evidence;
 * `request.destroyed` is never used, because it also fires on a normal,
 * fully consumed request and would silently drop every healthy request.
 *
 * Bodies: the request body is read with a hard 32 MiB limit. A read error
 * (client abort, socket failure) is returned as a controlled result instead of
 * escaping as an unhandled promise rejection. An over-sized body is refused
 * with 413 while the remaining bytes are drained, so the client still gets
 * the answer and the connection stays usable.
 *
 * Gate decision: the injected `gate` callback is awaited under a local
 * processing deadline of 30 seconds. A deadline overrun is refused with 403
 * and the explicit timeout error code 'maintenance_gate_timeout', without any
 * upstream request. A decision that arrives after the deadline is dropped: it
 * must not start an upstream request, must not be replayed and must not raise
 * an unhandled rejection. The 30 seconds bound only this module's own wait
 * for the callback; it is not a quota window, not a retry budget and not a
 * quota-recovery criterion.
 *
 * Responses: the upstream body is relayed byte for byte. If the upstream
 * nevertheless answers with a content encoding, the body is decoded here
 * (gzip/deflate/br) and the encoding header is removed together with the
 * now-wrong content length; an unsupported encoding is refused with 502
 * instead of relaying compressed bytes under a stripped header. Hop-by-hop
 * headers named by a Connection header (client side and upstream side) are
 * never forwarded.
 *
 * Counting (exact partition of the received traffic):
 *  - received: requests (and upgrade attempts) that reached this gate;
 *  - forwarded: requests whose upstream response (status and headers) was
 *    relayed to the client. A body that fails afterwards is still a forwarded
 *    request; such a request must never be reported as "no upstream traffic"
 *    and must never be replayed automatically;
 *  - blocked: requests that produced no relayed upstream response (route or
 *    method refusal, upgrade, gate refusal or gate failure, refused redirect,
 *    unreadable or over-sized body, upstream failure, client disconnect before
 *    the relay).
 */
import { createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { Duplex, Transform } from 'node:stream';

export type MaintenanceProvider = 'openai' | 'minimax';

export type MaintenanceGateContext = {
    provider: MaintenanceProvider;
    binding: string;
    /** Relative request path ('/responses' or '/responses/compact'); never the capability prefix. */
    path: string;
};

export type MaintenanceGateDecision = { allowed: boolean };

export type MaintenanceRequestGateOptions = {
    provider: MaintenanceProvider;
    binding: string;
    upstreamBaseUrl: string;
    gate: (context: MaintenanceGateContext) => Promise<MaintenanceGateDecision>;
    allowLoopbackTest?: boolean;
};

export type MaintenanceRequestGateCounts = { received: number; blocked: number; forwarded: number };

export type MaintenanceRequestGate = {
    baseUrl: string;
    close: () => Promise<void>;
    counts: () => MaintenanceRequestGateCounts;
};

const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Extra bytes that may be drained (and discarded) after the limit was hit. */
const DRAIN_ALLOWANCE_BYTES = MAX_BODY_BYTES;
const UPSTREAM_IDLE_TIMEOUT_MS = 180_000;
/**
 * Local processing deadline for the injected gate decision.
 *
 * It bounds only how long this module waits for the callback. It is not a
 * quota window, not a retry budget and not a quota-recovery criterion, and it
 * is deliberately not configurable: production must never be able to wait
 * without a bound.
 */
const GATE_DECISION_TIMEOUT_MS = 30_000;
const ALLOWED_PATHS = ['/responses', '/responses/compact'] as const;
/** Hop-by-hop, proxy and credential-bearing request headers that are never forwarded. */
const DROPPED_REQUEST_HEADERS = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
    'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'content-length',
    'accept-encoding', 'expect'
]);
/**
 * Hop-by-hop and location/cookie headers are dropped.
 * `content-encoding` is NOT in this set: the body is relayed verbatim, so the
 * header must stay with the bytes unless the body is decoded first (see
 * `relayUpstream`); `content-length` is handled next to it for the same
 * reason.
 */
const DROPPED_RESPONSE_HEADERS = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
    'trailer', 'transfer-encoding', 'upgrade', 'set-cookie', 'location'
]);

type UpstreamTarget = { origin: string; basePath: string };

type BodyRead =
    | { kind: 'ok'; body: Buffer }
    | { kind: 'too-large' }
    | { kind: 'error' };

/** Header value as a single string (Node may hand over an array). */
function headerValue(value: string | string[] | undefined): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.join(',');
    return '';
}

/**
 * Header names listed in a Connection header are hop-by-hop for this hop and
 * must not be forwarded, in either direction.
 */
function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
    const tokens = new Set<string>();
    const raw = headers['connection'];
    const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    for (const value of values) {
        for (const part of value.split(',')) {
            const token = part.trim().toLowerCase();
            if (token) tokens.add(token);
        }
    }
    return tokens;
}

/** Decoder for the content encodings this transport is willing to unwrap. */
function createDecoder(encoding: string): Transform | null {
    switch (encoding) {
        case 'gzip':
        case 'x-gzip':
            return createGunzip();
        case 'deflate':
            return createInflate();
        case 'br':
            return createBrotliDecompress();
        default:
            return null;
    }
}

/**
 * Official upstream allowlist; loopback is only reachable with
 * allowLoopbackTest === true. The base path must match exactly: '/v1' for the
 * OpenAI and MiniMax APIs, '/backend-api/codex' for chatgpt.com.
 */
function resolveUpstream(provider: MaintenanceProvider, upstreamBaseUrl: string, allowLoopbackTest: boolean): UpstreamTarget | null {
    // URL parsing normalises raw whitespace and backslashes. Reject those
    // characters before parsing, rather than silently accepting a new target.
    if (typeof upstreamBaseUrl !== 'string' || /[\s\\\u0000-\u001f\u007f]/.test(upstreamBaseUrl)) return null;
    let url: URL;
    try { url = new URL(upstreamBaseUrl); } catch { return null; }
    // A query, a fragment or userinfo would silently change the target.
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
    const basePath = url.pathname.replace(/\/+$/, '');
    let decodedPath: string;
    try { decodedPath = decodeURIComponent(basePath); } catch { return null; }
    // Reject ambiguous authority/path delimiters, including encoded controls.
    // The outbound origin is independently checked at the request boundary.
    if (decodedPath.startsWith('//') || /[\s\\?#\u0000-\u001f\u007f]/.test(decodedPath)) return null;
    if (allowLoopbackTest && url.protocol === 'http:' && url.hostname === '127.0.0.1') {
        return { origin: url.origin, basePath };
    }
    if (url.protocol !== 'https:' || url.port !== '') return null;
    const official = provider === 'openai'
        ? ((url.hostname === 'chatgpt.com' && basePath === '/backend-api/codex')
            || (url.hostname === 'api.openai.com' && basePath === '/v1'))
        : (url.hostname === 'api.minimax.cn' && basePath === '/v1');
    return official ? { origin: url.origin, basePath } : null;
}

/**
 * Bounded read of the request body.
 *
 * - 'ok': the body was read completely and is within the limit;
 * - 'too-large': the limit was exceeded. The read resolves immediately, the
 *   remaining bytes are drained and discarded so the client still receives the
 *   413 answer;
 * - 'error': the client aborted or the socket failed. The error is contained
 *   here; it never escapes as an unhandled rejection.
 */
function readBounded(request: IncomingMessage, limit: number): Promise<BodyRead> {
    return new Promise<BodyRead>(resolve => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const settle = (result: BodyRead): void => {
            if (settled) return;
            settled = true;
            request.removeListener('data', onData);
            request.removeListener('end', onEnd);
            request.removeListener('error', onError);
            request.removeListener('aborted', onAborted);
            resolve(result);
        };
        function onData(chunk: Buffer): void {
            size += chunk.length;
            if (size > limit) {
                chunks.length = 0;
                request.removeListener('data', onData);
                request.on('data', onDrain);
                settle({ kind: 'too-large' });
                return;
            }
            chunks.push(Buffer.from(chunk));
        }
        function onDrain(chunk: Buffer): void {
            size += chunk.length;
            if (size > limit + DRAIN_ALLOWANCE_BYTES) request.destroy();
        }
        function onEnd(): void { settle({ kind: 'ok', body: Buffer.concat(chunks) }); }
        function onError(): void { settle({ kind: 'error' }); }
        function onAborted(): void { settle({ kind: 'error' }); }
        request.on('data', onData);
        request.once('end', onEnd);
        request.once('error', onError);
        request.once('aborted', onAborted);
    });
}

/** Consume and discard the rest of a request body; bounded. */
function drain(request: IncomingMessage): void {
    let size = 0;
    request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES + DRAIN_ALLOWANCE_BYTES) request.destroy();
    });
    request.resume();
}

/**
 * Outcome of the bounded wait for the injected gate decision.
 */
type GateOutcome =
    | { kind: 'decided'; decision: unknown }
    | { kind: 'failed' }
    | { kind: 'timeout' };

/**
 * Await the injected gate decision under a local processing deadline.
 *
 * The derived promise never rejects: a decision (or a rejection) that
 * arrives after the deadline cannot surface as an unhandled rejection, and a
 * late decision is dropped here, so it can never start an upstream request.
 * The timer is always cleared, on the timeout path as well.
 */
function awaitGateDecision(decision: Promise<MaintenanceGateDecision> | MaintenanceGateDecision, timeoutMs: number): Promise<GateOutcome> {
    const settled: Promise<GateOutcome> = Promise.resolve(decision).then(
        (value): GateOutcome => ({ kind: 'decided', decision: value }),
        (): GateOutcome => ({ kind: 'failed' })
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<GateOutcome>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    });
    return Promise.race([settled, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

export async function startMaintenanceRequestGate(options: MaintenanceRequestGateOptions): Promise<MaintenanceRequestGate> {
    if (options.provider !== 'openai' && options.provider !== 'minimax') throw new Error('Unsupported provider');
    if (typeof options.binding !== 'string' || options.binding.length === 0) throw new Error('A non-empty binding is required');
    if (typeof options.gate !== 'function') throw new Error('A gate function is required');
    const resolvedUpstream = resolveUpstream(options.provider, options.upstreamBaseUrl, options.allowLoopbackTest === true);
    if (!resolvedUpstream) throw new Error('Upstream base URL is not allowed for this provider');
    const upstream: UpstreamTarget = resolvedUpstream;

    const prefix = `/${randomBytes(32).toString('hex')}`;
    const counts = { received: 0, blocked: 0, forwarded: 0 };
    const outbound = new Set<ClientRequest>();
    const sockets = new Set<Duplex>();
    const upgradeSockets = new Set<Duplex>();
    let closed = false;

    async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
        counts.received++;
        // Permanent sinks: a client that vanishes must not raise an unhandled
        // 'error' event on the request or on the response.
        request.on('error', () => { /* the peer is gone; nothing can be relayed */ });
        response.on('error', () => { /* the client vanished mid-relay */ });

        // Every request is settled exactly once: relayed (forwarded) or refused (blocked).
        let settled = false;
        const settleBlocked = (): void => { if (!settled) { settled = true; counts.blocked++; } };
        const settleForwarded = (): void => { if (!settled) { settled = true; counts.forwarded++; } };
        let upstreamRequest: ClientRequest | undefined;
        let clientGone = false;
        /**
         * 'close'   - answer, close the connection and drain the request;
         * 'destroy' - answer, then destroy the request socket;
         * 'leave'   - answer and leave the request stream to the caller.
         */
        const refuse = (status: number, code: string, message: string, mode: 'close' | 'destroy' | 'leave' = 'close'): void => {
            settleBlocked();
            try {
                if (!response.writableEnded && !response.destroyed) {
                    const headers: OutgoingHttpHeaders = {
                        'content-type': 'application/json', 'cache-control': 'no-store'
                    };
                    if (mode !== 'leave') headers.connection = 'close';
                    response.writeHead(status, headers);
                    response.end(JSON.stringify({ error: { code, message } }));
                }
            } catch { /* the peer is already gone */ }
            if (mode === 'destroy') response.once('finish', () => request.destroy());
            else if (mode === 'close') drain(request);
        };
        // The disconnect watcher is registered before the first await: a client
        // that leaves during the read or during the gate decision must be seen
        // there, not only once the upstream request exists.
        response.once('close', () => {
            if (response.writableEnded) return;
            clientGone = true;
            settleBlocked();
            try { upstreamRequest?.destroy(); } catch { /* the peer is already gone */ }
        });

        if (closed) { refuse(503, 'maintenance_gate_closed', 'The gate is closed.'); return; }
        const url = request.url ?? '';
        const path = ALLOWED_PATHS.find(candidate => url === `${prefix}${candidate}`);
        if (!path) {
            refuse(404, 'maintenance_route_not_allowed', 'Only POST /responses and POST /responses/compact are served.');
            return;
        }
        if (request.method !== 'POST') {
            refuse(405, 'maintenance_method_not_allowed', 'Only POST is served by this gate.');
            return;
        }
        // Bounded read first, then the gate, then (and only then) an upstream request.
        const body = await readBounded(request, MAX_BODY_BYTES);
        if (body.kind === 'error') {
            // The client aborted or the socket failed: no upstream request, no
            // unhandled rejection, the request is counted as blocked.
            refuse(400, 'maintenance_request_read_failed', 'The request body could not be read.', 'leave');
            return;
        }
        if (body.kind === 'too-large') {
            // The drain of the remaining bytes is still running; the connection
            // is left usable so the 413 really reaches the client.
            refuse(413, 'maintenance_body_too_large', 'Request body exceeds the 32 MiB limit.', 'leave');
            return;
        }
        const bytes = body.body;
        // `request.destroyed` is NOT evidence of a cancellation (see the header
        // comment); only the aborted/destroyed/writableEnded evidence is used.
        if (closed || clientGone || request.aborted || response.destroyed || response.writableEnded) { settleBlocked(); return; }

        let decision: unknown;
        try {
            const outcome = await awaitGateDecision(
                options.gate({ provider: options.provider, binding: options.binding, path }),
                GATE_DECISION_TIMEOUT_MS
            );
            if (outcome.kind === 'timeout') {
                // The local processing deadline won. A decision that arrives
                // later is dropped: no upstream request, no replay and no
                // unhandled rejection.
                refuse(403, 'maintenance_gate_timeout', `The gate decision did not arrive within ${GATE_DECISION_TIMEOUT_MS} ms; no upstream request was made.`);
                return;
            }
            if (outcome.kind === 'failed') {
                refuse(403, 'maintenance_gate_error', 'The gate decision failed; no upstream request was made.');
                return;
            }
            decision = outcome.decision;
        } catch {
            refuse(403, 'maintenance_gate_error', 'The gate decision failed; no upstream request was made.');
            return;
        }
        if (!decision || typeof decision !== 'object' || (decision as { allowed?: unknown }).allowed !== true) {
            refuse(403, 'maintenance_gate_denied', 'The gate did not allow this request; no upstream request was made.');
            return;
        }
        if (closed || clientGone || request.aborted || response.destroyed || response.writableEnded) { settleBlocked(); return; }

        const headers: OutgoingHttpHeaders = {};
        const hopByHop = connectionTokens(request.headers);
        for (const [key, value] of Object.entries(request.headers)) {
            if (value === undefined) continue;
            const lower = key.toLowerCase();
            if (DROPPED_REQUEST_HEADERS.has(lower)) continue;
            // A header named by the client Connection header is hop-by-hop.
            if (hopByHop.has(lower)) continue;
            headers[key] = value;
        }
        headers['accept-encoding'] = 'identity';
        headers['content-length'] = bytes.length;
        // Compose against the full origin string instead of a relative
        // reference: a relative reference beginning with '//' would be read
        // as an authority and silently leave the configured host.
        const target = new URL(`${upstream.origin}${upstream.basePath}${path}`);
        if (target.origin !== upstream.origin) {
            refuse(502, 'maintenance_upstream_target_invalid', 'The upstream target left the configured origin.');
            return;
        }

        const relayUpstream = (result: IncomingMessage): void => {
            // Even discarded redirect/unsupported-encoding bodies can emit
            // 'error' while being drained. Install a sink before any early
            // return; successful relays also attach their teardown handler.
            result.on('error', () => { /* discarded or failed upstream stream */ });
            const status = result.statusCode ?? 502;
            if (status >= 300 && status < 400) {
                result.resume();
                refuse(502, 'maintenance_upstream_redirect_rejected', 'Upstream redirect was refused.');
                return;
            }
            const encoding = headerValue(result.headers['content-encoding']).trim().toLowerCase();
            const compressed = encoding !== '' && encoding !== 'identity';
            let decoder: Transform | null = null;
            if (compressed) {
                decoder = createDecoder(encoding);
                if (!decoder) {
                    // Neither relay the bytes under a stripped header nor guess.
                    result.resume();
                    refuse(502, 'maintenance_upstream_encoding_rejected', 'The upstream used an unsupported content encoding.');
                    return;
                }
            }
            const resultHeaders = { ...result.headers } as OutgoingHttpHeaders;
            for (const key of Object.keys(resultHeaders)) {
                if (DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) delete resultHeaders[key];
            }
            // A header named by the upstream Connection header is hop-by-hop too.
            for (const token of connectionTokens(result.headers)) delete resultHeaders[token];
            if (decoder) {
                // The body is decoded here, so neither the encoding nor the
                // original length describes the bytes that are relayed.
                delete resultHeaders['content-encoding'];
                delete resultHeaders['content-length'];
            }
            try {
                response.writeHead(status, resultHeaders);
            } catch {
                // Nothing was relayed, so this request is a blocked one.
                settleBlocked();
                try { upstreamRequest?.destroy(); } catch { /* the peer is already gone */ }
                return;
            }
            settleForwarded();
            const fail = (): void => {
                // The upstream body failed or was aborted: end the downstream
                // response instead of leaving a truncated body behind.
                try { result.destroy(); } catch { /* ignore */ }
                try { decoder?.destroy(); } catch { /* ignore */ }
                try { if (!response.writableEnded) response.destroy(); } catch { /* ignore */ }
            };
            result.once('error', fail);
            result.once('aborted', fail);
            if (decoder) {
                decoder.once('error', fail);
                result.pipe(decoder).pipe(response);
            } else {
                result.pipe(response);
            }
        };

        const requestHandle = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target,
            { method: 'POST', headers }, relayUpstream);
        upstreamRequest = requestHandle;
        outbound.add(requestHandle);
        requestHandle.once('close', () => outbound.delete(requestHandle));
        requestHandle.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => requestHandle.destroy(new Error('Upstream idle timeout')));
        requestHandle.once('error', () => {
            if (!settled) refuse(502, 'maintenance_upstream_error', 'The upstream request failed.');
            else if (response.headersSent) { try { response.destroy(); } catch { /* the peer is already gone */ } }
        });
        request.once('aborted', () => { settleBlocked(); requestHandle.destroy(); });
        requestHandle.end(bytes);
    }

    const server = createServer((request, response) => {
        // A transport failure must never escape as an unhandled rejection.
        void handleRequest(request, response).catch(() => {
            try { if (!response.writableEnded) response.destroy(); } catch { /* the peer is already gone */ }
        });
    });

    server.on('upgrade', (_request, socket) => {
        counts.received++;
        counts.blocked++;
        upgradeSockets.add(socket);
        socket.once('close', () => upgradeSockets.delete(socket));
        socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        socket.end();
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.requestTimeout = 190_000;

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve(); });
    });
    const address = server.address() as AddressInfo;

    return {
        baseUrl: `http://127.0.0.1:${address.port}${prefix}`,
        counts: () => ({ ...counts }),
        close: async (): Promise<void> => {
            closed = true;
            for (const upstreamRequest of outbound) upstreamRequest.destroy();
            outbound.clear();
            for (const socket of upgradeSockets) socket.destroy();
            upgradeSockets.clear();
            await new Promise<void>(resolve => {
                let settled = false;
                const done = (): void => { if (!settled) { settled = true; resolve(); } };
                const timer = setTimeout(done, 2_000);
                timer.unref?.();
                server.close(() => { clearTimeout(timer); done(); });
                (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
                for (const socket of sockets) socket.destroy();
                sockets.clear();
            });
        }
    };
}
