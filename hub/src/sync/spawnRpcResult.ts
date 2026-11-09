import type { AgentFlavor } from '@hapi/protocol/types'

/**
 * Error codes the hub understands for a failed session spawn.
 *
 * `resource_busy` is reported by the runner when the child CLI was rejected
 * by the resource guard (exit code 75 plus a `[HAPI resource guard]` marker
 * on stderr). The condition is transient, so the API answers 503 instead of
 * a generic 500.
 */
export type SpawnRpcErrorCode = 'agent_unavailable' | 'outside_workspace_roots' | 'resource_busy'

export type SpawnRpcOutcome =
    | { type: 'success'; sessionId: string }
    | {
        type: 'error'
        message: string
        code?: SpawnRpcErrorCode
        agent?: AgentFlavor
        /** Explicit false = no OS child; stub safe to delete (#1911 B3). */
        childStarted?: boolean
    }

/**
 * Normalizes the `code` field of a spawn RPC error payload. Unknown codes are
 * dropped instead of forwarded, so a new or unexpected code can never be
 * mistaken for a known condition by the callers.
 */
export function normalizeSpawnErrorCode(code: unknown): SpawnRpcErrorCode | undefined {
    return code === 'agent_unavailable'
        || code === 'outside_workspace_roots'
        || code === 'resource_busy'
            ? code
            : undefined
}

/**
 * Maps the raw `SpawnHappySession` RPC payload to a typed outcome.
 */
export function mapSpawnRpcResult(result: unknown): SpawnRpcOutcome {
    if (result && typeof result === 'object') {
        const obj = result as Record<string, unknown>
        if (obj.type === 'success' && typeof obj.sessionId === 'string') {
            return { type: 'success', sessionId: obj.sessionId }
        }
        if (obj.type === 'error' && typeof obj.errorMessage === 'string') {
            const code = normalizeSpawnErrorCode(obj.code)
            const unavailableAgent = typeof obj.agent === 'string' ? obj.agent as AgentFlavor : undefined
            const childStarted = obj.childStarted === false ? false : undefined
            return {
                type: 'error',
                message: obj.errorMessage,
                ...(code ? { code } : {}),
                ...(unavailableAgent ? { agent: unavailableAgent } : {}),
                ...(childStarted === false ? { childStarted: false } : {}),
            }
        }
        if (obj.type === 'requestToApproveDirectoryCreation' && typeof obj.directory === 'string') {
            return {
                type: 'error',
                message: `Directory creation requires approval: ${obj.directory}`,
                childStarted: false,
            }
        }
        if (typeof obj.error === 'string') {
            return { type: 'error', message: obj.error }
        }
        if (obj.type !== 'success' && typeof obj.message === 'string') {
            return { type: 'error', message: obj.message }
        }
    }
    const details = typeof result === 'string'
        ? result
        : (() => {
            try {
                return JSON.stringify(result)
            } catch {
                return String(result)
            }
        })()
    return { type: 'error', message: `Unexpected spawn result: ${details}` }
}
