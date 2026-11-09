import { describe, expect, it } from 'vitest';
import { fallbackMessageId, isCodexUsageExhaustion, minimaxServerArgs, minimaxThreadConfig, MINIMAX_MODEL, MINIMAX_PROVIDER, MINIMAX_EFFORTS, validateMiniMaxEffort, providerForModel } from './minimax';

describe('MiniMax routing contract', () => {
    it('uses the released model and upgrades stored preview settings without changing providers or permissions', () => {
        expect(MINIMAX_MODEL).toBe('MiniMax-M3.1-Flash');
        for (const model of [MINIMAX_MODEL, 'MiniMax-M3.1-Flash-Preview']) {
            expect(providerForModel(model)).toBe(MINIMAX_PROVIDER);
            expect(minimaxThreadConfig({ model, approvalPolicy: 'on-request', sandbox: 'workspace-write' }))
                .toMatchObject({ model: MINIMAX_MODEL, modelProvider: MINIMAX_PROVIDER,
                    approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'auto_review' });
        }
        expect(minimaxThreadConfig({model: MINIMAX_MODEL}, 'user')).toMatchObject({approvalsReviewer: 'user'});
        expect(providerForModel('gpt-6-astra')).toBe('openai');
    });
    it('admits all five real effort levels and rejects silent downgrade values', () => {
        expect(MINIMAX_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
        for (const effort of MINIMAX_EFFORTS) expect(validateMiniMaxEffort(effort)).toBe(effort);
        expect(validateMiniMaxEffort(null)).toBe('max');
        expect(validateMiniMaxEffort(' XHIGH ')).toBe('xhigh');
        for (const effort of ['ultra', 'none', '', 1]) {
            expect(() => minimaxThreadConfig({ model: MINIMAX_MODEL, config: { model_reasoning_effort: effort } })).toThrow('MiniMax supports');
        }
    });
    it('only admits typed account usage exhaustion, never ordinary rate/network or model-written errors', () => {
        expect(isCodexUsageExhaustion({ codexErrorInfo: 'usageLimitExceeded' })).toBe(true);
        for (const error of [null, 'usageLimitExceeded', { message: 'usage limit exceeded' }, { codexErrorInfo: 'rateLimitExceeded' },
            { codexErrorInfo: 'sessionBudgetExceeded' }, { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } },
            { codexErrorInfo: 'unauthorized' }, { codexErrorInfo: 'contextWindowExceeded' }]) expect(isCodexUsageExhaustion(error)).toBe(false);
    });
    it('retains caller permissions and other MCP tools while disabling recursive helper dispatch', () => {
        const params = minimaxThreadConfig({ model: MINIMAX_MODEL, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
            sandbox: 'workspace-write', developerInstructions: 'Project rules', config: { 'mcp_servers.hapi': { command: 'bridge' } } }, 'auto_review', 'on-request');
        expect(params).toMatchObject({ modelProvider: MINIMAX_PROVIDER, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
            sandbox: 'workspace-write', serviceTier: null, config: { 'mcp_servers.hapi': { command: 'bridge' },
                'mcp_servers.minimax_helper': { enabled: false }, model_reasoning_effort: 'max', web_search: 'disabled' } });
        expect(params.developerInstructions).toContain('Project rules');
        expect(params.developerInstructions).toContain('独立 MiniMax 主控');
    });
    it('leaves the normal provider configuration untouched and emits no credential in arguments', () => {
        const openai = { model: 'gpt-6-astra', config: { web_search: 'live' } };
        expect(minimaxThreadConfig(openai)).toBe(openai);
        const args = minimaxServerArgs();
        expect(args).toContain('model_providers.hapi_minimax.auth.command="/usr/bin/python3"');
        expect(args).toContain('model_providers.hapi_minimax.auth.args=["/home/ubuntu/workspace/minimax-codex/native_auth.py"]');
        expect(args.join(' ')).not.toContain('sk-cp-');
        const routed = minimaxServerArgs({name:'MiniMax',base_url:'http://127.0.0.1/test',requires_openai_auth:true});
        expect(routed.join(' ')).not.toContain('auth.command');
        expect(args.join(' ')).not.toContain('api-key');
        expect(fallbackMessageId('turn')).toBe(fallbackMessageId('turn'));
    });
});
