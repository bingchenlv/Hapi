import { describe, expect, it, mock } from 'bun:test'
import type { SessionEndReason } from '@hapi/protocol'
import type { Session } from '../sync/syncEngine'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { ServerChanChannel } from './channel'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            path: 'F:\\develop\\code\\usdt',
            host: 'DESKTOP'
        },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        ...overrides
    }
}

function acceptedResponse(): Response {
    return Response.json({ code: 0 })
}

describe('ServerChanChannel', () => {
    it('does not send completed task notifications', async () => {
        const fetchMock = mock(async () => acceptedResponse())
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new ServerChanChannel('SCT_TEST', 'https://hapi.example.com')
            await channel.sendTaskNotification(createSession(), {
                status: 'completed',
                summary: 'Subtask finished'
            })

            expect(fetchMock).not.toHaveBeenCalled()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('sends failed task notifications', async () => {
        const fetchMock = mock(async () => acceptedResponse())
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new ServerChanChannel('SCT_TEST', 'https://hapi.example.com')
            await channel.sendTaskNotification(createSession(), {
                status: 'failed',
                summary: 'Subtask failed'
            })

            expect(fetchMock).toHaveBeenCalledTimes(1)
            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const url = call?.[0]
            const init = call?.[1] as RequestInit | undefined
            expect(String(url)).toContain('https://sctapi.ftqq.com/SCT_TEST.send')
            expect((init?.body as URLSearchParams).get('title')).toBe('HAPI Task failed')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('sends session completion notifications', async () => {
        const fetchMock = mock(async () => acceptedResponse())
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new ServerChanChannel('SCT_TEST', 'https://hapi.example.com')
            await channel.sendSessionCompletion(createSession({
                id: 'session-complete',
                metadata: {
                    path: 'F:\\develop\\code\\usdt',
                    host: 'DESKTOP',
                    name: 'USDT review'
                }
            }), 'completed' satisfies SessionEndReason)

            expect(fetchMock).toHaveBeenCalledTimes(1)
            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const url = call?.[0]
            const init = call?.[1] as RequestInit | undefined
            expect(String(url)).toContain('https://sctapi.ftqq.com/SCT_TEST.send')
            expect((init?.body as URLSearchParams).get('title')).toBe('HAPI Session completed')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('suppresses every notification when the namespace has a visible connection', async () => {
        const fetchMock = mock(async () => acceptedResponse())
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const visibilityTracker = new VisibilityTracker()
            visibilityTracker.registerConnection('visible-1', 'default', 'visible')
            const channel = new ServerChanChannel(
                'SCT_TEST',
                'https://hapi.example.com',
                visibilityTracker,
                true
            )

            await channel.sendReady(createSession())
            await channel.sendPermissionRequest(createSession())
            await channel.sendTaskNotification(createSession(), {
                status: 'failed',
                summary: 'Subtask failed'
            })
            await channel.sendSessionCompletion(createSession(), 'completed' satisfies SessionEndReason)

            expect(fetchMock).not.toHaveBeenCalled()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('keeps sending when background-only mode is disabled', async () => {
        const fetchMock = mock(async () => acceptedResponse())
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const visibilityTracker = new VisibilityTracker()
            visibilityTracker.registerConnection('visible-1', 'default', 'visible')
            const channel = new ServerChanChannel(
                'SCT_TEST',
                'https://hapi.example.com',
                visibilityTracker,
                false
            )

            await channel.sendReady(createSession())

            expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('sends when the namespace has no visible connection', async () => {
        const fetchMock = mock(async () => acceptedResponse())
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const visibilityTracker = new VisibilityTracker()
            visibilityTracker.registerConnection('hidden-1', 'default', 'hidden')
            const channel = new ServerChanChannel(
                'SCT_TEST',
                'https://hapi.example.com',
                visibilityTracker,
                true
            )

            await channel.sendReady(createSession())

            expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('only considers visible connections in the same namespace', async () => {
        const fetchMock = mock(async () => acceptedResponse())
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const visibilityTracker = new VisibilityTracker()
            visibilityTracker.registerConnection('visible-1', 'other-namespace', 'visible')
            const channel = new ServerChanChannel(
                'SCT_TEST',
                'https://hapi.example.com',
                visibilityTracker,
                true
            )

            await channel.sendReady(createSession())

            expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('rejects HTTP 200 business errors without exposing provider content', async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async () => Response.json({ code: 40001, message: 'SCT_PRIVATE_FIXTURE' })) as unknown as typeof fetch
        try {
            await expect(new ServerChanChannel('SCT_PRIVATE_FIXTURE', 'https://hapi.example.com').sendReady(createSession()))
                .rejects.toThrow('Server酱未接受消息: 业务码 40001')
        } finally { globalThis.fetch = originalFetch }
    })

    it('reports malformed success responses as unknown, not accepted', async () => {
        const originalFetch = globalThis.fetch
        try {
            for (const body of ['ok', '{}', '{"code":"0"}', 'null']) {
                globalThis.fetch = mock(async () => new Response(body)) as unknown as typeof fetch
                await expect(new ServerChanChannel('SCT_TEST', 'https://hapi.example.com').sendReady(createSession()))
                    .rejects.toThrow('发送结果未知')
            }
        } finally { globalThis.fetch = originalFetch }
    })

    it('redacts HTTP response bodies and status text', async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async () => new Response('SCT_PRIVATE_FIXTURE', { status: 503, statusText: 'SCT_PRIVATE_FIXTURE' })) as unknown as typeof fetch
        try {
            await expect(new ServerChanChannel('SCT_PRIVATE_FIXTURE', 'https://hapi.example.com').sendReady(createSession()))
                .rejects.toThrow(/^Server酱发送失败: HTTP 503$/)
        } finally { globalThis.fetch = originalFetch }
    })

    it('bounds the request, redacts fetch errors, and never retries unknown sends', async () => {
        const originalFetch = globalThis.fetch
        const fetchMock = mock(async (_url: unknown, init?: RequestInit) => {
            expect(init?.signal).toBeInstanceOf(AbortSignal)
            expect(init?.redirect).toBe('error')
            throw new Error('https://sctapi.ftqq.com/SCT_PRIVATE_FIXTURE.send')
        })
        globalThis.fetch = fetchMock as unknown as typeof fetch
        try {
            await expect(new ServerChanChannel('SCT_PRIVATE_FIXTURE', 'https://hapi.example.com').sendReady(createSession()))
                .rejects.toThrow(/^Server酱请求超时或网络失败，发送结果未知$/)
            expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally { globalThis.fetch = originalFetch }
    })
})
