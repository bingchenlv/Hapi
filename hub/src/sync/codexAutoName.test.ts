import { describe, expect, it } from 'bun:test'
import { syncCodexAutoName } from './codexAutoName'

const numbered = { flavor: 'codex', name: 'Codex-03', codexAutoNameSequence: 3 }

describe('syncCodexAutoName', () => {
    it('follows successive generated and native titles, retaining the sequence', () => {
        const first = syncCodexAutoName({ ...numbered, summary: { text: ' 第一项任务 ' } }, numbered)
        expect(first).toMatchObject({ name: '第一项任务', codexAutoNameTitle: '第一项任务', codexAutoNameSequence: 3 })
        const second = syncCodexAutoName({ ...first, summary: { text: '第二项任务' } }, first)
        expect(second.name).toBe('第二项任务')
        const native = syncCodexAutoName({ ...second, name: 'Native title' }, second)
        expect(native.name).toBe('Native title')
        expect(syncCodexAutoName(native, native).name).toBe('Native title')
    })

    it('keeps a title on sparse writes, empty titles and numbered echoes from old clients', () => {
        const current = { ...numbered, name: 'Task', codexAutoNameTitle: 'Task' }
        for (const next of [{}, { name: 'Codex-03' }, { name: '' }, { summary: { text: '  ' } }]) {
            expect(syncCodexAutoName(next, current)).toMatchObject({ name: 'Task', codexAutoNameSequence: 3 })
        }
    })

    it('preserves manual names and leaves unnumbered or other agents alone', () => {
        const manual = { ...numbered, name: 'My project' }
        expect(syncCodexAutoName({ ...manual, name: 'Native', summary: { text: 'Generated' } }, manual).name).toBe('My project')
        for (const current of [{ name: 'Unnumbered', flavor: 'codex' }, { name: 'Codex-03', flavor: 'claude' }]) {
            const next = { ...current, summary: { text: 'Generated' } }
            expect(syncCodexAutoName(next, current)).toEqual(next)
        }
    })

    it('backfills legacy numbered Codex sessions and rejects invalid numbering', () => {
        const legacy = { flavor: 'codex', name: 'Codex-02', summary: { text: 'Existing task' } }
        expect(syncCodexAutoName(legacy, legacy)).toMatchObject({ name: 'Existing task', codexAutoNameSequence: 2 })
        const invalid = { ...numbered, codexAutoNameSequence: -1 }
        expect(syncCodexAutoName(invalid, invalid)).toBe(invalid)
    })
})
