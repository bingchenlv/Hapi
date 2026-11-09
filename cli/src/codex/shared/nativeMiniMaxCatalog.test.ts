import { describe, expect, it } from 'vitest';
import { extendMiniMaxCatalog } from './nativeMiniMaxCatalog';

const native = { slug: 'gpt-5.5', base_instructions: 'You are Codex, based on GPT.\nPreserve native operating instructions.', shell_type: 'unified_exec',
    model_messages: { instructions_template: 'GPT-specific code mode' }, context_window: 272000, arbitrary_future_field: { keep: true } };
const bundled = JSON.stringify({ models: [native] });
describe('native MiniMax startup catalog', () => {
    it('preserves effective custom/OpenAI descriptors and registers MiniMax context only', () => {
        const existing = [{ slug: 'gpt-6.1-sol', context_window: 500000 }, { slug: 'custom-local', context_window: 12345, tool_mode: 'custom' }];
        const result = JSON.parse(extendMiniMaxCatalog(JSON.stringify({ models: existing, future_catalog_field: true }), bundled));
        expect(result.models.slice(0, 2)).toEqual(existing); expect(result.future_catalog_field).toBe(true);
        expect(result.models[2]).toMatchObject({ slug: 'MiniMax-M3.1-Flash', context_window: 1000000, max_context_window: 1000000,
            default_reasoning_level: 'max', model_messages: null, service_tiers: [], use_responses_lite: false, comp_hash: null,
            support_verbosity: false, supports_reasoning_effort_updates: true });
        expect(result.models[2].base_instructions).toBe('You are a coding assistant powered by MiniMax.\nPreserve native operating instructions.');
    });
    it('honors an explicitly configured MiniMax descriptor without changing it', () => {
        const original = { models: [{ slug: 'MiniMax-M3.1-Flash', context_window: 200000, custom: true }] };
        expect(JSON.parse(extendMiniMaxCatalog(JSON.stringify(original), 'unused'))).toEqual(original);
    });
    it('fails explicitly for malformed catalogs or missing generic native template', () => {
        for (const value of ['null', '{}', '{"models":[]}', '{"models":[null]}', '{"models":[{"slug":3}]}']) {
            expect(() => extendMiniMaxCatalog(value, bundled)).toThrow();
        }
        expect(() => extendMiniMaxCatalog(JSON.stringify({ models: [{ slug: 'custom' }] }), JSON.stringify({ models: [{ slug: 'new-native' }] }))).toThrow('template unavailable');
    });
});
