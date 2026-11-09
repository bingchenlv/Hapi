import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import type { Server } from 'socket.io'
import { maintenanceMessageDigestInput } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import { MessageService } from '../../sync/messageService'
import type { EventPublisher } from '../../sync/eventPublisher'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

function setup() {
    const store = new Store(':memory:')
    const stored = store.sessions.getOrCreateSession('maintenance-http', { flavor: 'codex' }, null, 'default')
    const session = { id: stored.id, active: true, metadata: { flavor: 'codex' } }
    const events: unknown[] = []
    const io = { of: () => ({ to: () => ({ emit: (_event: string, data: unknown) => events.push(data) }) }) } as unknown as Server
    const service = new MessageService(store, io, { emit() {} } as unknown as EventPublisher)
    const engine = {
        resolveSessionAccess: (id: string, namespace: string) => namespace !== 'default'
            ? { ok: false, reason: 'access-denied' } : id !== session.id
                ? { ok: false, reason: 'not-found' } : { ok: true, sessionId: session.id, session },
        sendMaintenanceMessage: (id: string, request: Parameters<MessageService['sendMaintenanceMessage']>[1]) => service.sendMaintenanceMessage(id, request),
        getMaintenanceMessageReceipt: (id: string, key: string) => store.getMaintenanceMessageReceipt(id, key),
        sendMessage: (id: string, request: Parameters<MessageService['sendMessage']>[1]) => service.sendMessage(id, request)
    } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', c.req.header('x-test-namespace') ?? 'default'); await next() })
    app.route('/api', createMessagesRoutes(() => engine))
    const request = (text = '维护代码任务', requestKey = randomUUID()) => ({ version: 1, requestKey, text,
        contentSha256: createHash('sha256').update(maintenanceMessageDigestInput(session.id, { requestKey, text })).digest('hex') })
    const submit = (body: unknown, namespace = 'default') => app.request(`http://test/api/sessions/${session.id}/maintenance/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-namespace': namespace }, body: JSON.stringify(body)
    })
    const observe = (key: string) => app.request(`http://test/api/sessions/${session.id}/maintenance/requests/${key}`)
    return { store, session, events, app, request, submit, observe }
}

describe('maintenance HTTP identity with real SQLite', () => {
    it('submits once and reads the exact content-bound receipt without delivering again', async () => {
        const f = setup()
        try {
            const request = f.request()
            expect((await f.submit(request)).status).toBe(200)
            const repeated = await f.submit(request)
            expect(repeated.status).toBe(200)
            expect(await repeated.json()).toMatchObject({ requestKey: request.requestKey, inserted: false, contentVerified: true, modelCompletionVerified: false })
            const observed = await f.observe(request.requestKey)
            expect(await observed.json()).toMatchObject({ contentSha256: request.contentSha256, state: 'stored' })
            expect(f.events).toHaveLength(1)
        } finally { f.store.close() }
    })

    it('rejects changed content and a wrong digest with no additional delivery', async () => {
        const f = setup()
        try {
            const request = f.request(); await f.submit(request)
            expect((await f.submit(f.request('changed', request.requestKey))).status).toBe(409)
            expect((await f.submit({ ...request, contentSha256: '0'.repeat(64) })).status).toBe(409)
            expect(f.events).toHaveLength(1)
        } finally { f.store.close() }
    })

    it('enforces namespace, active state and request schema before insertion', async () => {
        const f = setup()
        try {
            expect((await f.submit(f.request(), 'other')).status).toBe(403)
            expect((await f.submit({ ...f.request(), extra: true })).status).toBe(400)
            f.session.active = false
            expect((await f.submit(f.request())).status).toBe(409)
            expect(f.events).toHaveLength(0)
        } finally { f.store.close() }
    })

    it('keeps removed requests as missing_unknown and unknown keys as 404', async () => {
        const f = setup()
        try {
            const request = f.request(); const response = await f.submit(request)
            const receipt = await response.json() as { messageId: string }
            f.store.messages.cancelQueuedMessage(f.session.id, receipt.messageId)
            expect(await (await f.observe(request.requestKey)).json()).toMatchObject({ state: 'missing_unknown', contentVerified: false })
            expect((await f.observe(randomUUID())).status).toBe(404)
            expect((await f.submit(request)).status).toBe(200)
            expect(f.events).toHaveLength(1)
        } finally { f.store.close() }
    })

    it('preserves the ordinary message endpoint', async () => {
        const f = setup()
        try {
            const response = await f.app.request(`http://test/api/sessions/${f.session.id}/messages`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'ordinary input' })
            })
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ ok: true })
            expect(f.events).toHaveLength(1)
        } finally { f.store.close() }
    })
})
