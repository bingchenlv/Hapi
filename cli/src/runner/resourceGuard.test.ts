import { describe, expect, it } from 'vitest'
import {
    RESOURCE_GUARD_EXIT_CODE,
    RESOURCE_GUARD_STDERR_MARKER,
    classifySpawnFailure,
    hasResourceGuardMarker,
    stripAnsi,
    waitForStderrDrain
} from './resourceGuard'

describe('resource guard classification', () => {
    it('uses exit code 75 and the bracketed marker', () => {
        expect(RESOURCE_GUARD_EXIT_CODE).toBe(75)
        expect(RESOURCE_GUARD_STDERR_MARKER).toBe('[HAPI resource guard]')
    })

    it('classifies exit 75 with the guard marker as a resource-guard rejection', () => {
        const stderr = '[HAPI resource guard] concurrent session limit reached\n'
        expect(classifySpawnFailure({ exitCode: 75, stderr })).toBe('resource_busy')
    })

    it('classifies the marker through ANSI colour codes', () => {
        const stderr = `\u001b[31m${RESOURCE_GUARD_STDERR_MARKER}\u001b[39m concurrent session limit reached\n`
        expect(stripAnsi(stderr)).toContain(RESOURCE_GUARD_STDERR_MARKER)
        expect(classifySpawnFailure({ exitCode: 75, stderr })).toBe('resource_busy')
    })

    it('classifies the marker when ANSI codes are interleaved inside it', () => {
        const stderr = '[\u001b[1mHAPI\u001b[22m \u001b[1mresource guard\u001b[22m] concurrent session limit reached\n'
        expect(classifySpawnFailure({ exitCode: 75, stderr })).toBe('resource_busy')
    })

    it('does not classify a plain exit 75 without the marker', () => {
        expect(classifySpawnFailure({ exitCode: 75, stderr: 'Error: unknown option --hapi-session-id\n' })).toBe('failed')
        expect(classifySpawnFailure({ exitCode: 75, stderr: '' })).toBe('failed')
    })

    it('does not classify other exit codes even when the marker is present', () => {
        const stderr = `${RESOURCE_GUARD_STDERR_MARKER} concurrent session limit reached\n`
        expect(classifySpawnFailure({ exitCode: 0, stderr })).toBe('failed')
        expect(classifySpawnFailure({ exitCode: 1, stderr })).toBe('failed')
        expect(classifySpawnFailure({ exitCode: 2, stderr })).toBe('failed')
        expect(classifySpawnFailure({ exitCode: 143, stderr })).toBe('failed')
        expect(classifySpawnFailure({ exitCode: null, stderr })).toBe('failed')
    })

    it('does not classify a signalled child', () => {
        const stderr = `${RESOURCE_GUARD_STDERR_MARKER} concurrent session limit reached\n`
        expect(classifySpawnFailure({ exitCode: 75, signal: 'SIGTERM', stderr })).toBe('failed')
        expect(classifySpawnFailure({ exitCode: 75, signal: 'SIGKILL', stderr })).toBe('failed')
    })

    it('never classifies the session webhook timeout as a resource-guard rejection', () => {
        const stderr = `${RESOURCE_GUARD_STDERR_MARKER} concurrent session limit reached\n`
        expect(classifySpawnFailure({ exitCode: 75, stderr, timedOut: true })).toBe('failed')
        expect(classifySpawnFailure({ exitCode: null, stderr, timedOut: true })).toBe('failed')
        expect(classifySpawnFailure({ exitCode: 75, stderr: '', timedOut: true })).toBe('failed')
    })

    it('only matches the literal bracketed marker', () => {
        expect(hasResourceGuardMarker('HAPI resource guard')).toBe(false)
        expect(hasResourceGuardMarker('[HAPI resource guards]')).toBe(false)
        expect(hasResourceGuardMarker('[hapi resource guard]')).toBe(false)
        expect(hasResourceGuardMarker('[HAPI resource guard')).toBe(false)
        expect(hasResourceGuardMarker('')).toBe(false)
        expect(hasResourceGuardMarker(RESOURCE_GUARD_STDERR_MARKER)).toBe(true)
    })

    it('runs the drain callback when the child closes', async () => {
        let done = false
        const child = {
            once: (_event: string, listener: () => void) => {
                setTimeout(listener, 1)
            }
        }
        waitForStderrDrain(child, () => { done = true })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(done).toBe(true)
    })

    it('runs the drain callback after the grace period when the child never closes', async () => {
        let done = false
        const child = { once: () => {} }
        waitForStderrDrain(child, () => { done = true }, 5)
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(done).toBe(true)
    })
})
