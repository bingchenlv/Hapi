import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCliArgs, classifyRecoveredProcessGeneration, createSpawnDeduplicator, releaseRecoveredSpawnDedupe, releaseArchivedSharedResume, handleArchivedSharedWebhook, createArchivedRootRegistry, decideSharedRootAction, applySharedRootWebhook, reconcileArchivedSharedResume } from './run'

describe('buildCliArgs', () => {
    it('adds --permission-mode for valid permission mode', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            permissionMode: 'bypassPermissions',
        })
        expect(args).toContain('--permission-mode')
        expect(args).toContain('bypassPermissions')
        expect(args).not.toContain('--yolo')
    })

    it('ignores invalid permission mode and falls back to --yolo', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            permissionMode: 'not-a-real-mode',
        }, true)
        expect(args).not.toContain('--permission-mode')
        expect(args).toContain('--yolo')
    })

    it('ignores invalid permission mode without yolo fallback', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            permissionMode: 'not-a-real-mode',
        })
        expect(args).not.toContain('--permission-mode')
        expect(args).not.toContain('--yolo')
    })

    it('prefers --permission-mode over --yolo when both present', () => {
        const args = buildCliArgs('cursor', {
            directory: '/tmp',
            permissionMode: 'yolo',
        }, true)
        expect(args).toContain('--permission-mode')
        expect(args).toContain('yolo')
        // --yolo flag should NOT be added when --permission-mode is used
        const permIdx = args.indexOf('--permission-mode')
        const yoloIdx = args.indexOf('--yolo')
        expect(yoloIdx).toBe(-1)
    })

    it('throws for the removed gemini agent (no longer launchable)', () => {
        expect(() => buildCliArgs('gemini', { directory: '/tmp' })).toThrow(/no longer supported/)
    })

    it('adds --yolo when no permissionMode and yolo is true', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
        }, true)
        expect(args).toContain('--yolo')
        expect(args).not.toContain('--permission-mode')
    })

    it('passes --model through for opencode (mid-session model change support)', () => {
        const args = buildCliArgs('opencode', {
            directory: '/tmp',
            model: 'ollama/exaone:4.5-33b-q8',
        })
        expect(args).toContain('--model')
        expect(args).toContain('ollama/exaone:4.5-33b-q8')
    })



    it('passes --model-reasoning-effort through for opencode', () => {
        const args = buildCliArgs('opencode', {
            directory: '/tmp',
            modelReasoningEffort: 'high',
        })
        expect(args).toContain('--model-reasoning-effort')
        expect(args).toContain('high')
    })

    it('passes --service-tier through for codex (resume preserves Fast/Standard)', () => {
        const args = buildCliArgs('codex', {
            directory: '/tmp',
            serviceTier: 'fast',
        })
        expect(args).toContain('--service-tier')
        expect(args).toContain('fast')
    })

    it('passes --collaboration-mode through for codex Plan mode', () => {
        const args = buildCliArgs('codex', {
            directory: '/tmp',
            collaborationMode: 'plan',
        })
        expect(args).toContain('--collaboration-mode')
        expect(args).toContain('plan')
    })

    it('omits --collaboration-mode for default collaboration mode', () => {
        const args = buildCliArgs('codex', {
            directory: '/tmp',
            collaborationMode: 'default',
        })
        expect(args).not.toContain('--collaboration-mode')
    })

    it('does not pass --service-tier for non-codex agents', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            serviceTier: 'fast',
        })
        expect(args).not.toContain('--service-tier')
    })

    it('passes existing Hapi session id separately from Codex resume thread', () => {
        const args = buildCliArgs('codex', {
            directory: '/tmp',
            resumeSessionId: 'codex-thread-1',
            existingSessionId: 'hapi-session-1',
            model: 'gpt-5.5',
            modelReasoningEffort: 'low',
        })
        expect(args).toEqual([
            'codex',
            'resume',
            'codex-thread-1',
            '--started-by',
            'runner',
            '--existing-session-id',
            'hapi-session-1',
            '--model',
            'gpt-5.5',
            '--model-reasoning-effort',
            'low',
        ])
    })



    it('passes the preallocated HAPI id to OpenCode without resuming its native session', () => {
        const args = buildCliArgs('opencode', {
            directory: '/tmp',
            existingSessionId: 'fresh-hapi-session',
        })

        expect(args).toContain('--existing-session-id')
        expect(args).toContain('fresh-hapi-session')
        expect(args).not.toContain('--resume')
    })

    it('passes the existing HAPI row id when resuming OpenCode', () => {
        const args = buildCliArgs('opencode', {
            directory: '/tmp',
            resumeSessionId: 'opencode-session-1',
            existingSessionId: 'hapi-session-1',
        })
        expect(args).toContain('--resume')
        expect(args).toContain('opencode-session-1')
        expect(args).toContain('--existing-session-id')
        expect(args).toContain('hapi-session-1')
        expect(args).not.toContain('--hapi-session-id')
    })

    it('passes --existing-session-id for cursor resume when sessionId is set (#991)', () => {
        const args = buildCliArgs('cursor', {
            directory: '/tmp',
            resumeSessionId: 'cursor-csid-1',
            sessionId: 'hapi-session-991',
        })
        expect(args).toContain('--existing-session-id')
        expect(args).toContain('hapi-session-991')
        expect(args).toContain('--resume')
        expect(args).toContain('cursor-csid-1')
    })

    it('does not pass --collaboration-mode for non-codex agents', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            collaborationMode: 'plan',
        })
        expect(args).not.toContain('--collaboration-mode')
    })

    it('validates all known permission modes', () => {
        for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan', 'ask', 'debug', 'autoReview', 'read-only', 'safe-yolo', 'yolo']) {
            const args = buildCliArgs('claude', {
                directory: '/tmp',
                permissionMode: mode,
            })
            expect(args).toContain('--permission-mode')
            expect(args).toContain(mode)
        }
    })

    it('passes --cursor-worktree for cursor worktree sessions', () => {
        const args = buildCliArgs('cursor', {
            directory: '/tmp/repo',
            sessionType: 'worktree',
            worktreeName: 'feature-x',
        })
        expect(args).toContain('--cursor-worktree')
        expect(args).toContain('feature-x')
    })

    it('passes bare --cursor-worktree when name is omitted', () => {
        const args = buildCliArgs('cursor', {
            directory: '/tmp/repo',
            sessionType: 'worktree',
        })
        expect(args).toContain('--cursor-worktree')
        expect(args[args.length - 1]).toBe('--cursor-worktree')
    })

    it('skips --cursor-worktree when directory is already a linked git worktree', () => {
        const main = mkdtempSync(join(tmpdir(), 'hapi-cliargs-main-'))
        const linkedParent = mkdtempSync(join(tmpdir(), 'hapi-cliargs-wt-'))
        const linked = join(linkedParent, 'feature')
        const gitEnv = {
            ...process.env,
            GIT_AUTHOR_NAME: 'test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'test',
            GIT_COMMITTER_EMAIL: 'test@example.com'
        }
        const git = (cwd: string, args: string[]) => {
            execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: gitEnv })
        }
        try {
            git(main, ['init'])
            writeFileSync(join(main, 'README'), 'x\n')
            git(main, ['add', 'README'])
            git(main, ['commit', '-m', 'init'])
            git(main, ['worktree', 'add', '-b', 'feature', linked])

            const args = buildCliArgs('cursor', {
                directory: linked,
                sessionType: 'worktree',
                worktreeName: 'should-not-appear',
            })
            expect(args).not.toContain('--cursor-worktree')
            expect(args).not.toContain('should-not-appear')
        } finally {
            rmSync(linkedParent, { recursive: true, force: true })
            rmSync(main, { recursive: true, force: true })
        }
    })

    it('does not pass --cursor-worktree for non-cursor worktree sessions', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp/repo',
            sessionType: 'worktree',
            worktreeName: 'feature-x',
        })
        expect(args).not.toContain('--cursor-worktree')
    })

    it('uses --session-id for pi resume (not --resume)', () => {
        const args = buildCliArgs('pi', {
            directory: '/tmp',
            resumeSessionId: 'some-pi-session-id',
        })
        expect(args).not.toContain('--resume')
        expect(args).toContain('--session-id')
        expect(args).toContain('some-pi-session-id')
        expect(args[0]).toBe('pi')
    })

    it('reuses the original HAPI row for Pi native resume', () => {
        const args = buildCliArgs('pi', {
            directory: '/tmp',
            resumeSessionId: 'pi-native-session-1',
            existingSessionId: 'hapi-session-pi-1',
        })

        expect(args).toContain('--session-id')
        expect(args).toContain('pi-native-session-1')
        expect(args).toContain('--existing-session-id')
        expect(args).toContain('hapi-session-pi-1')
    })

    it('still passes --resume for claude when resumeSessionId is provided', () => {
        // Guard against accidentally swallowing claude's --resume when
        // the pi branch was added.
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            resumeSessionId: 'some-claude-session-id',
        })
        expect(args).toContain('--resume')
        expect(args).toContain('some-claude-session-id')
    })

    it('passes --fork-session and --existing-session-id for Claude message-level fork', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            resumeSessionId: 'claude-source-id',
            existingSessionId: 'hapi-child-id',
            forkSession: true,
        })
        expect(args).toContain('--resume')
        expect(args).toContain('claude-source-id')
        expect(args).toContain('--fork-session')
        expect(args.indexOf('--fork-session')).toBeGreaterThan(args.indexOf('--resume'))
        expect(args).toContain('--existing-session-id')
        expect(args).toContain('hapi-child-id')
    })

    it('passes --effort for pi agent', () => {
        const args = buildCliArgs('pi', {
            directory: '/tmp',
            effort: 'high',
        })
        expect(args).toContain('--effort')
        expect(args).toContain('high')
    })

    it('passes --effort for claude agent', () => {
        const args = buildCliArgs('claude', {
            directory: '/tmp',
            effort: 'high',
        })
        expect(args).toContain('--effort')
        expect(args).toContain('high')
    })

    it('builds Grok runner resume, model, effort, and permission arguments', () => {
        const args = buildCliArgs('grok', {
            directory: '/tmp',
            resumeSessionId: 'grok-session-1',
            model: 'grok-4.5',
            effort: 'low',
            permissionMode: 'plan'
        })

        expect(args).toEqual([
            'grok',
            '--resume', 'grok-session-1',
            '--hapi-starting-mode', 'remote',
            '--started-by', 'runner',
            '--model', 'grok-4.5',
            '--effort', 'low',
            '--permission-mode', 'plan'
        ])
    })
    it('emits --existing-session-id for agy reopen', () => {
        const args = buildCliArgs('agy', {
            directory: '/tmp',
            existingSessionId: 'existing-hub-id',
            startingMode: 'remote',
        })
        expect(args).toContain('--existing-session-id')
        expect(args[args.indexOf('--existing-session-id') + 1]).toBe('existing-hub-id')
        expect(args).not.toContain('--hapi-session-id')
    })

    it('builds a remote DSH ACP runner command without unsupported policy flags', () => {
        const args = buildCliArgs('dsh', {
            directory: '/tmp',
            existingSessionId: 'existing-hub-id',
            startingMode: 'remote',
            permissionMode: 'read-only'
        }, true)
        expect(args).toEqual([
            'dsh',
            '--hapi-starting-mode', 'remote',
            '--started-by', 'runner',
            '--existing-session-id', 'existing-hub-id'
        ])
    })

    it('does not emit --hapi-session-id for a non-pty flavor', () => {
        const args = buildCliArgs('opencode', {
            directory: '/tmp',
            existingSessionId: 'existing-hub-id',
            startingMode: 'remote',
        })
        expect(args).not.toContain('--hapi-session-id')
    })

})


