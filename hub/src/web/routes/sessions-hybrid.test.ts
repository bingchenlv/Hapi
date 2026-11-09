import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

function fixture({ active = true, supported = true, denied = false, fail = false } = {}) {
    const hybridModel = mock(async (_id: string, mode: string) => {
        if (fail) throw new Error('runtime disconnected')
        return { mode }
    })
    const resolveSessionAccess = mock((id: string, namespace: string) => denied
        ? { ok: false, reason: 'access-denied' }
        : { ok: true, sessionId: id, session: { active, metadata: {
            flavor: 'codex', ...(supported ? { hybridModel: { mode: 'hybrid' } } : {})
        } } })
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'authorized-user'); await next() })
    app.route('/api', createSessionsRoutes(() => ({ hybridModel, resolveSessionAccess }) as unknown as SyncEngine))
    return { hybridModel, resolveSessionAccess, post: (body: unknown) => app.request('/api/sessions/root-a/hybrid-model', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }) }
}

describe('hybrid session route', () => {
    it('uses authenticated namespace and path identity and waits for confirmation', async () => {
        const f = fixture()
        const response = await f.post({ mode: 'openai' })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ mode: 'openai' })
        expect(f.resolveSessionAccess).toHaveBeenCalledWith('root-a', 'authorized-user')
        expect(f.hybridModel).toHaveBeenCalledWith('root-a', 'openai')
    })
    it('rejects access to another namespace', async () => {
        const f = fixture({ denied: true })
        expect((await f.post({ mode: 'openai' })).status).toBe(403)
        expect(f.hybridModel).not.toHaveBeenCalled()
    })
    it('rejects invalid modes or caller-supplied identities', async () => {
        const f = fixture()
        for (const body of [{ mode: 'other' }, { mode: 'openai', sessionId: 'root-b' }, null, []]) {
            expect((await f.post(body)).status).toBe(400)
        }
        expect(f.hybridModel).not.toHaveBeenCalled()
    })
    it('does not pretend an offline or older runtime applied the switch', async () => {
        for (const options of [{ active: false }, { supported: false }]) {
            const f = fixture(options)
            expect((await f.post({ mode: 'openai' })).status).toBe(409)
            expect(f.hybridModel).not.toHaveBeenCalled()
        }
    })
    it('returns failure when runtime confirmation is unavailable', async () => {
        const f = fixture({ fail: true })
        const response = await f.post({ mode: 'openai' })
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'runtime disconnected' })
    })
})
