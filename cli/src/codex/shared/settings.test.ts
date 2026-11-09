import { describe, expect, it } from 'vitest';
import { inheritedSandbox, settingsMatch } from './settings';

describe('native shared settings', () => {
    it('does not acknowledge another client changing an unrelated field', () => {
        expect(settingsMatch({ model: 'a', effort: 'high' }, { threadId: 't', model: 'b' })).toBe(false);
        expect(settingsMatch({ model: 'b', effort: 'high' }, { threadId: 't', model: 'b' })).toBe(true);
        expect(settingsMatch({ serviceTier: 'priority' }, { serviceTier: null })).toBe(false);
    });
    it('confirms the native default notification after explicitly clearing service tier', () => {
        expect(settingsMatch({ serviceTier: 'default' }, { serviceTier: null })).toBe(true);
        expect(settingsMatch({ serviceTier: null }, { serviceTier: null })).toBe(true);
        for (const actual of [undefined, 'priority', 'fast', 'standard', '']) {
            expect(settingsMatch({ serviceTier: actual }, { serviceTier: null })).toBe(false);
        }
        expect(settingsMatch({ serviceTier: 'default' }, { serviceTier: 'priority' })).toBe(false);
    });
    it('keeps every other setting strict when the tier uses default representation', () => {
        const expected = { serviceTier: null, model: 'm', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } };
        const actual = { ...expected, serviceTier: 'default' };
        expect(settingsMatch(actual, expected)).toBe(true);
        expect(settingsMatch({ ...actual, model: 'other' }, expected)).toBe(false);
        expect(settingsMatch({ ...actual, approvalsReviewer: 'auto_review' }, expected)).toBe(false);
        expect(settingsMatch({ ...actual, sandboxPolicy: { type: 'workspaceWrite', networkAccess: true } }, expected)).toBe(false);
    });
    it('matches collaboration settings including model and effort, but accepts expanded built-in instructions', () => {
        const expected = { collaborationMode: { mode: 'plan', settings: { model: 'b', reasoning_effort: 'high', developer_instructions: null } } };
        expect(settingsMatch({ collaborationMode: { mode: 'plan', settings: { model: 'a', reasoning_effort: 'high' } } }, expected)).toBe(false);
        expect(settingsMatch({ collaborationMode: { mode: 'plan', settings: { model: 'b', reasoning_effort: 'high', developer_instructions: 'native instructions' } } }, expected)).toBe(true);
    });
    it('preserves workspace sandbox restrictions and never widens an external or named profile', () => {
        expect(inheritedSandbox({ sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/project'], networkAccess: false,
            excludeTmpdirEnvVar: true, excludeSlashTmp: true } })).toEqual({ sandbox: 'workspace-write', config: {
            'sandbox_workspace_write.writable_roots': ['/project'], 'sandbox_workspace_write.network_access': false,
            'sandbox_workspace_write.exclude_tmpdir_env_var': true, 'sandbox_workspace_write.exclude_slash_tmp': true
        } });
        expect(() => inheritedSandbox({ sandboxPolicy: { type: 'externalSandbox' } })).toThrow('Cannot inherit');
        expect(() => inheritedSandbox({ activePermissionProfile: { id: 'restricted' } })).toThrow('named permission profile');
    });
});