describe('createSpawnDeduplicator', () => {
    it('rehydrates a live child after runner restart without spawning again', async () => {
        let calls = 0
        const dedupe = createSpawnDeduplicator(async () => {
            calls += 1
            return { type: 'success' as const, sessionId: 'duplicate' }
        })

        dedupe.recoverChild('fresh-hapi-session', {
            type: 'error',
            errorMessage: 'Session fresh-hapi-session is still starting'
        })

        await expect(dedupe({ directory: '/tmp', existingSessionId: 'fresh-hapi-session' })).resolves.toEqual({
            type: 'error', errorMessage: 'Session fresh-hapi-session is still starting'
        })
        expect(calls).toBe(0)
    })

    it('shares an in-flight spawn and its successful result while the child is alive', async () => {
        let calls = 0
        let resolveSpawn: ((result: { type: 'success'; sessionId: string }) => void) | undefined
        const dedupe = createSpawnDeduplicator(async () => {
            calls += 1
            return await new Promise<{ type: 'success'; sessionId: string }>((resolve) => {
                resolveSpawn = resolve
            })
        })

        const first = dedupe({ directory: '/tmp', existingSessionId: 'fresh-hapi-session' })
        const concurrentRetry = dedupe({ directory: '/tmp', existingSessionId: 'fresh-hapi-session' })
        expect(calls).toBe(1)
        resolveSpawn?.({ type: 'success', sessionId: 'fresh-hapi-session' })
        await expect(first).resolves.toEqual({ type: 'success', sessionId: 'fresh-hapi-session' })
        await expect(concurrentRetry).resolves.toEqual({ type: 'success', sessionId: 'fresh-hapi-session' })

        await expect(dedupe({ directory: '/tmp', existingSessionId: 'fresh-hapi-session' })).resolves.toEqual({
            type: 'success', sessionId: 'fresh-hapi-session'
        })
        expect(calls).toBe(1)
    })

    it('retries immediately when spawning fails before a child PID is registered', async () => {
        let calls = 0
        const dedupe = createSpawnDeduplicator(async () => {
            calls += 1
            return { type: 'error' as const, errorMessage: 'Failed to spawn HAPI process - no PID returned' }
        })

        const options = { directory: '/tmp', existingSessionId: 'fresh-hapi-session' }
        await expect(dedupe(options)).resolves.toEqual({ type: 'error', errorMessage: 'Failed to spawn HAPI process - no PID returned' })
        await expect(dedupe(options)).resolves.toEqual({ type: 'error', errorMessage: 'Failed to spawn HAPI process - no PID returned' })

        expect(calls).toBe(2)
    })

    it('keeps a timed-out child deduped until the runner observes its exit', async () => {
        let calls = 0
        let dedupe!: ReturnType<typeof createSpawnDeduplicator>
        dedupe = createSpawnDeduplicator(async (options) => {
            calls += 1
            dedupe.markChildAlive(options.existingSessionId!)
            return { type: 'error' as const, errorMessage: 'Session webhook timeout' }
        })

        const options = { directory: '/tmp', existingSessionId: 'fresh-hapi-session' }
        await expect(dedupe(options)).resolves.toEqual({ type: 'error', errorMessage: 'Session webhook timeout' })
        await expect(dedupe(options)).resolves.toEqual({ type: 'error', errorMessage: 'Session webhook timeout' })
        expect(calls).toBe(1)

        dedupe.onChildExited('fresh-hapi-session')
        await expect(dedupe(options)).resolves.toEqual({ type: 'error', errorMessage: 'Session webhook timeout' })
        expect(calls).toBe(2)
    })

    it('keeps a stopped child deduped until the runner observes its exit', async () => {
        let calls = 0
        let dedupe!: ReturnType<typeof createSpawnDeduplicator>
        dedupe = createSpawnDeduplicator(async (options) => {
            calls += 1
            dedupe.markChildAlive(options.existingSessionId!)
            return { type: 'success' as const, sessionId: 'fresh-hapi-session' }
        })

        const options = { directory: '/tmp', existingSessionId: 'fresh-hapi-session' }
        await expect(dedupe(options)).resolves.toEqual({ type: 'success', sessionId: 'fresh-hapi-session' })

        // stopSession() has only requested termination; the child can still be alive.
        dedupe.markChildStopping('fresh-hapi-session')
        await expect(dedupe(options)).resolves.toEqual({ type: 'success', sessionId: 'fresh-hapi-session' })
        expect(calls).toBe(1)

        dedupe.onChildExited('fresh-hapi-session')
        await expect(dedupe(options)).resolves.toEqual({ type: 'success', sessionId: 'fresh-hapi-session' })
        expect(calls).toBe(2)
    })
})

