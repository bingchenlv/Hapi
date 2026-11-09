import { describe, expect, it, vi } from 'vitest'
import { inspectQueuedState } from './pingPeer'
import type { AxiosInstance } from 'axios'

const sessionId = '11111111-2222-3333-4444-555555555555'
const empty = { queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: [] }

function fixture(body: unknown = empty) {
    const gets = [
        { session: { id: sessionId, active: true, metadata: { flavor: 'codex' } } },
        { session: { id: sessionId, active: true, metadata: { flavor: 'codex' } } }
    ]
    const post = vi.fn(async (url: string, value: unknown) => {
        if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'test-jwt' } }
        expect(url).toBe(`http://hub.test/api/sessions/${sessionId}/messages/queued-state`)
        expect(value).toEqual({ localIds: ['key'] })
        return { status: 200, data: body }
    })
    const get = vi.fn(async (url: string) => {
        expect(url).toBe(`http://hub.test/api/sessions/${sessionId}`)
        return { status: 200, data: gets.shift() }
    })
    const options = { sessionId, requestKey: 'key', apiUrl: 'http://hub.test', accessToken: 'test-token',
        http: { post, get } as unknown as AxiosInstance }
    return { options, post, get, gets }
}

describe('inspectQueuedState', () => {
    it.each([
        empty,
        { ...empty, queuedLocalIds: ['key'] },
        { ...empty, indeterminateLocalIds: ['key'] },
        { ...empty, invokedLocalMessages: [{ localId: 'key', invokedAt: 1000 }] }
    ])('reads exact request state without delivery or resume: %j', async body => {
        const f = fixture(body)
        expect(await inspectQueuedState(f.options)).toEqual(body)
        expect(f.get).toHaveBeenCalledTimes(2)
        expect(f.post).toHaveBeenCalledTimes(2)
    })

    it.each([
        {}, null, { ...empty, extra: true }, { ...empty, queuedLocalIds: ['wrong'] },
        { ...empty, queuedLocalIds: ['key', 'key'] },
        { ...empty, queuedLocalIds: ['key'], indeterminateLocalIds: ['key'] },
        { ...empty, invokedLocalMessages: [{ localId: 'key', invokedAt: true }] },
        { ...empty, invokedLocalMessages: [{ localId: 'key', invokedAt: NaN }] },
        { ...empty, invokedLocalMessages: [{ localId: 'key', invokedAt: 0 }] }
    ])('rejects invalid or contradictory response: %j', async body => {
        const f = fixture(body)
        await expect(inspectQueuedState(f.options)).rejects.toThrow('delivery remains unknown')
    })

    it('rejects session drift without resuming or sending', async () => {
        const f = fixture()
        f.gets[1]!.session.active = false
        await expect(inspectQueuedState(f.options)).rejects.toThrow('delivery remains unknown')
        expect(f.post).toHaveBeenCalledTimes(2)
    })

    it('does not disclose or retry transport failures', async () => {
        const f = fixture()
        f.post.mockRejectedValueOnce(new Error('private-token-and-payload'))
        await expect(inspectQueuedState(f.options)).rejects.toThrow(/^Queued-state observation unavailable; delivery remains unknown$/)
        expect(f.post).toHaveBeenCalledTimes(1)
    })

    it.each(['', 'k'.repeat(257), '\ud800'])('rejects invalid request key before I/O', async requestKey => {
        const f = fixture()
        await expect(inspectQueuedState({ ...f.options, requestKey })).rejects.toThrow('bounded request key')
        expect(f.post).not.toHaveBeenCalled()
    })

    it('rejects prefix identities before I/O', async () => {
        const f = fixture()
        await expect(inspectQueuedState({ ...f.options, sessionId: '1111' })).rejects.toThrow('Exact session identity')
        expect(f.post).not.toHaveBeenCalled()
    })
})
