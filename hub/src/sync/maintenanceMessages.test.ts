import { describe, expect, it } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'socket.io'
import { MaintenanceMessageRequestSchema, maintenanceMessageDigestInput } from '@hapi/protocol/apiTypes'
import { Store } from '../store'
import { MessageService } from './messageService'
import type { EventPublisher } from './eventPublisher'
import { MaintenanceIdentityError } from '../store/maintenanceMessages'

function fixture(path = ':memory:') {
    const store = new Store(path)
    const session = store.sessions.getOrCreateSession(randomUUID(), { flavor: 'codex', capabilities: { concurrentClients: true } }, null, 'default')
    const deliveries: unknown[] = []
    const io = { of: () => ({ to: () => ({ emit: (_name: string, data: unknown) => deliveries.push(data) }) }) } as unknown as Server
    const publisher = { emit() {} } as unknown as EventPublisher
    const service = new MessageService(store, io, publisher)
    const request = (text = '修补真实任务', requestKey = randomUUID()) => {
        const input = { version: 1 as const, requestKey, text }
        return { ...input, contentSha256: createHash('sha256').update(maintenanceMessageDigestInput(session.id, input)).digest('hex') }
    }
    return { store, session, deliveries, service, request }
}

describe('versioned maintenance request identity', () => {
    it('refuses to verify a row whose maintenance marker changed even if its text still matches', () => {
        const f = fixture()
        try {
            const request = f.request()
            const receipt = f.service.sendMaintenanceMessage(f.session.id, request)
            const db = (f.store as unknown as { db: Database }).db
            const original = f.store.messages.getAllMessages(f.session.id)[0]!
            const altered = { ...(original.content as object), meta: {} }
            db.prepare('UPDATE messages SET content=? WHERE id=?').run(JSON.stringify(altered), receipt.messageId)
            expect(f.store.getMaintenanceMessageReceipt(f.session.id, request.requestKey)).toMatchObject({ contentVerified: false, state: 'indeterminate' })
            expect(() => f.service.sendMaintenanceMessage(f.session.id, request)).toThrow(MaintenanceIdentityError)
            expect(f.deliveries).toHaveLength(1)
        } finally { f.store.close() }
    })

    it('inserts once, emits once, and never equates stored/invoked with model completion', () => {
        const f = fixture()
        try {
            const request = f.request()
            const first = f.service.sendMaintenanceMessage(f.session.id, request)
            expect(first).toMatchObject({ inserted: true, state: 'stored', modelCompletionVerified: false })
            expect(f.service.sendMaintenanceMessage(f.session.id, request)).toMatchObject({ inserted: false, messageId: first.messageId })
            expect(f.deliveries).toHaveLength(1)
            f.store.messages.markMessagesInvoked(f.session.id, [request.requestKey], Date.now())
            expect(f.service.sendMaintenanceMessage(f.session.id, request)).toMatchObject({ state: 'invoked', inserted: false, modelCompletionVerified: false })
            expect(f.deliveries).toHaveLength(1)
        } finally { f.store.close() }
    })

    it('rejects same key with changed content, hash, or target without another delivery', () => {
        const f = fixture()
        try {
            const request = f.request(); f.service.sendMaintenanceMessage(f.session.id, request)
            expect(() => f.service.sendMaintenanceMessage(f.session.id, f.request('不同内容', request.requestKey))).toThrow(MaintenanceIdentityError)
            expect(() => f.service.sendMaintenanceMessage(f.session.id, { ...request, contentSha256: '0'.repeat(64) })).toThrow(MaintenanceIdentityError)
            const other = f.store.sessions.getOrCreateSession('other', { flavor: 'codex' }, null, 'default')
            expect(() => f.service.sendMaintenanceMessage(other.id, request)).toThrow(MaintenanceIdentityError)
            expect(f.deliveries).toHaveLength(1)
        } finally { f.store.close() }
    })

    it('preserves the request after cancellation and never recreates a removed message', () => {
        const f = fixture()
        try {
            const request = f.request(); const first = f.service.sendMaintenanceMessage(f.session.id, request)
            f.store.messages.cancelQueuedMessage(f.session.id, first.messageId)
            expect(f.service.sendMaintenanceMessage(f.session.id, request)).toMatchObject({ state: 'missing_unknown', inserted: false })
            expect(f.store.messages.getAllMessages(f.session.id)).toHaveLength(0)
            expect(f.deliveries).toHaveLength(1)
            expect(() => f.store.messages.addMessage(f.session.id, 'ordinary replay', request.requestKey)).toThrow('reserved')
        } finally { f.store.close() }
    })

    it('allows identical native mirroring while rejecting edits and ordinary replays', () => {
        const f = fixture()
        try {
            const request = f.request(); const first = f.service.sendMaintenanceMessage(f.session.id, request)
            expect(f.store.messages.syncNativeQueuedMessage(f.session.id, request.requestKey, request.text).id).toBe(first.messageId)
            expect(() => f.store.messages.syncNativeQueuedMessage(f.session.id, request.requestKey, 'changed')).toThrow('immutable')
            expect(() => f.store.messages.addMessage(f.session.id, 'changed', request.requestKey)).toThrow('reserved')
        } finally { f.store.close() }
    })

    it('keeps a strict key unavailable to ordinary indeterminate retries', async () => {
        const f = fixture()
        try {
            const request = f.request(); const first = f.service.sendMaintenanceMessage(f.session.id, request)
            f.store.messages.markMessagesIndeterminate(f.session.id, [request.requestKey])
            expect(await f.service.retryIndeterminateMessage(f.session.id, first.messageId)).toEqual({ status: 'retry-unavailable', localId: request.requestKey })
            expect(f.deliveries).toHaveLength(1)
        } finally { f.store.close() }
    })

    it('retains identity across a real database reopen', () => {
        const temp = mkdtempSync(join(tmpdir(), 'maintenance-identity-')); const path = join(temp, 'hapi.db')
        const f = fixture(path); const request = f.request(); const first = f.service.sendMaintenanceMessage(f.session.id, request); f.store.close()
        const reopened = new Store(path)
        try {
            expect(reopened.addMaintenanceMessage(f.session.id, request)).toMatchObject({ messageId: first.messageId, inserted: false })
            const db = new Database(path, { readonly: true })
            try { expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(27) }
            finally { db.close() }
        } finally { reopened.close(); rmSync(temp, { recursive: true, force: true }) }
    })

    it('rejects malformed contract fields without changing ordinary schema semantics', () => {
        const f = fixture()
        try {
            expect(MaintenanceMessageRequestSchema.safeParse({ ...f.request(), text: '\ud800' }).success).toBe(false)
            expect(MaintenanceMessageRequestSchema.safeParse({ ...f.request(), extra: true }).success).toBe(false)
            expect(MaintenanceMessageRequestSchema.safeParse({ ...f.request(), version: 2 }).success).toBe(false)
            expect(f.store.messages.getAllMessages(f.session.id)).toHaveLength(0)
        } finally { f.store.close() }
    })
})
