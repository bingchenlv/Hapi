import { describe, expect, it } from 'bun:test'
import type { Metadata } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'

function fixture() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const metadata: Metadata = { path: '/tmp/work', host: 'test', machineId: 'machine', hostPid: 42, flavor: 'codex',
        capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true, forkAtMessage: true } } }
    const create = (name: string, more: Partial<Metadata> = {}) => {
        const session = engine.getOrCreateSession(name, { ...metadata, codexSessionId: `native-${name}`, ...more }, { controlledByUser: false }, 'default')
        engine.handleSessionAlive({ sid: session.id, time: Date.now() })
        engine.handleSessionReady({ sid: session.id, time: Date.now() })
        return session
    }
    return { store, engine, create, rpc: (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway }
}

describe('shared Codex hub binding', () => {
    it('guards plan actions by namespace and runtime, leaving stale-plan and retry validation to CLI', async () => {
        const { engine, create, rpc } = fixture()
        try {
            const source = create('source')
            const unsupported = create('other', { flavor: 'claude' })
            const calls: string[][] = []
            rpc.implementCodexPlan = async (...args) => { calls.push(args); return { ok: true } }
            expect(await engine.implementCodexPlan(source.id, 'other-namespace', 'plan')).toMatchObject({ ok: false })
            expect(await engine.implementCodexPlan(unsupported.id, 'default', 'plan')).toMatchObject({ ok: false })
            expect(calls).toHaveLength(0)
            // The hub can lag the native plan state, including after an accepted action's lost reply.
            expect(await engine.implementCodexPlan(source.id, 'default', 'plan')).toEqual({ ok: true })
            expect(calls).toEqual([[source.id, 'plan']])
        } finally { engine.stop() }
    })

    it('uses the already-bound fork child without spawning a second engine', async () => {
        const { engine, create, rpc } = fixture()
        try {
            const source = create('source'); const child = create('child', { forkedFrom: source.id })
            rpc.forkConversation = async () => ({ nativeSessionId: 'native-child', sessionId: child.id })
            expect(await engine.forkConversation(source.id, 'default')).toEqual({ type: 'success', sessionId: child.id })
            expect(engine.getSession(source.id)?.metadata?.codexSessionId).toBe('native-source')
        } finally { engine.stop() }
    })
    it('clear returns a new root without superseding other clients and mode switching is inapplicable', async () => {
        const { engine, create, rpc } = fixture()
        try {
            const source = create('source'); const child = create('child')
            rpc.clearConversation = async () => ({ sessionId: child.id })
            expect(await engine.clearConversation(source.id, 'default')).toEqual({ sessionId: child.id })
            expect(engine.getSession(child.id)?.metadata).toMatchObject({ name: 'Codex-01', codexAutoNameSequence: 1 })
            expect(engine.getSession(source.id)?.metadata?.supersededBySessionId).toBeUndefined()
            await expect(engine.switchSession(source.id, 'remote')).rejects.toThrow('control_mode_not_applicable')
            await expect(engine.clearConversation(source.id, 'other-namespace')).rejects.toThrow()
        } finally { engine.stop() }
    })

    it('allocates the next namespace-local Codex number from names and durable high-water marks', async () => {
        const { engine, create, rpc } = fixture()
        try {
            create('named', { name: 'Codex-02' })
            create('renamed', { name: 'Task title', codexAutoNameSequence: 7 })
            const source = create('source'); const child = create('child')
            rpc.clearConversation = async () => ({ sessionId: child.id })

            expect(await engine.clearConversation(source.id, 'default')).toEqual({ sessionId: child.id })
            expect(engine.getSession(child.id)?.metadata).toMatchObject({ name: 'Codex-08', codexAutoNameSequence: 8 })
        } finally { engine.stop() }
    })

    it('serializes concurrent /new numbering within a namespace', async () => {
        const { engine, create, rpc } = fixture()
        try {
            create('existing', { name: 'Codex-01' })
            const sourceA = create('source-a'); const sourceB = create('source-b')
            const childA = create('child-a'); const childB = create('child-b')
            rpc.clearConversation = async (sessionId) => ({
                sessionId: sessionId === sourceA.id ? childA.id : childB.id
            })

            await Promise.all([
                engine.clearConversation(sourceA.id, 'default'),
                engine.clearConversation(sourceB.id, 'default')
            ])

            const assigned = [childA, childB].map((child) => engine.getSession(child.id)?.metadata?.name).sort()
            expect(assigned).toEqual(['Codex-02', 'Codex-03'])
        } finally { engine.stop() }
    })
})
