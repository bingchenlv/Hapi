import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import { MessageService } from './messageService'
import type { EventPublisher } from './eventPublisher'
import { Store } from '../store'

function setup(shared = true) {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession('shared-api-input', { capabilities: { concurrentClients: shared } }, null, 'default')
    const deliveries: any[] = []
    const io = { of: () => ({ to: () => ({ emit: (_name: string, update: unknown) => deliveries.push(update) }) }) } as unknown as Server
    const publisher = { emit() {} } as unknown as EventPublisher
    return { store, session, deliveries, service: new MessageService(store, io, publisher) }
}
describe('shared API input identity', () => {
    it.each([undefined, null])('allocates one durable identity for an API input without localId=%s', async localId => {
        const h = setup()
        try {
            await h.service.sendMessage(h.session.id, { text: 'same input', localId })
            const original = h.store.messages.getAllMessages(h.session.id)[0]
            expect(original.localId).toMatch(/^[0-9a-f-]{36}$/)
            expect(h.deliveries[0].body.message.localId).toBe(original.localId)
            h.store.messages.syncNativeQueuedMessage(h.session.id, original.localId!, 'same input')
            expect(h.store.messages.getAllMessages(h.session.id)).toHaveLength(1)
            h.store.messages.markMessagesInvoked(h.session.id, [original.localId!], 12345)
            expect(h.store.messages.getAllMessages(h.session.id)[0]).toMatchObject({ id: original.id, invokedAt: 12345 })
            await h.service.sendMessage(h.session.id, { text: 'same input' })
            const all = h.store.messages.getAllMessages(h.session.id)
            expect(all).toHaveLength(2); expect(new Set(all.map(row => row.localId)).size).toBe(2)
        } finally { h.store.close() }
    })
    it('preserves explicit retry identities and keeps legacy idless delivery unchanged', async () => {
        const h = setup(); const legacy = setup(false)
        try {
            await h.service.sendMessage(h.session.id, { text: 'explicit request', localId: 'fixed-id' })
            await h.service.sendMessage(h.session.id, { text: 'explicit request', localId: 'fixed-id' })
            expect(h.store.messages.getAllMessages(h.session.id)).toHaveLength(1)
            expect(h.deliveries.every(update => update.body.message.localId === 'fixed-id')).toBe(true)
            await legacy.service.sendMessage(legacy.session.id, { text: 'legacy input' })
            expect(legacy.store.messages.getAllMessages(legacy.session.id)[0].localId).toBeNull()
        } finally { h.store.close(); legacy.store.close() }
    })
})
