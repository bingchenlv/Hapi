import { describe, expect, it } from 'bun:test'
import { mapSpawnRpcResult, normalizeSpawnErrorCode } from './spawnRpcResult'

describe('spawn RPC result mapping', () => {
    const guardMessage = 'Session process exited before webhook for PID 42 (exit code 75). stderr: [HAPI resource guard] concurrent session limit reached'

    it('keeps the resource_busy code of a guard rejection', () => {
        const result = mapSpawnRpcResult({
            type: 'error',
            errorMessage: guardMessage,
            code: 'resource_busy'
        })

        expect(result).toEqual({
            type: 'error',
            message: guardMessage,
            code: 'resource_busy'
        })
    })

    it('drops unknown codes instead of forwarding them', () => {
        const result = mapSpawnRpcResult({
            type: 'error',
            errorMessage: 'boom',
            code: 'resource_busy_ish'
        })

        expect(result).toEqual({ type: 'error', message: 'boom' })
        expect(normalizeSpawnErrorCode('resource_busy_ish')).toBeUndefined()
        expect(normalizeSpawnErrorCode(undefined)).toBeUndefined()
        expect(normalizeSpawnErrorCode(75)).toBeUndefined()
        expect(normalizeSpawnErrorCode(null)).toBeUndefined()
    })

    it('keeps the other known codes', () => {
        expect(normalizeSpawnErrorCode('agent_unavailable')).toBe('agent_unavailable')
        expect(normalizeSpawnErrorCode('outside_workspace_roots')).toBe('outside_workspace_roots')
        expect(normalizeSpawnErrorCode('resource_busy')).toBe('resource_busy')
    })

    it('maps a successful spawn', () => {
        expect(mapSpawnRpcResult({ type: 'success', sessionId: 'session-1' })).toEqual({
            type: 'success',
            sessionId: 'session-1'
        })
    })

    it('maps a spawn that needs directory approval', () => {
        expect(mapSpawnRpcResult({ type: 'requestToApproveDirectoryCreation', directory: '/tmp/x' })).toEqual({
            type: 'error',
            message: 'Directory creation requires approval: /tmp/x',
            childStarted: false
        })
    })

    it('maps an unexpected payload to an error', () => {
        expect(mapSpawnRpcResult('nope')).toEqual({ type: 'error', message: 'Unexpected spawn result: nope' })
    })
})
