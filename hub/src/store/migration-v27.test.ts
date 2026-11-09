import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { maintenanceMessageDigestInput } from '@hapi/protocol/apiTypes'
import { Store } from './index'

describe('schema migration v26 to v27', () => {
    it('preserves ordinary history, then persists immutable maintenance identities across reopen', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-migration-v27-'))
        const path = join(directory, 'hub.db')
        let store: Store | undefined
        try {
            store = new Store(path)
            const session = store.sessions.getOrCreateSession(randomUUID(), { flavor: 'codex' }, null, 'default')
            const message = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'ordinary history' } }, 'ordinary-local-id')
            store.close(); store = undefined
            const old = new Database(path)
            old.exec('DROP TABLE maintenance_message_request; PRAGMA user_version=26;')
            old.close()
            store = new Store(path)
            const db = (store as unknown as { db: Database }).db
            expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 27 })
            expect(store.messages.getAllMessages(session.id)).toEqual([message])
            const input = { version: 1 as const, requestKey: randomUUID(), text: 'authorized maintenance' }
            const request = { ...input, contentSha256: createHash('sha256').update(maintenanceMessageDigestInput(session.id, input)).digest('hex') }
            const inserted = store.addMaintenanceMessage(session.id, request)
            for (const sql of [
                'DELETE FROM maintenance_message_request',
                "UPDATE maintenance_message_request SET content_sha256='changed'",
                'INSERT OR REPLACE INTO maintenance_message_request SELECT * FROM maintenance_message_request'
            ]) expect(() => db.exec(sql)).toThrow('immutable')
            store.close(); store = new Store(path)
            expect(store.addMaintenanceMessage(session.id, request)).toMatchObject({ inserted: false, messageId: inserted.messageId })
            expect(store.messages.getAllMessages(session.id)).toHaveLength(2)
        } finally { store?.close(); rmSync(directory, { recursive: true, force: true }) }
    })
})
