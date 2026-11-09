import { describe, expect, it } from 'bun:test'
import type { SessionProject } from '@hapi/protocol'
import { toSessionSummary } from '@hapi/protocol'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function fixture() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const create = (name: string, namespace = 'alpha', machineId = 'machine', flavor = 'codex') => engine.getOrCreateSession(name,
        { path: '/actual/workspace', host: 'test', machineId, flavor, ...(flavor === 'codex' ? { codexSessionId: 'native-' + name } : { agySessionId: 'agy-' + name }) },
        { controlledByUser: false }, namespace)
    return { engine, create }
}

describe('project binding storage and access', () => {
    it('stores and projects a binding with CAS while preserving the original identity and cwd', () => {
        const { engine, create } = fixture()
        try {
            const controller = create('controller')
            const project: SessionProject = { id: 'FF', name: '家庭记账', directory: '/actual/workspace/family-finance', controllerSessionId: controller.id, role: 'controller' }
            engine.setSessionProject(controller.id, 'alpha', project, controller.metadataVersion)
            const saved = engine.getSession(controller.id)!
            expect(saved.metadata?.project).toEqual(project)
            expect(saved.metadata?.path).toBe('/actual/workspace')
            expect(saved.metadata?.codexSessionId).toBe('native-controller')
            expect(toSessionSummary(saved).metadata?.project).toEqual(project)
            expect(() => engine.setSessionProject(saved.id, 'alpha', null, controller.metadataVersion)).toThrow('concurrently')
            const derived = engine.projectForSpawn(saved.id, 'alpha', 'machine')
            expect(derived).toEqual({ ...project, role: 'research', createdFromSessionId: saved.id })
            expect(saved.metadata?.project?.role).toBe('controller')
            engine.setSessionProject(saved.id, 'alpha', null, saved.metadataVersion)
            expect(engine.getSession(saved.id)?.metadata?.project).toBeUndefined()
            expect(engine.getSession(saved.id)?.metadata?.path).toBe('/actual/workspace')
        } finally { engine.stop() }
    })
    it('rejects cross-namespace and cross-machine sources and bindings', () => {
        const { engine, create } = fixture()
        try {
            const controller = create('controller')
            const project: SessionProject = { id: 'FF', name: '家庭记账', directory: '/project', controllerSessionId: controller.id, role: 'controller' }
            engine.setSessionProject(controller.id, 'alpha', project, controller.metadataVersion)
            expect(() => engine.projectForSpawn(controller.id, 'beta', 'machine')).toThrow()
            expect(() => engine.projectForSpawn(controller.id, 'alpha', 'other-machine')).toThrow()
            const foreign = create('foreign', 'beta')
            expect(() => engine.setSessionProject(foreign.id, 'beta', { ...project, role: 'research' }, foreign.metadataVersion)).toThrow()
            expect(engine.getSession(foreign.id)?.metadata?.project).toBeUndefined()
            expect(() => engine.setSessionProject(controller.id, 'beta', null, engine.getSession(controller.id)!.metadataVersion)).toThrow()
            expect(engine.getSession(controller.id)?.metadata?.project?.id).toBe('FF')
        } finally { engine.stop() }
    })
    it('rejects a false controller role and a mismatched project source', () => {
        const { engine, create } = fixture()
        try {
            const controller = create('controller')
            const project: SessionProject = { id: 'FF', name: '家庭记账', directory: '/project', controllerSessionId: controller.id, role: 'controller' }
            engine.setSessionProject(controller.id, 'alpha', project, controller.metadataVersion)
            const child = create('child')
            expect(() => engine.setSessionProject(child.id, 'alpha', project, child.metadataVersion)).toThrow()
            expect(() => engine.setSessionProject(child.id, 'alpha', { ...project, id: 'OTHER', role: 'research' }, child.metadataVersion)).toThrow()
            expect(engine.getSession(child.id)?.metadata?.project).toBeUndefined()
        } finally { engine.stop() }
    })
    it('supports Antigravity (agy) project controller binding and spawn inheritance', () => {
        const { engine, create } = fixture()
        try {
            const controller = create('agy-controller', 'alpha', 'machine', 'agy')
            const project: SessionProject = { id: 'antigravity', name: 'Antigravity', directory: '/home/ubuntu/workspace/antigravity', controllerSessionId: controller.id, role: 'controller' }
            engine.setSessionProject(controller.id, 'alpha', project, controller.metadataVersion)
            const saved = engine.getSession(controller.id)!
            expect(saved.metadata?.project).toEqual(project)
            const derived = engine.projectForSpawn(saved.id, 'alpha', 'machine')
            expect(derived).toEqual({ ...project, role: 'research', createdFromSessionId: saved.id })
        } finally { engine.stop() }
    })
})