describe('classifyRecoveredProcessGeneration', () => {
    it('quarantines a live recovered child while its generation marker is unavailable', () => {
        expect(classifyRecoveredProcessGeneration(true, null, 'persisted-marker')).toBe('quarantined')
    })

    it('releases quarantine only after exit or a generation mismatch is proven', () => {
        expect(classifyRecoveredProcessGeneration(false, null, 'persisted-marker')).toBe('exited')
        expect(classifyRecoveredProcessGeneration(true, 'other-marker', 'persisted-marker')).toBe('exited')
        expect(classifyRecoveredProcessGeneration(true, 'persisted-marker', 'persisted-marker')).toBe('verified')
    })
})

describe('releaseRecoveredSpawnDedupe', () => {
    it('allows an immediate same-row spawn after a recovered child reaches a terminal stop branch', async () => {
        let calls = 0
        const dedupe = createSpawnDeduplicator(async () => {
            calls += 1
            return { type: 'success' as const, sessionId: 'fresh-hapi-session' }
        })
        dedupe.recoverChild('fresh-hapi-session', { type: 'success', sessionId: 'fresh-hapi-session' })
        const recovered = new Map([[123, 'fresh-hapi-session']])

        releaseRecoveredSpawnDedupe(123, recovered, dedupe)
        await dedupe({ directory: '/tmp', existingSessionId: 'fresh-hapi-session' })

        expect(calls).toBe(1)
        expect(recovered.has(123)).toBe(false)
    })
})

