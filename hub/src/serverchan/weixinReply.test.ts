import { describe, expect, it, mock } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import type { Store, StoredMessage } from '../store'
import { isWeixinReply } from './weixinReply'
import { ServerChanChannel } from './channel'

const weixin = 'weixin:' + 'a'.repeat(32)
function session(turns: Record<string, string> = { [weixin]: 'turn-1' }): Session {
    return { id: 'chat', active: true, namespace: 'default', metadata: {
        path: '/chat', host: 'test', conversationHistoryTurns: turns
    } } as Session
}
function message(role: string, localId: string | null, invokedAt: number | null = 1, text = 'answer'): StoredMessage {
    return { id: 'row', sessionId: 'chat', seq: 1, createdAt: 1, invokedAt, scheduledAt: null,
        localId, content: { role, content: role === 'agent'
            ? { type: 'codex', data: { type: 'message', message: text } }
            : { type: 'text', text } } }
}
const reply = () => message('agent', 'codex:thread:turn-1:item:agent_message')
function store(rows: StoredMessage[]): Pick<Store, 'messages'> {
    return { messages: { getMessages: () => rows } } as unknown as Pick<Store, 'messages'>
}

describe('WeChat ready notification source', () => {
    it('matches the exact assistant turn to the WeChat request', () => {
        expect(isWeixinReply(session(), store([message('user', weixin), reply()]))).toBe(true)
    })
    it('does not suppress a web request in the same session', () => {
        expect(isWeixinReply(session({ 'web-request': 'turn-1' }), store([reply()]))).toBe(false)
    })
    it('does not suppress mixed-origin steered turns', () => {
        expect(isWeixinReply(session({ [weixin]: 'turn-1', web: 'turn-1' }), store([reply()]))).toBe(false)
    })
    it('does not let a later queued web prompt reclassify the completed answer', () => {
        expect(isWeixinReply(session(), store([reply(), message('user', 'web', null)]))).toBe(true)
    })
    it('never reuses an older answer after a newer prompt was invoked', () => {
        expect(isWeixinReply(session(), store([reply(), message('user', 'web')]))).toBe(false)
    })
    it('never infers origin from quoted text or a chat name', () => {
        const s = session({ web: 'turn-1' }); s.metadata!.name = 'WeChat'
        expect(isWeixinReply(s, store([message('agent', 'codex:thread:turn-1:item:agent_message', 1, weixin)]))).toBe(false)
    })
    it('does not suppress unrelated child-thread output or missing mappings', () => {
        expect(isWeixinReply(session(), store([message('agent', 'codex:child:child-turn:item:agent_message')]))).toBe(false)
        expect(isWeixinReply(session({}), store([reply()]))).toBe(false)
    })
    it('does not suppress when lookup fails or identity is missing', () => {
        const broken = { messages: { getMessages: () => { throw Error('storage unavailable') } } } as unknown as Pick<Store, 'messages'>
        expect(isWeixinReply(session(), broken)).toBe(false)
        expect(isWeixinReply(session(), store([message('agent', null)]))).toBe(false)
        expect(isWeixinReply(session(), store([]))).toBe(false)
    })
    it('suppresses only ServerChan ready; actionable permission/failure/completion notifications remain', async () => {
        const original = globalThis.fetch, fetchMock = mock(async () => Response.json({ code: 0 }))
        globalThis.fetch = fetchMock as unknown as typeof fetch
        try {
            const s = session(), channel = new ServerChanChannel('SCT_TEST', 'https://hapi.example.com', null, false,
                value => isWeixinReply(value, store([reply()])))
            await channel.sendReady(s)
            expect(fetchMock).not.toHaveBeenCalled()
            await channel.sendPermissionRequest(s)
            await channel.sendTaskNotification(s, { status: 'failed', summary: 'needs attention' })
            await channel.sendSessionCompletion(s, 'completed')
            expect(fetchMock).toHaveBeenCalledTimes(3)
        } finally { globalThis.fetch = original }
    })
    it('sends the normal ready notification for a web reply in the same chat', async () => {
        const original = globalThis.fetch, fetchMock = mock(async () => Response.json({ code: 0 }))
        globalThis.fetch = fetchMock as unknown as typeof fetch
        try {
            const s = session({ web: 'turn-1' })
            await new ServerChanChannel('SCT_TEST', 'https://hapi.example.com', null, false,
                value => isWeixinReply(value, store([reply()]))).sendReady(s)
            expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally { globalThis.fetch = original }
    })
})
