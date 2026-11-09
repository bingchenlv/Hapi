import { Hono } from 'hono'
import { MessagesQuerySchema, QueuedStateRequestSchema, SendMessageRequestSchema, MaintenanceMessageRequestSchema } from '@hapi/protocol'
import { MaintenanceIdentityError } from '../../store/maintenanceMessages'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

export function createMessagesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/maintenance/requests/:requestKey', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const binding = requireSessionFromParam(c, engine)
        if (binding instanceof Response) return binding
        if (binding.sessionId !== c.req.param('id')) return c.json({ error: 'Exact session binding required' }, 409)
        const result = engine.getMaintenanceMessageReceipt(binding.sessionId, c.req.param('requestKey'))
        return result ? c.json(result) : c.json({ error: 'Request not found; delivery remains unknown' }, 404)
    })

    app.post('/sessions/:id/maintenance/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const binding = requireSessionFromParam(c, engine, { requireActive: true })
        if (binding instanceof Response) return binding
        if (binding.sessionId !== c.req.param('id') || binding.session.metadata?.flavor !== 'codex') {
            return c.json({ error: 'Exact Codex session binding required' }, 409)
        }
        const parsed = MaintenanceMessageRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid maintenance request' }, 400)
        try {
            return c.json(engine.sendMaintenanceMessage(binding.sessionId, parsed.data))
        } catch (error) {
            if (error instanceof MaintenanceIdentityError) return c.json({ error: 'Maintenance request identity conflict' }, 409)
            throw error
        }
    })

    app.get('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const parsed = MessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', issues: parsed.error.flatten() }, 400)
        }

        const limit = parsed.data.limit ?? 50
        const before = parsed.data.beforeAt !== undefined && parsed.data.beforeSeq !== undefined
            ? { at: parsed.data.beforeAt, seq: parsed.data.beforeSeq }
            : null
        const after = parsed.data.afterAt !== undefined && parsed.data.afterSeq !== undefined
            ? { at: parsed.data.afterAt, seq: parsed.data.afterSeq }
            : null
        const until = parsed.data.untilAt !== undefined && parsed.data.untilSeq !== undefined
            ? { at: parsed.data.untilAt, seq: parsed.data.untilSeq }
            : null
        return c.json(engine.getMessagesPage(sessionId, {
            limit,
            before,
            after,
            until,
            epoch: parsed.data.epoch ?? null
        }))
    })

    app.delete('/sessions/:id/messages/:messageId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        const messageId = c.req.param('messageId')

        const result = await engine.cancelQueuedMessage(sessionId, messageId)
        return c.json(result)
    })

    app.post('/sessions/:id/messages/:messageId/steer', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        const messageId = c.req.param('messageId')

        const result = await engine.steerQueuedMessage(sessionId, messageId)
        return c.json(result)
    })

    app.post('/sessions/:id/messages/:messageId/retry', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        return c.json(await engine.retryIndeterminateMessage(
            sessionResult.sessionId,
            c.req.param('messageId')
        ))
    })

    app.post('/sessions/:id/messages/queued-state', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = QueuedStateRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const localIds = [...new Set(parsed.data.localIds)]
        if (localIds.length === 0) {
            return c.json({ queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: [] })
        }
        return c.json(engine.getQueuedState(sessionId, localIds))
    })

    app.post('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = SendMessageRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        // Require text or attachments
        if (!parsed.data.text && (!parsed.data.attachments || parsed.data.attachments.length === 0)) {
            return c.json({ error: 'Message requires text or attachments' }, 400)
        }

        await engine.sendMessage(sessionId, {
            text: parsed.data.text,
            localId: parsed.data.localId,
            attachments: parsed.data.attachments,
            sentFrom: 'webapp',
            scheduledAt: parsed.data.scheduledAt,
            deliveryMode: parsed.data.deliveryMode
        })
        return c.json({ ok: true })
    })

    return app
}