describe('shared root archive spawn lifecycle', () => {
    function fixture() {
        const calls: string[] = []
        const spawn = createSpawnDeduplicator(async options => {
            calls.push(options.existingSessionId!)
            return { type: 'success' as const, sessionId: options.existingSessionId! }
        })
        spawn.recoverChild('primary', { type: 'success', sessionId: 'primary' })
        spawn.recoverChild('other-runtime-root', { type: 'success', sessionId: 'other-runtime-root' })
        return { calls, options: {
            pid: 123, sessionId: 'primary', spawn,
            tracked: { happySessionId: 'primary', requestedHappySessionId: 'primary',
                primaryAckRetired: undefined as boolean | undefined },
            childOwners: new Map([[123, 'primary']]),
            persisted: new Map<number, { requestedSessionId: string; confirmedSessionId?: string }>([[123, { requestedSessionId: 'primary', confirmedSessionId: 'primary' }]]),
            requested: new Map([[123, 'primary']]), confirmed: new Map([[123, 'primary']])
        } }
    }
    it('allows a fresh same-row resume after the primary archives while its wrapper survives', async () => {
        const f = fixture()
        expect(releaseArchivedSharedResume(f.options)).toBe(true)
        await f.options.spawn({ directory: '/tmp', existingSessionId: 'primary' })
        await f.options.spawn({ directory: '/tmp', existingSessionId: 'other-runtime-root' })
        expect(f.calls).toEqual(['primary'])
        expect(f.options.persisted.size).toBe(0)
        expect(f.options.childOwners.size).toBe(0)
        expect(f.options.requested.size).toBe(0)
        expect(f.options.confirmed.size).toBe(0)
        expect(f.options.tracked.happySessionId).toBeUndefined()
        expect(f.options.tracked.primaryAckRetired).toBe(true)
    })
    it('does not release the primary acknowledgement when only a sibling archives', async () => {
        const f = fixture()
        expect(releaseArchivedSharedResume({ ...f.options, sessionId: 'sibling' })).toBe(false)
        await f.options.spawn({ directory: '/tmp', existingSessionId: 'primary' })
        expect(f.calls).toEqual([])
        expect(f.options.persisted.size).toBe(1)
        expect(f.options.tracked.happySessionId).toBe('primary')
        // A sibling that archives does not retire the primary acknowledgement.
        expect(f.options.tracked.primaryAckRetired).toBeUndefined()
    })
    it('retires the original requested key when the confirmed HAPI identity differs', async () => {
        const f = fixture()
        f.options.persisted.set(123, { requestedSessionId: 'primary', confirmedSessionId: 'confirmed' })
        expect(releaseArchivedSharedResume({ ...f.options, sessionId: 'confirmed' })).toBe(true)
        await f.options.spawn({ directory: '/tmp', existingSessionId: 'primary' })
        expect(f.calls).toEqual(['primary'])
        expect(f.options.persisted.size).toBe(0)
        expect(f.options.tracked.happySessionId).toBeUndefined()
    })
})


