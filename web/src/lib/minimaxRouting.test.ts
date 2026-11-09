import { describe, expect, it } from 'vitest'
import type { CodexModelSummary } from '@/types/api'
import { sessionModelCatalog } from './minimaxRouting'

describe('session provider capability', () => {
    it('offers DeepSeek only to a runtime that advertises its own provider support', () => {
        const models = [{id:'gpt-6.1-terra'},{id:'deepseek-flash'},{id:'deepseek-v4-pro'}] as CodexModelSummary[]
        expect(sessionModelCatalog(models,true).map(x=>x.id)).toEqual(['gpt-6.1-terra'])
        expect(sessionModelCatalog(models,false,true)).toEqual(models)
    })
    it('never offers a MiniMax model to a legacy OpenAI-only execution', () => {
        const models = [{ id: 'gpt-6-astra' }, { id: 'MiniMax-M3.1-Flash' }] as CodexModelSummary[]
        expect(sessionModelCatalog(models, false).map(model => model.id)).toEqual(['gpt-6-astra'])
        expect(sessionModelCatalog(models, true)).toEqual(models)
    })
})
