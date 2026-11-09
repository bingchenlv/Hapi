import { describe, expect, it } from 'bun:test'
import { MetadataSchema } from './schemas'
import { toSessionSummaryMetadata } from './sessionSummary'

describe('project metadata transport', () => {
    it('survives schema, JSON and the list summary while retaining the actual cwd', () => {
        const project = { id: 'FF', name: '家庭记账', directory: '/work/family-finance', controllerSessionId: 'controller', role: 'controller' as const }
        const restored = MetadataSchema.parse(JSON.parse(JSON.stringify({ path: '/work', host: 'test', project })))
        expect(restored.path).toBe('/work')
        expect(restored.project).toEqual(project)
        expect(toSessionSummaryMetadata(restored)?.project).toEqual(project)
        expect(toSessionSummaryMetadata(restored)?.path).toBe('/work')
        expect(toSessionSummaryMetadata({ path: '/plain', host: 'test' })?.project).toBeUndefined()
    })
})