describe('archived shared root regressions', () => {
    function fixture() {
        const calls: string[] = []
        const spawn = createSpawnDeduplicator(async options => {
            calls.push(options.existingSessionId!)
            return { type: 'success' as const, sessionId: options.existingSessionId! }
        })
        spawn.recoverChild('primary', { type: 'success', sessionId: 'primary' })
        spawn.recoverChild('other-runtime-root', { type: 'success', sessionId: 'other-runtime-root' })
        return { calls, options: {
            pid: 123, sessionId: 'primary', spawn,
            tracked: { happySessionId: 'primary', requestedHappySessionId: 'primary' },
            childOwners: new Map([[123, 'primary']]),
            persisted: new Map<number, { requestedSessionId: string; confirmedSessionId?: string }>([[123, { requestedSessionId: 'primary', confirmedSessionId: 'primary' }]]),
            requested: new Map([[123, 'primary']]), confirmed: new Map([[123, 'primary']])
        } }
    }

    it('retires the acknowledgement when only the confirmed alias is known and no durable record exists', async () => {
        const f = fixture()
        f.options.persisted.delete(123)
        f.options.confirmed.set(123, 'confirmed')
        f.options.tracked.happySessionId = 'confirmed'
        expect(releaseArchivedSharedResume({ ...f.options, sessionId: 'confirmed' })).toBe(true)
        await f.options.spawn({ directory: '/tmp', existingSessionId: 'primary' })
        expect(f.calls).toEqual(['primary'])
        expect(f.options.persisted.size).toBe(0)
        expect(f.options.tracked.happySessionId).toBeUndefined()
    })

    it('ignores a confirmed alias that is not proven to belong to this child', () => {
        const f = fixture()
        f.options.persisted.delete(123)
        f.options.confirmed.set(123, 'sibling-root')
        f.options.tracked.happySessionId = 'primary'
        expect(releaseArchivedSharedResume({ ...f.options, sessionId: 'sibling-root' })).toBe(false)
        expect(f.options.childOwners.get(123)).toBe('primary')
        expect(f.options.requested.get(123)).toBe('primary')
    })

    it('is idempotent for a repeated archived webhook', () => {
        const f = fixture()
        expect(releaseArchivedSharedResume(f.options)).toBe(true)
        expect(releaseArchivedSharedResume(f.options)).toBe(false)
        expect(f.options.persisted.size).toBe(0)
        expect(f.options.childOwners.size).toBe(0)
        expect(f.options.requested.size).toBe(0)
        expect(f.options.confirmed.size).toBe(0)
    })

    it('does not mutate anything when a sibling archives after the primary already archived', () => {
        const f = fixture()
        expect(releaseArchivedSharedResume(f.options)).toBe(true)
        expect(releaseArchivedSharedResume({ ...f.options, sessionId: 'sibling' })).toBe(false)
        expect(f.options.persisted.size).toBe(0)
        expect(f.options.childOwners.size).toBe(0)
    })

    it('keeps the bookkeeping of an unrelated pid intact', async () => {
        const f = fixture()
        f.options.childOwners.set(456, 'other-runtime-root')
        f.options.persisted.set(456, { requestedSessionId: 'other-runtime-root' })
        expect(releaseArchivedSharedResume(f.options)).toBe(true)
        expect(f.options.childOwners.get(456)).toBe('other-runtime-root')
        await f.options.spawn({ directory: '/tmp', existingSessionId: 'other-runtime-root' })
        expect(f.calls).toEqual([])
    })

    it('clears both tracked aliases for the archived root', () => {
        const f = fixture()
        expect(releaseArchivedSharedResume(f.options)).toBe(true)
        expect(f.options.tracked.happySessionId).toBeUndefined()
        expect(f.options.tracked.requestedHappySessionId).toBeUndefined()
    })

    it('replays a fresh spawn result instead of the cached acknowledgement', async () => {
        const calls: string[] = []
        const spawn = createSpawnDeduplicator(async options => {
            calls.push(options.existingSessionId!)
            return { type: 'success' as const, sessionId: `${options.existingSessionId}-gen2` }
        })
        spawn.recoverChild('primary', { type: 'success', sessionId: 'primary' })
        const maps = {
            pid: 123, sessionId: 'primary', spawn,
            tracked: { happySessionId: 'primary', requestedHappySessionId: 'primary' },
            childOwners: new Map([[123, 'primary']]),
            persisted: new Map<number, { requestedSessionId: string; confirmedSessionId?: string }>([[123, { requestedSessionId: 'primary', confirmedSessionId: 'primary' }]]),
            requested: new Map([[123, 'primary']]), confirmed: new Map([[123, 'primary']])
        }
        expect(releaseArchivedSharedResume(maps)).toBe(true)
        await expect(spawn({ directory: '/tmp', existingSessionId: 'primary' }))
            .resolves.toEqual({ type: 'success', sessionId: 'primary-gen2' })
        expect(calls).toEqual(['primary'])
    })

    it('consumes and releases an archived root for a restart-recovered child', () => {
        const f = fixture()
        f.options.persisted.set(123, { requestedSessionId: 'primary', confirmedSessionId: 'confirmed' })
        const result = handleArchivedSharedWebhook({
            pid: 123, sessionId: 'confirmed', spawn: f.options.spawn,
            childOwners: f.options.childOwners,
            persisted: f.options.persisted,
            requested: f.options.requested,
            confirmed: f.options.confirmed
        })
        expect(result.consumed).toBe(true)
        expect(result.released).toBe(true)
        expect(f.options.persisted.size).toBe(0)
        expect(f.options.childOwners.size).toBe(0)
    })

    it('does not consume an archived webhook for a pid that is not a known runner child', () => {
        const spawn = createSpawnDeduplicator(async () => ({ type: 'success' as const, sessionId: 'external' }))
        const result = handleArchivedSharedWebhook({
            pid: 999, sessionId: 'external-root', spawn,
            childOwners: new Map(), persisted: new Map(), requested: new Map(), confirmed: new Map()
        })
        expect(result.consumed).toBe(false)
        expect(result.released).toBe(false)
    })

    it('remembers archived roots per pid and forgets them on demand', () => {
        const registry = createArchivedRootRegistry()
        expect(registry.isArchived(1, 'root-a')).toBe(false)
        registry.mark(1, 'root-a')
        expect(registry.isArchived(1, 'root-a')).toBe(true)
        expect(registry.isArchived(1, 'root-b')).toBe(false)
        expect(registry.isArchived(2, 'root-a')).toBe(false)
        registry.forget(1)
        expect(registry.isArchived(1, 'root-a')).toBe(false)
    })

    it('classifies shared root webhooks', () => {
        expect(decideSharedRootAction({ sessionId: 'r', lifecycleState: 'archived', archivedRoot: false, primaryId: 'r' })).toBe('archive')
        expect(decideSharedRootAction({ sessionId: 'r', lifecycleState: 'active', archivedRoot: true, primaryId: 'r' })).toBe('ignore-late')
        expect(decideSharedRootAction({ sessionId: 's', lifecycleState: 'active', archivedRoot: false, primaryId: 'p' })).toBe('ignore-secondary')
        expect(decideSharedRootAction({ sessionId: 'p', lifecycleState: 'active', archivedRoot: false, primaryId: 'p' })).toBe('promote')
        expect(decideSharedRootAction({ sessionId: 'p', archivedRoot: false, primaryId: undefined })).toBe('promote')
    })

    it('does not re-promote a root that already reported archived', () => {
        const registry = createArchivedRootRegistry()
        registry.mark(123, 'primary')
        const action = decideSharedRootAction({
            sessionId: 'primary', lifecycleState: 'active',
            archivedRoot: registry.isArchived(123, 'primary'), primaryId: undefined
        })
        expect(action).toBe('ignore-late')
    })
})


