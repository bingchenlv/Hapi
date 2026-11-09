/**
 * Classification of resource-guard rejections reported by a spawned HAPI CLI.
 *
 * The resource guard runs inside the child CLI process. When it refuses a
 * spawn (for example because the machine already runs the maximum number of
 * concurrent sessions) it prints a marker on stderr and exits with code 75.
 *
 * Only that exact combination is a resource-guard rejection:
 *   - the exit code must be 75 (RESOURCE_GUARD_EXIT_CODE)
 *   - stderr must contain the literal marker `[HAPI resource guard]`
 *     (ANSI colour codes are stripped before the marker is looked for)
 *
 * Everything else stays a plain spawn failure:
 *   - a bare exit 75 without the marker (any other failure may use 75)
 *   - every other exit code and every signalled child
 *   - the session webhook timeout
 *
 * Misclassifying any of those as "busy" would turn an internal error into a
 * retryable 503, so the classifier is intentionally strict.
 */

export const RESOURCE_GUARD_EXIT_CODE = 75
export const RESOURCE_GUARD_STDERR_MARKER = '[HAPI resource guard]'

/**
 * Upper bound for the stderr drain wait. The guard writes its marker and
 * exits immediately, so the marker can still be in flight when the 'exit'
 * event is delivered; the runner waits for the child's stdio to close before
 * it decides whether the failure was a guard rejection.
 */
export const RESOURCE_GUARD_STDERR_DRAIN_TIMEOUT_MS = 250

export type SpawnFailureKind = 'resource_busy' | 'failed'

export interface SpawnFailureInput {
    /** Exit code reported by the child, or null when it was signalled. */
    exitCode: number | null
    /** Signal that terminated the child, if any. */
    signal?: NodeJS.Signals | string | null
    /** Captured stderr of the child (the runner keeps the tail). */
    stderr: string
    /** True when the failure came from the session webhook timeout. */
    timedOut?: boolean
}

// CSI sequences (colours, cursor moves) and OSC sequences (window titles).
const ANSI_CSI_PATTERN = /\u001B\[[0-9;?]*[ -\/]*[@-~]/g
const ANSI_OSC_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g

/**
 * Removes ANSI escape sequences so a coloured marker is still recognised.
 */
export function stripAnsi(text: string): string {
    return text.replace(ANSI_CSI_PATTERN, '').replace(ANSI_OSC_PATTERN, '')
}

/**
 * True when stderr carries the resource-guard marker. The marker must match
 * literally (including the brackets) so an unrelated message that merely
 * mentions the guard is never treated as a rejection.
 */
export function hasResourceGuardMarker(stderr: string): boolean {
    if (!stderr) {
        return false
    }
    return stripAnsi(stderr).includes(RESOURCE_GUARD_STDERR_MARKER)
}

/**
 * Classifies a failed session spawn.
 */
export function classifySpawnFailure(input: SpawnFailureInput): SpawnFailureKind {
    if (input.timedOut) {
        return 'failed'
    }
    if (input.signal) {
        return 'failed'
    }
    if (input.exitCode !== RESOURCE_GUARD_EXIT_CODE) {
        return 'failed'
    }
    if (!hasResourceGuardMarker(input.stderr)) {
        return 'failed'
    }
    return 'resource_busy'
}

/**
 * Minimal child surface the drain needs. `off`/`removeListener` are optional
 * so a plain EventEmitter-like stub still satisfies the type.
 */
export interface StderrDrainTarget {
    once: (event: string, listener: () => void) => unknown
    off?: (event: string, listener: () => void) => unknown
    removeListener?: (event: string, listener: () => void) => unknown
}

/**
 * Waits until the child's stderr has been drained (or the grace period has
 * elapsed) and then runs `done`. Used by the runner so the guard marker is
 * part of the captured tail before the exit failure is classified.
 *
 * The 'close' listener is always detached again: when the grace period wins
 * the child may keep the pipe open for a long time (detached grandchildren
 * inherit stdio), so a listener that stayed attached would outlive the drain.
 */
export function waitForStderrDrain(
    child: StderrDrainTarget,
    done: () => void,
    timeoutMs: number = RESOURCE_GUARD_STDERR_DRAIN_TIMEOUT_MS
): void {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    function finish(): void {
        if (settled) {
            return
        }
        settled = true
        if (timer) {
            clearTimeout(timer)
            timer = undefined
        }
        removeCloseListener()
        done()
    }
    function removeCloseListener(): void {
        try {
            if (typeof child.off === 'function') {
                child.off('close', finish)
            } else if (typeof child.removeListener === 'function') {
                child.removeListener('close', finish)
            }
        } catch {
            // Best effort for custom stubs; native ChildProcess.off is supported.
        }
    }
    timer = setTimeout(finish, timeoutMs)
    try {
        child.once('close', finish)
    } catch {
        finish()
    }
}
