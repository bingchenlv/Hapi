import { describe, expect, it } from 'vitest'
import { MetadataSchema, SessionEndReasonSchema } from './schemas'

describe('fresh-session clear schema contract', () => {
    it('preserves the archived session replacement link', () => {
        expect(MetadataSchema.parse({
            path: '/tmp/project',
            host: 'host',
            supersededBySessionId: 'new-session-id'
        })).toMatchObject({ supersededBySessionId: 'new-session-id' })
    })

    it('accepts a positive shared Codex auto-name sequence', () => {
        expect(MetadataSchema.parse({
            path: '/tmp/project',
            host: 'host',
            codexAutoNameSequence: 3
        })).toMatchObject({ codexAutoNameSequence: 3 })
        expect(MetadataSchema.safeParse({
            path: '/tmp/project',
            host: 'host',
            codexAutoNameSequence: 0
        }).success).toBe(false)
    })

    it('accepts cleared as an additive session-end reason', () => {
        expect(SessionEndReasonSchema.parse('cleared')).toBe('cleared')
    })
})