describe('Runner shared webhook dispatch', () => {
    function fixture(recovered = false) {
        let spawns = 0, persists = 0
        const spawn = createSpawnDeduplicator(async () => {
            spawns += 1
            await new Promise(resolve => setTimeout(resolve, 5))
            return { type: 'success' as const, sessionId: 'primary-gen2' }
        })
        spawn.recoverChild('primary', { type: 'success', sessionId: 'primary' })
        const tracked = recovered ? undefined : {
            pid: 123, startedBy: 'runner', happySessionId: 'primary' as string | undefined,
            requestedHappySessionId: 'primary' as string | undefined,
            primaryAckRetired: undefined as boolean | undefined,
            sharedSessions: { primary: {}, sibling: {} } as Record<string, any>,
        }
        const base = {
            pid: 123, sessionId: 'primary', tracked, spawn,
            childOwners: new Map([[123, 'primary']]),
            persisted: new Map<number, { requestedSessionId: string; confirmedSessionId?: string }>([[123, { requestedSessionId: 'primary', confirmedSessionId: 'primary' }]]),
            requested: new Map([[123, 'primary']]), confirmed: new Map([[123, 'primary']]),
            archivedRoots: createArchivedRootRegistry(), persist: () => { persists += 1 }, invalidate: () => {},
        }
        const send = (sessionId: string, lifecycleState: string) => applySharedRootWebhook({
            ...base, sessionId, metadata: { lifecycleState, capabilities: { concurrentClients: true } },
        })
        return { base, send, counts: () => ({ spawns, persists }) }
    }
    it('archives the primary, preserves its sibling and deduplicates concurrent fresh resumes', async () => {
        const f = fixture()
        expect(f.send('primary', 'archived')).toBe(true)
        expect(Object.keys(f.base.tracked!.sharedSessions)).toEqual(['sibling'])
        expect(f.base.tracked!.happySessionId).toBeUndefined()
        const results = await Promise.all([1, 2].map(() => f.base.spawn({ directory: '/tmp', existingSessionId: 'primary' })))
        expect(results).toEqual([{ type: 'success', sessionId: 'primary-gen2' }, { type: 'success', sessionId: 'primary-gen2' }])
        expect(f.counts()).toEqual({ spawns: 1, persists: 1 })
        expect(f.send('primary', 'archived')).toBe(true)
        expect(f.counts().persists).toBe(1)
        expect(f.send('primary', 'running')).toBe(true)
        expect(f.base.tracked!.sharedSessions.primary).toBeUndefined()
        expect(f.send('sibling', 'running')).toBe(true)
        expect(f.base.confirmed.size).toBe(0)
    })
    it('accepts the first webhook of a new child that has no preallocated HAPI identity', () => {
        const f = fixture()
        // A first-time creation has neither a requested nor a confirmed
        // identity. Its first valid root webhook must still be confirmed, or
        // the spawn awaiter times out and kills a healthy process.
        f.base.tracked!.happySessionId = undefined
        f.base.tracked!.requestedHappySessionId = undefined
        f.base.tracked!.sharedSessions = {}
        f.base.childOwners.clear(); f.base.persisted.clear(); f.base.requested.clear(); f.base.confirmed.clear()
        expect(f.send('new-primary', 'running')).toBe(false)
        expect(f.base.tracked!.sharedSessions['new-primary']).toBeDefined()
        expect(f.base.tracked!.primaryAckRetired).toBeUndefined()
        // The generic handler then binds the primary and resolves the awaiter.
        f.base.tracked!.happySessionId = 'new-primary'
        f.base.confirmed.set(123, 'new-primary')
        // A sibling must not take over the acknowledgement.
        expect(f.send('sibling', 'running')).toBe(true)
        expect(f.base.confirmed.get(123)).toBe('new-primary')
        // Archiving the primary retires the acknowledgement explicitly.
        expect(f.send('new-primary', 'archived')).toBe(true)
        expect(f.base.tracked!.happySessionId).toBeUndefined()
        expect(f.base.tracked!.primaryAckRetired).toBe(true)
        // A late sibling keeps the wrapper alive but never reclaims the ACK:
        // the confirmed alias was released together with the retired ACK.
        expect(f.send('sibling', 'running')).toBe(true)
        expect(f.base.tracked!.sharedSessions['sibling']).toBeDefined()
        expect(f.base.confirmed.size).toBe(0)
    })
    it('keeps the acknowledgement of a child that never received one', () => {
        const f = fixture()
        f.base.tracked!.happySessionId = undefined
        f.base.tracked!.requestedHappySessionId = undefined
        f.base.tracked!.sharedSessions = {}
        // The archived webhook does not belong to this child, so nothing is
        // retired and the pending first confirmation stays possible.
        expect(f.send('foreign-root', 'archived')).toBe(true)
        expect(f.base.tracked!.primaryAckRetired).toBeUndefined()
        expect(f.send('new-primary', 'running')).toBe(false)
        expect(f.base.tracked!.primaryAckRetired).toBeUndefined()
    })
    it('releases recovered bookkeeping without a tracked child or stale replay', async () => {
        const f = fixture(true)
        expect(f.send('primary', 'archived')).toBe(true)
        expect(f.base.persisted.size).toBe(0)
        await expect(f.base.spawn({ directory: '/tmp', existingSessionId: 'primary' }))
            .resolves.toEqual({ type: 'success', sessionId: 'primary-gen2' })
        expect(f.counts()).toEqual({ spawns: 1, persists: 1 })
        expect(f.send('primary', 'running')).toBe(true)
    })
    it('does not release the primary when a sibling archives', async () => {
        const f = fixture()
        expect(f.send('sibling', 'archived')).toBe(true)
        await f.base.spawn({ directory: '/tmp', existingSessionId: 'primary' })
        expect(f.counts()).toEqual({ spawns: 0, persists: 0 })
        expect(f.base.tracked!.happySessionId).toBe('primary')
    })
    it('never adopts an archived unknown or external root as online', () => {
        const f = fixture(true)
        expect(applySharedRootWebhook({ ...f.base, pid: 999, sessionId: 'external',
            metadata: { lifecycleState: 'archived', capabilities: { concurrentClients: true } } })).toBe(true)
        expect(f.base.archivedRoots.isArchived(999, 'external')).toBe(true)
        expect(f.counts().persists).toBe(0)
    })
    it('accepts an explicit newer activation in the same wrapper but ignores earlier delayed events', () => {
        const f = fixture()
        const send = (lifecycleState: string, lifecycleStateSince: number) => applySharedRootWebhook({ ...f.base,
            metadata: { lifecycleState, lifecycleStateSince, capabilities: { concurrentClients: true } } })
        expect(send('running', 100)).toBe(false)
        expect(send('archived', 100)).toBe(true)
        expect(send('running', 100)).toBe(true)
        expect(f.base.tracked!.sharedSessions.primary).toBeUndefined()
        expect(send('running', 200)).toBe(true) // Root listed, without reclaiming retired process ACK.
        expect(f.base.tracked!.sharedSessions.primary.lifecycleStateSince).toBe(200)
        expect(send('archived', 100)).toBe(true)
        expect(f.base.tracked!.sharedSessions.primary.lifecycleStateSince).toBe(200)
        expect(f.counts().persists).toBe(1)
    })

})


