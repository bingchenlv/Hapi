import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import type { Session } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

/**
 * Reopen of an archived session: resource-guard rejection and archive
 * rollback.
 *
 * `reopenSession` clears the archive metadata before it resumes an archived
 * session. When the resume is rejected - for example by the CLI resource
 * guard (child exit code 75 plus the `[HAPI resource guard]` marker on
 * stderr) - the archive snapshot has to be restored, otherwise the session
 * silently leaves the archived state and the operator loses the "reopen"
 * affordance.
 *
 * A resource-guard rejection has to reach the API as `resource_busy` (a
 * transient 503) and not as a generic `resume_failed` (500).
 */

type SpawnResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code?: string }

describe('SyncEngine reopen: resource-guard rejection and archive rollback', () => {
    let store: Store
    let engine: SyncEngine
    let spawnResult: SpawnResult
    let currentSessionId: string
    let lifecycleStateAtSpawn: unknown

    const NAMESPACE = 'default'

    function baseMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            path: '/tmp/proj',
            host: 'localhost',
            machineId: 'machine-x',
            flavor: 'agy',
            agySessionId: 'agy-conv-1',
            ...overrides
        }
    }

    function installFakeRunner(): void {
        ;(engine as unknown as { machineCache: unknown }).machineCache = {
            getOnlineMachinesByNamespace: () => [
                { id: 'machine-x', metadata: { host: 'localhost' } }
            ],
            expireInactive: () => {}
        }
        ;(engine as unknown as { waitForSessionActive: unknown }).waitForSessionActive = async () => true
        ;(engine as unknown as { waitForSessionReady: unknown }).waitForSessionReady = async () => 'ready'
        ;(engine as unknown as { rpcGateway: { spawnSession: unknown } }).rpcGateway.spawnSession =
            async () => {
                const session = store.sessions.getSession(currentSessionId)
                const metadata = session?.metadata as Record<string, unknown> | undefined
                lifecycleStateAtSpawn = metadata?.lifecycleState
                return spawnResult
            }
    }

    function insertArchivedSession(sessionId: string): Session {
        const cache = (engine as unknown as { sessionCache: import('./sessionCache').SessionCache }).sessionCache
        const created = cache.getOrCreateSession(
            sessionId,
            baseMetadata({
                lifecycleState: 'archived',
                archivedBy: 'hub',
                archiveReason: 'inactivity'
            }),
            { startingMode: 'local' },
            NAMESPACE
        )
        currentSessionId = created.id
        return created
    }

    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        spawnResult = { type: 'success', sessionId: 'unused' }
        currentSessionId = ''
        lifecycleStateAtSpawn = undefined
        installFakeRunner()
    })
    afterEach(() => { engine.stop() })

    it('reports a resource-guard rejection as resource_busy', async () => {
        insertArchivedSession('session-resource-busy')
        spawnResult = {
            type: 'error',
            message: 'Session process exited before webhook for PID 4242 (exit code 75). ' +
                'stderr: [HAPI resource guard] concurrent session limit reached',
            code: 'resource_busy'
        }

        const result = await engine.reopenSession(currentSessionId, NAMESPACE)

        const outcome = result as { type: string; code?: string; message?: string }
        expect(outcome.type).toBe('error')
        expect(outcome.code).toBe('resource_busy')
    })

    it('restores the archive snapshot when the reopen is rejected', async () => {
        insertArchivedSession('session-archive-rollback')
        spawnResult = {
            type: 'error',
            message: 'Session process exited before webhook for PID 4242 (exit code 75). ' +
                'stderr: [HAPI resource guard] concurrent session limit reached',
            code: 'resource_busy'
        }

        const result = await engine.reopenSession(currentSessionId, NAMESPACE)

        expect((result as { type: string }).type).toBe('error')
        // The archive metadata was cleared before the resume ...
        expect(lifecycleStateAtSpawn).not.toBe('archived')
        // ... and restored again after the rejection.
        const session = store.sessions.getSession(currentSessionId)
        const metadata = session?.metadata as Record<string, unknown> | undefined
        expect(metadata?.lifecycleState).toBe('archived')
        expect(metadata?.archivedBy).toBe('hub')
        expect(metadata?.archiveReason).toBe('inactivity')
    })

    it('keeps a plain spawn failure on resume_failed and still restores the archive snapshot', async () => {
        insertArchivedSession('session-plain-failure')
        spawnResult = {
            type: 'error',
            message: 'Session process exited before webhook for PID 7 (exit code 1)'
        }

        const result = await engine.reopenSession(currentSessionId, NAMESPACE)

        const outcome = result as { type: string; code?: string }
        expect(outcome.type).toBe('error')
        expect(outcome.code).toBe('resume_failed')
        const session = store.sessions.getSession(currentSessionId)
        const metadata = session?.metadata as Record<string, unknown> | undefined
        expect(metadata?.lifecycleState).toBe('archived')
        expect(metadata?.archivedBy).toBe('hub')
        expect(metadata?.archiveReason).toBe('inactivity')
    })
})
