import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { MINIMAX_MODEL, MINIMAX_EFFORTS } from './minimax';

/** Native pre-turn compaction uses the old model on the new provider.
 * Classify only the engine's machine metadata, never checkpoint prompt text.
 * This is called only after verifying the private engine capability.
 */
function isOldModelCompaction(request: IncomingMessage, data: Record<string, unknown>): boolean {
    const marker = request.headers['x-codex-turn-metadata'];
    if (typeof marker !== 'string' || marker.length > 16_384
        || typeof data.model !== 'string' || !/^gpt-[a-z0-9._-]{1,120}$/.test(data.model)
        || data.tools != null && (!Array.isArray(data.tools) || data.tools.length !== 0)) return false;
    try {
        const metadata = JSON.parse(marker);
        return metadata?.request_kind === 'compaction'
            && metadata.compaction?.implementation === 'responses'
            && metadata.compaction?.phase === 'pre_turn'
            && ['model_downshift', 'comp_hash_changed'].includes(metadata.compaction?.reason);
    } catch { return false; }
}

type Options = {
    // Test dependencies; production callers supply only the failure notification.
    minimaxUrl?: string;
    openaiUrl?: string;
    credential?: () => Promise<string>;
    timeoutMs?: number;
    onReviewUnavailable?: () => void;
};
function credential(): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('/usr/bin/python3', ['/home/ubuntu/workspace/minimax-codex/native_auth.py'],
            { timeout: 5_000, maxBuffer: 16_384 }, (error, stdout) => {
                const key = stdout.trim();
                if (error || !key || /[\r\n]/.test(key)) reject(new Error('MiniMax authentication unavailable'));
                else resolve(key);
            });
    });
}
async function body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw new Error('Request too large');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/** Transport only. Native Codex owns policy, evidence, approval and cancellation.
 * Credentials remain in memory and are never logged. Destinations are fixed.
 */