describe('explicit resume before delayed archive webhook', () => {
    function fixture() {
        const owners = new Map([[123, 'primary']])
        const record = { pid: 123, marker: 'generation', hub: 'local', authHash: 'account',
            sessions: { primary: { active: false }, sibling: { active: true } }, pendingCreations: [] as string[] }
        const retired: number[] = []
        const options = { sessionId: 'primary', owners, records: [record], hub: 'local', authHash: 'account',
            isLive: () => true, archive: (pid: number) => { retired.push(pid); owners.delete(pid) } }
        return { options, record, retired }
    }
    it('retires only the explicitly inactive root and is idempotent for simultaneous resumes', () => {
        const f = fixture()
        expect(reconcileArchivedSharedResume(f.options)).toBe(true)
        expect(reconcileArchivedSharedResume(f.options)).toBe(false)
        expect(f.retired).toEqual([123])
        expect(f.record.sessions.sibling.active).toBe(true)
    })
    it('keeps a live root and an unconfirmed creation deduplicated', () => {
        const f = fixture()
        f.record.sessions.primary.active = true
        expect(reconcileArchivedSharedResume(f.options)).toBe(false)
        f.record.sessions.primary.active = false
        f.record.pendingCreations.push('unconfirmed')
        expect(reconcileArchivedSharedResume(f.options)).toBe(false)
        expect(f.retired).toEqual([])
    })
    it('does not infer archive from absent, foreign, reused or ambiguous ownership', () => {
        const f = fixture()
        expect(reconcileArchivedSharedResume({ ...f.options, records: [] })).toBe(false)
        expect(reconcileArchivedSharedResume({ ...f.options, hub: 'foreign' })).toBe(false)
        expect(reconcileArchivedSharedResume({ ...f.options, authHash: 'foreign' })).toBe(false)
        expect(reconcileArchivedSharedResume({ ...f.options, isLive: () => false })).toBe(false)
        f.options.owners.set(456, 'primary')
        expect(reconcileArchivedSharedResume(f.options)).toBe(false)
        expect(f.retired).toEqual([])
    })
})
