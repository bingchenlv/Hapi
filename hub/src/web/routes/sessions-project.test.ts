import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

const project = { id: 'FF', name: '家庭记账', directory: '/project', controllerSessionId: 'root-a', role: 'controller' }

function fixture(denied = false, stale = false) {
    const setSessionProject = mock(() => { if (stale) throw new Error('Session was modified concurrently') })
    const resolveSessionAccess = mock((id: string) => denied ? { ok: false, reason: 'access-denied' }
        : { ok: true, sessionId: id, session: { metadata: { flavor: 'codex' } } })
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'authorized-user'); await next() })
    app.route('/api', createSessionsRoutes(() => ({ setSessionProject, resolveSessionAccess }) as unknown as SyncEngine))
    return { setSessionProject, put: (body: unknown) => app.request('/api/sessions/root-a/project', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }) }
}

describe('project binding route', () => {
    it('uses path identity, authenticated namespace and an explicit metadata version', async () => {
        const f = fixture()
        expect((await f.put({ project, expectedMetadataVersion: 3 })).status).toBe(200)
        expect(f.setSessionProject).toHaveBeenCalledWith('root-a', 'authorized-user', project, 3)
    })
    it('rejects a foreign namespace before writing', async () => {
        const f = fixture(true)
        expect((await f.put({ project, expectedMetadataVersion: 3 })).status).toBe(403)
        expect(f.setSessionProject).not.toHaveBeenCalled()
    })
    it('rejects absent versions and caller-supplied identities outside the contract', async () => {
        const f = fixture()
        for (const body of [{ project }, { project, expectedMetadataVersion: -1 },
            { project, expectedMetadataVersion: 3, sessionId: 'another' }, { project: { ...project, role: 'admin' }, expectedMetadataVersion: 3 }]) {
            expect((await f.put(body)).status).toBe(400)
        }
        expect(f.setSessionProject).not.toHaveBeenCalled()
    })
    it('reports a stale binding without retrying it', async () => {
        const f = fixture(false, true)
        expect((await f.put({ project, expectedMetadataVersion: 3 })).status).toBe(409)
        expect(f.setSessionProject).toHaveBeenCalledTimes(1)
    })
})