export async function startMiniMaxReviewRouter(options: Options = {}) {
    const prefix = `/${randomBytes(32).toString('hex')}/backend-api/codex`;
    const capability = randomBytes(32).toString('hex');
    let blocked = false;
    const counts = { taskRequests: 0, reviewRequests: 0 };
    const unavailable = () => {
        if (blocked) return;
        blocked = true;
        options.onReviewUnavailable?.();
    };
    const server = createServer(async (request, response) => {
        let phase = request.headers['x-codex-guardian'] === 'reviewer'
            || request.headers['x-openai-subagent'] === 'guardian' ? 'approval_review' : 'task_generation';
        const fail = (status: number) => {
            if (response.destroyed || response.writableEnded) return;
            if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: {
                code: `hapi_${phase}_transport_unavailable`,
                message: phase === 'approval_review' ? 'Approval review transport unavailable; no approval was granted.'
                    : phase === 'history_compaction' ? 'MiniMax history compaction transport unavailable; the task was not replayed.'
                    : 'MiniMax task generation transport unavailable; the task was not replayed.'
            } }));
        };
        if (request.method !== 'POST' || request.url !== `${prefix}/responses`) { fail(404); return; }
        const supplied = request.headers['x-hapi-minimax-router'];
        const suppliedBytes = typeof supplied === 'string' ? Buffer.from(supplied) : undefined;
        const expectedBytes = Buffer.from(capability);
        if (!suppliedBytes || suppliedBytes.length !== expectedBytes.length
            || !timingSafeEqual(suppliedBytes, expectedBytes)) { fail(403); return; }
        const guardian = request.headers['x-codex-guardian'] === 'reviewer'
            || request.headers['x-openai-subagent'] === 'guardian';
        let review = guardian;
        let canceled = false;
        let expired = false;
        let upstream: ClientRequest | undefined;
        // Include reading the local request body in the review deadline.
        // No partial or uncertain request is retried by this transport.
        const timer = guardian ? setTimeout(() => {
            expired = true;
            if (!canceled) unavailable();
            if (response.headersSent) response.destroy();
            else fail(502);
            upstream?.destroy(new Error('Transport timeout'));
        }, options.timeoutMs ?? 60_000) : undefined;
        timer?.unref();
        response.once('finish', () => {
            clearTimeout(timer);
            if (!request.complete) request.destroy();
        });
        response.once('close', () => {
            clearTimeout(timer);
            canceled = !response.writableEnded;
            upstream?.destroy();
            if (!request.complete) request.destroy();
        });
        try {
            // This custom provider sends plain JSON. Never parse compressed bytes as JSON.
            if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') { if (review) unavailable(); fail(415); return; }
            const bytes = await body(request);
            if (expired || canceled) return;
            const payload: unknown = JSON.parse(bytes.toString('utf8'));
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { if (review) unavailable(); fail(400); return; }
            const data = payload as Record<string, unknown>;
            const compaction = !guardian && isOldModelCompaction(request, data);
            if (compaction) phase = 'history_compaction';
            const mini = (data.model === MINIMAX_MODEL || compaction) && !guardian;
            review = guardian && ['codex-auto-review', 'gpt-5.6-luna'].includes(String(data.model));
            // A missing review catalog must never silently make MiniMax approve itself.
            if (!mini && !review) { if (guardian) unavailable(); fail(400); return; }
            if (review && blocked) { fail(503); return; }
            const authorization = request.headers.authorization;
            const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
            if (review && !bearer) { unavailable(); fail(401); return; }
            const target = new URL(mini ? options.minimaxUrl ?? 'https://api.minimax.cn/v1/responses'
                : options.openaiUrl ?? (bearer!.startsWith('sk-')
                    ? 'https://api.openai.com/v1/responses' : 'https://chatgpt.com/backend-api/codex/responses'));
            // Reconstruct every MiniMax header. No incoming OpenAI token/account/cookie survives.
            const headers: OutgoingHttpHeaders = mini
                ? { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${await (options.credential ?? credential)()}` }
                : { ...request.headers, 'accept-encoding': 'identity' };
            for (const key of ['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'cookie', 'x-hapi-minimax-router']) delete headers[key];
            let forwarded = bytes;
            if (compaction) {
                data.model = MINIMAX_MODEL;
                // The old provider may have an effort (e.g. ultra) unsupported
                // by MiniMax. Normal task requests remain byte-for-byte intact.
                if (data.reasoning && typeof data.reasoning === 'object' && !Array.isArray(data.reasoning)) {
                    const reasoning = data.reasoning as Record<string, unknown>;
                    if (reasoning.effort != null && !(MINIMAX_EFFORTS as readonly unknown[]).includes(reasoning.effort)) reasoning.effort = 'max';
                }
                forwarded = Buffer.from(JSON.stringify(data));
            }
            if (review && data.metadata && typeof data.metadata === 'object' && 'parent_response_id' in data.metadata) {
                // A MiniMax response ID is not an OpenAI stored response ID.
                delete (data.metadata as Record<string, unknown>).parent_response_id;
                forwarded = Buffer.from(JSON.stringify(data));
            }
            if (review) counts.reviewRequests++; else counts.taskRequests++;
            if (expired || canceled) return;
            upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target,
                { method: 'POST', headers: { ...headers, 'content-length': forwarded.length } }, result => {
                    if (review && result.statusCode !== 200) unavailable();
                    if (result.statusCode && result.statusCode >= 300 && result.statusCode < 400) {
                        result.resume(); fail(502); return;
                    }
                    if (review && result.headers['content-encoding'] && result.headers['content-encoding'] !== 'identity') {
                        unavailable(); result.resume(); fail(502); return;
                    }
                    const resultHeaders = { ...result.headers };
                    for (const key of ['connection', 'transfer-encoding', 'set-cookie', 'location']) delete resultHeaders[key];
                    response.writeHead(result.statusCode ?? 502, resultHeaders);
                    let completed = false;
                    const decoder = new StringDecoder('utf8');
                    let line = '';
                    let eventData: string[] = [];
                    const observeLine = (value: string) => {
                        if (value === '') {
                            // Observe complete SSE frames, never substrings in model text.
                            try {
                                const event = JSON.parse(eventData.join('\n')) as {type?: string};
                                if (event.type === 'response.completed') completed = true;
                                if (event.type === 'response.failed' || event.type === 'response.incomplete') unavailable();
                            } catch { /* Native Codex handles non-JSON and malformed frames. */ }
                            eventData = [];
                        } else if (value.startsWith('data:')) eventData.push(value.slice(5).trimStart());
                    };
                    result.on('data', chunk => {
                        if (!review) return;
                        const parts = decoder.write(chunk).split('\n');
                        for (let index = 0; index < parts.length - 1; index++) {
                            observeLine((line + parts[index]).replace(/\r$/, '')); line = '';
                        }
                        line += parts[parts.length - 1];
                    });
                    result.once('end', () => { if (review && !completed && !canceled) unavailable(); });
                    result.once('error', () => { if (review && !canceled) unavailable(); response.destroy(); });
                    result.pipe(response);
                });
            // Task generation keeps the existing quiet-stream bound, not the
            // shorter total review deadline; long reasoning may keep streaming.
            if (!review) upstream.setTimeout(180_000, () => upstream?.destroy(new Error('Transport idle timeout')));
            upstream.once('error', () => { if (review && !canceled) unavailable(); if (!response.headersSent) fail(502); else response.destroy(); });
            upstream.end(forwarded);
        } catch { if (review && !canceled) unavailable(); fail(502); }
    });
    server.requestTimeout = 190_000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`,
        capability,
        isBlocked: () => blocked,
        counts: () => ({ ...counts }),
        reset: () => { blocked = false; },
        close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
