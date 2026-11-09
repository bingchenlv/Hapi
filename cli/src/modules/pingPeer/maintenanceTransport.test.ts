import { describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import type { AxiosInstance } from 'axios'
import { maintenanceMessageDigestInput } from '@hapi/protocol/apiTypes'
import { readMaintenanceReceipt, submitMaintenanceMessage } from './pingPeer'

function setup() {
    const sessionId = randomUUID(); const requestKey = randomUUID()
    const input = { version: 1 as const, requestKey, text: 'bounded maintenance task' }
    const request = { ...input, contentSha256: createHash('sha256').update(maintenanceMessageDigestInput(sessionId, input)).digest('hex') }
    const receipt = { version: 1, sessionId, requestKey, contentSha256: request.contentSha256,
        messageId: randomUUID(), inserted: true, contentVerified: true, state: 'stored', modelCompletionVerified: false }
    const post = vi.fn(async (url: string) => url.endsWith('/api/auth')
        ? { status: 200, data: { token: 'fake-jwt' } } : { status: 200, data: receipt as unknown })
    const get = vi.fn(async (url: string) => url.includes('/maintenance/requests/')
        ? { status: 200, data: receipt as unknown } : { status: 200, data: { session: { id: sessionId, active: true, metadata: { flavor: 'codex' } } } as unknown })
    const options = { sessionId, request, apiUrl: 'http://hub.test', accessToken: 'fake-token', http: { post, get } as unknown as AxiosInstance }
    return { options, receipt, post, get }
}

describe('versioned maintenance transport', () => {
    it('sends the caller-persisted key and content digest once with no resume', async () => {
        const f = setup()
        expect(await submitMaintenanceMessage(f.options)).toEqual(f.receipt)
        expect(f.post).toHaveBeenCalledTimes(2)
        expect(f.post.mock.calls[1]![0]).toBe(`http://hub.test/api/sessions/${f.options.sessionId}/maintenance/messages`)
    })

    it('rejects malformed input or a wrong content digest before network I/O', async () => {
        const f = setup()
        await expect(submitMaintenanceMessage({ ...f.options, request: { ...f.options.request, contentSha256: '0'.repeat(64) } })).rejects.toThrow('digest mismatch')
        expect(f.post).not.toHaveBeenCalled()
    })

    it('rejects an inactive binding without trying resume or submission', async () => {
        const f = setup()
        f.get.mockResolvedValueOnce({ status: 200, data: { session: { id: f.options.sessionId, active: false, metadata: { flavor: 'codex' } } } })
        await expect(submitMaintenanceMessage(f.options)).rejects.toThrow('reconcile original request')
        expect(f.post).toHaveBeenCalledTimes(1)
    })

    it.each([{ ok: true }, { version: 1 }, { ...setup().receipt, modelCompletionVerified: true }])('rejects a legacy or mismatched receipt and never replays: %j', async invalid => {
        const f = setup()
        f.post.mockImplementation(async (url: string) => url.endsWith('/api/auth')
            ? { status: 200, data: { token: 'fake-jwt' } } : { status: 200, data: invalid })
        await expect(submitMaintenanceMessage(f.options)).rejects.toThrow('without replay')
        expect(f.post).toHaveBeenCalledTimes(2)
    })

    it('does not retry a lost submission response or echo private transport errors', async () => {
        const f = setup()
        f.post.mockImplementation(async (url: string) => {
            if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'fake-jwt' } }
            throw new Error('private-token-and-payload')
        })
        await expect(submitMaintenanceMessage(f.options)).rejects.toThrow(/^Maintenance submission unconfirmed; reconcile original request without replay$/)
        expect(f.post).toHaveBeenCalledTimes(2)
    })

    it('reads a receipt without submission and treats 404 only as unknown', async () => {
        const f = setup()
        expect(await readMaintenanceReceipt({ ...f.options, requestKey: f.options.request.requestKey })).toEqual(f.receipt)
        f.get.mockResolvedValueOnce({ status: 404, data: {} })
        expect(await readMaintenanceReceipt({ ...f.options, requestKey: f.options.request.requestKey })).toBeNull()
        expect(f.post.mock.calls.every(([url]) => url.endsWith('/api/auth'))).toBe(true)
    })
})
