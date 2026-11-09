/**
 * Real-process tests for the resource-guard classifier.
 *
 * These spawn a plain local `node -e` child (no model, no network, no
 * external service) that reproduces what the CLI's resource guard does:
 * print the marker on stderr and exit with RESOURCE_GUARD_EXIT_CODE.
 *
 * The lifecycle is what matters here:
 *   - the marker is visible in the captured stderr once the child closed
 *   - the bounded drain leaves no 'close' listener behind
 *   - the drain callback runs exactly once
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
    RESOURCE_GUARD_EXIT_CODE,
    RESOURCE_GUARD_STDERR_MARKER,
    classifySpawnFailure,
    waitForStderrDrain
} from './resourceGuard'
import type { SpawnFailureKind } from './resourceGuard'

const GUARD_MESSAGE = `${RESOURCE_GUARD_STDERR_MARKER} concurrent session limit reached\n`

/** Child script that mimics the resource guard: marker on stderr, exit 75. */
const GUARD_SCRIPT = [
    `process.stderr.write(${JSON.stringify(GUARD_MESSAGE)});`,
    `process.exit(${RESOURCE_GUARD_EXIT_CODE});`
].join('')

/** Child script that exits 75 without the marker (a different failure). */
const BARE_75_SCRIPT =
    `process.stderr.write('Error: unknown option --hapi-session-id\\n');` +
    `process.exit(${RESOURCE_GUARD_EXIT_CODE});`

/** Child script that dies from a signal. */
const SIGNALLED_SCRIPT = `process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);`

interface LocalChild {
    child: ChildProcess
    stderr: () => string
    closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function spawnLocalChild(script: string): LocalChild {
    const child = spawn(process.execPath, ['-e', script], {
        stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    const stderrStream = child.stderr
    if (!stderrStream) {
        throw new Error('expected the child stderr to be piped')
    }
    stderrStream.setEncoding('utf8')
    stderrStream.on('data', (chunk: string) => {
        stderr += chunk
    })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', (error) => reject(error))
        child.once('close', (code, signal) => resolve({ code, signal }))
    })
    return { child, stderr: () => stderr, closed }
}

describe('resource guard classification against a real child process', () => {
    it('classifies a real child that exits 75 with the guard marker as resource_busy', async () => {
        const local = spawnLocalChild(GUARD_SCRIPT)
        const { code, signal } = await local.closed
        expect(code).toBe(RESOURCE_GUARD_EXIT_CODE)
        expect(signal).toBeNull()
        expect(local.stderr()).toContain(RESOURCE_GUARD_STDERR_MARKER)
        expect(classifySpawnFailure({ exitCode: code, signal, stderr: local.stderr() })).toBe('resource_busy')
    })

    it('does not classify a real child that exits 75 without the marker', async () => {
        const local = spawnLocalChild(BARE_75_SCRIPT)
        const { code, signal } = await local.closed
        expect(code).toBe(RESOURCE_GUARD_EXIT_CODE)
        expect(classifySpawnFailure({ exitCode: code, signal, stderr: local.stderr() })).toBe('failed')
    })

    it('does not classify a signalled real child even with the marker on stderr', async () => {
        const local = spawnLocalChild(SIGNALLED_SCRIPT)
        const { code, signal } = await local.closed
        expect(signal).toBe('SIGTERM')
        expect(
            classifySpawnFailure({
                exitCode: code,
                signal,
                stderr: `${RESOURCE_GUARD_STDERR_MARKER} concurrent session limit reached\n`
            })
        ).toBe('failed')
    })

    it('sees the guard marker when the exit failure is classified after the drain', async () => {
        const local = spawnLocalChild(GUARD_SCRIPT)
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            local.child.once('exit', (code, signal) => resolve({ code, signal }))
        })
        const { code, signal } = await exited
        let classified: SpawnFailureKind | null = null
        await new Promise<void>((resolve) => {
            waitForStderrDrain(local.child, () => {
                classified = classifySpawnFailure({
                    exitCode: code,
                    signal,
                    stderr: local.stderr()
                })
                resolve()
            })
        })
        expect(classified).toBe('resource_busy')
    })

    it('detaches the close listener when the drain grace period wins', async () => {
        const local = spawnLocalChild('setInterval(() => {}, 1000)')
        const before = local.child.listenerCount('close')
        await new Promise<void>((resolve) => {
            waitForStderrDrain(local.child, () => resolve(), 20)
        })
        expect(local.child.listenerCount('close')).toBe(before)
        local.child.kill('SIGKILL')
        await local.closed
    })

    it('runs the drain callback exactly once when the child closes later', async () => {
        const local = spawnLocalChild('setTimeout(() => {}, 300)')
        let calls = 0
        await new Promise<void>((resolve) => {
            waitForStderrDrain(local.child, () => {
                calls += 1
                resolve()
            }, 20)
        })
        await local.closed
        expect(calls).toBe(1)
    })
})
