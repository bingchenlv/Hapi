import { describe, expect, it } from 'vitest';
import { DEEPSEEK_MODELS, DEEPSEEK_EFFORTS } from '@hapi/protocol';
import { deepseekServerArgs, deepseekThreadConfig, extendDeepSeekCatalog, validateDeepSeekEffort, DEEPSEEK_PROVIDER } from './deepseek';
import { providerForModel, MINIMAX_PROVIDER } from './minimax';

describe('DeepSeek native provider', () => {
    it('routes only the two supported models, independently from MiniMax and OpenAI', () => {
        for (const model of DEEPSEEK_MODELS) expect(providerForModel(model)).toBe(DEEPSEEK_PROVIDER);
        expect(providerForModel('gpt-6.1-terra')).toBe('openai');
        expect(providerForModel('MiniMax-M3.1-Flash')).toBe(MINIMAX_PROVIDER);
    });
    it('exposes three distinct effort levels and rejects silently mapped aliases', () => {
        for (const value of DEEPSEEK_EFFORTS) expect(validateDeepSeekEffort(value)).toBe(value);
        expect(validateDeepSeekEffort(null)).toBe('high');
        for (const value of ['medium','ultra','xhigh',true,'']) expect(() => validateDeepSeekEffort(value)).toThrow('DeepSeek supports');
    });
    it('retains permissions and other tools, disables recursive dispatch, and clears service tier', () => {
        const p = deepseekThreadConfig({ model:'deepseek-v4-pro', sandbox:'danger-full-access', approvalPolicy:'never',
            config:{ 'mcp_servers.hapi':{command:'bridge'}, model_reasoning_effort:'max' } });
        expect(p).toMatchObject({ modelProvider: DEEPSEEK_PROVIDER, sandbox:'danger-full-access', approvalPolicy:'never', serviceTier:null,
            config:{model_reasoning_effort:'max','mcp_servers.hapi':{command:'bridge'},'mcp_servers.deepseek':{enabled:false}} });
        const original = {model:'gpt-6.1-terra'}; expect(deepseekThreadConfig(original)).toBe(original);
        expect(deepseekServerArgs().join(' ')).toContain('model_providers.hapi_deepseek.auth.command');
        expect(deepseekServerArgs().join(' ')).not.toContain('sk-');
    });
    it('merges the official descriptors without losing OpenAI or MiniMax metadata', () => {
        const current = {models:[{slug:'gpt-6.1-terra', marker:42},{slug:'MiniMax-M3.1-Flash',marker:7}]};
        const official = {models:DEEPSEEK_MODELS.map(slug=>({slug, supported_reasoning_levels:DEEPSEEK_EFFORTS.map(effort=>({effort})),context_window:1048576}))};
        const result = JSON.parse(extendDeepSeekCatalog(JSON.stringify(current),JSON.stringify(official)));
        expect(result.models.slice(0,2)).toEqual(current.models); expect(result.models).toHaveLength(4);
        expect(() => extendDeepSeekCatalog(JSON.stringify(current),'{}')).toThrow();
    });
});
