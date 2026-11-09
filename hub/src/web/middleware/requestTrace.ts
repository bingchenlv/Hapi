import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { WebAppEnv } from './auth'

export function requestTrace(log: (line: string) => void = console.log): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const supplied = c.req.header('x-request-id')
        const id = supplied && /^[a-f0-9-]{36}$/i.test(supplied) ? supplied : randomUUID()
        c.set('requestId', id)
        c.header('x-request-id', id)
        const started = performance.now()
        try { await next() } finally {
            // No query strings, headers, credentials, request bodies or IPs.
            log(JSON.stringify({ event: 'http_request', request_id: id, method: c.req.method,
                path: c.req.path, status: c.res.status, duration_ms: Math.round(performance.now() - started) }))
        }
    }
}
