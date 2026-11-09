import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from './auth'
import { requestTrace } from './requestTrace'

describe('request correlation', () => {
    it('preserves a bounded client id and logs actual failure without query credentials', async () => {
        const logs: string[] = []; const app = new Hono<WebAppEnv>()
        app.use('*', requestTrace(line => logs.push(line)))
        app.post('/reopen', c => c.json({ code: 'resource_busy', requestId: c.get('requestId') }, 503))
        const id = 'aaaaaaaa-1111-4222-8333-444444444444'
        const response = await app.request('/reopen?token=LOCAL_PRIVATE', { method: 'POST', headers: { 'x-request-id': id } })
        expect(response.headers.get('x-request-id')).toBe(id)
        expect(JSON.parse(logs[0])).toMatchObject({ request_id: id, status: 503, method: 'POST', path: '/reopen' })
        expect(logs[0]).not.toContain('LOCAL_PRIVATE')
    })
    it('replaces invalid inbound ids', async () => {
        const app = new Hono<WebAppEnv>(); app.use('*', requestTrace(() => {})); app.get('/', c => c.text('ok'))
        const response = await app.request('/', { headers: { 'x-request-id': 'private or unbounded' } })
        expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/)
    })
})
