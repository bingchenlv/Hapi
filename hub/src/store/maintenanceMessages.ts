import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { MaintenanceMessageRequestSchema, maintenanceMessageDigestInput, type MaintenanceMessageRequest, type MaintenanceMessageReceipt } from '@hapi/protocol/apiTypes'
import { z } from 'zod'
import { addMessage, getMessageById } from './messages'
import type { StoredMessage } from './types'

export const MAINTENANCE_REQUEST_DDL = `
    CREATE TABLE IF NOT EXISTS maintenance_message_request (
        request_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS maintenance_request_no_update BEFORE UPDATE ON maintenance_message_request
        BEGIN SELECT RAISE(ABORT, 'maintenance request identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS maintenance_request_no_delete BEFORE DELETE ON maintenance_message_request
        BEGIN SELECT RAISE(ABORT, 'maintenance request identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS maintenance_request_no_replace BEFORE INSERT ON maintenance_message_request
        WHEN EXISTS (SELECT 1 FROM maintenance_message_request WHERE request_key=NEW.request_key OR message_id=NEW.message_id)
        BEGIN SELECT RAISE(ABORT, 'maintenance request identity is immutable'); END;
`

export class MaintenanceIdentityError extends Error {
    constructor() { super('Maintenance request identity conflicts or binding is unavailable') }
}

export function getMaintenanceMessageReceipt(db: Database, sessionId: string, requestKey: string, inserted = false): MaintenanceMessageReceipt | null {
    const record = db.prepare('SELECT content_sha256,message_id FROM maintenance_message_request WHERE session_id=? AND request_key=?')
        .get(sessionId, requestKey) as { content_sha256: string; message_id: string } | undefined
    if (!record) return null
    const message = getMessageById(db, sessionId, record.message_id)
    const parsed = z.object({ role: z.literal('user'), content: z.object({ type: z.literal('text'), text: z.string() }),
        meta: z.object({ deliveryMode: z.literal('queue'), maintenanceRequest: z.object({ version: z.literal(1), contentSha256: z.literal(record.content_sha256) }) }) }).safeParse(message?.content)
    const contentVerified = message?.localId === requestKey && parsed.success && createHash('sha256').update(maintenanceMessageDigestInput(sessionId,
        { requestKey, text: parsed.data.content.text })).digest('hex') === record.content_sha256
    return { version: 1, sessionId, requestKey, contentSha256: record.content_sha256, messageId: record.message_id,
        inserted, contentVerified,
        state: !message ? 'missing_unknown' : !contentVerified ? 'indeterminate' : message.invokedAt !== null ? 'invoked'
            : message.deliveryState === 'indeterminate' || message.deliveryState === 'dispatching' ? 'indeterminate' : 'stored',
        modelCompletionVerified: false }
}

export function addMaintenanceMessage(db: Database, sessionId: string, request: MaintenanceMessageRequest): {
    message: StoredMessage | null; messageId: string; inserted: boolean
} {
    const parsed = MaintenanceMessageRequestSchema.safeParse(request)
    if (!parsed.success || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)) throw new MaintenanceIdentityError()
    const digest = createHash('sha256').update(maintenanceMessageDigestInput(sessionId, parsed.data)).digest('hex')
    if (digest !== parsed.data.contentSha256) throw new MaintenanceIdentityError()
    const content = { role: 'user', content: { type: 'text', text: parsed.data.text },
        meta: { sentFrom: 'webapp', deliveryMode: 'queue', maintenanceRequest: { version: 1, contentSha256: digest } } }
    return db.transaction(() => {
        const session = db.prepare('SELECT metadata FROM sessions WHERE id=?').get(sessionId) as { metadata: string | null } | undefined
        if (!session?.metadata) throw new MaintenanceIdentityError()
        const metadata = JSON.parse(session.metadata) as Record<string, unknown>
        if (metadata.flavor !== 'codex' || metadata.supersededBySessionId || metadata.opencodeClearOperation) throw new MaintenanceIdentityError()
        const prior = db.prepare('SELECT session_id,content_sha256,message_id FROM maintenance_message_request WHERE request_key=?')
            .get(parsed.data.requestKey) as { session_id: string; content_sha256: string; message_id: string } | undefined
        if (prior) {
            if (prior.session_id !== sessionId || prior.content_sha256 !== digest) throw new MaintenanceIdentityError()
            const message = getMessageById(db, sessionId, prior.message_id)
            if (message && (message.localId !== parsed.data.requestKey || !isDeepStrictEqual(message.content, content))) throw new MaintenanceIdentityError()
            // Missing/canceled/removed rows keep their original request identity.
            // No new message and no transport replay is allowed here.
            return { message, messageId: prior.message_id, inserted: false }
        }
        if (db.prepare('SELECT 1 FROM messages WHERE session_id=? AND local_id=?').get(sessionId, parsed.data.requestKey)) throw new MaintenanceIdentityError()
        const message = addMessage(db, sessionId, content, parsed.data.requestKey)
        db.prepare('INSERT INTO maintenance_message_request VALUES(?,?,?,?,?)')
            .run(parsed.data.requestKey, sessionId, digest, message.id, Date.now())
        return { message, messageId: message.id, inserted: true }
    })()
}
