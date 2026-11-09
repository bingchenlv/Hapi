import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deepseekCollaborationConfig } from './deepseekCollaboration';

const state = vi.hoisted(() => ({ marker: {} as Record<string, unknown>, mode: 0o100600, nlink: 1,
    regular: true, content: Buffer.from('reviewed candidate'), tampered: false }));
vi.mock('node:fs', () => ({
    lstatSync: () => ({ isFile: () => state.regular, uid: process.getuid?.(), mode: state.mode, nlink: state.nlink }),
    readFileSync: (path: string) => path.endsWith('collaboration-deployment.json') ? JSON.stringify(state.marker)
        : state.tampered && path.endsWith('/worker.py') ? Buffer.from('unreviewed edit') : state.content
}));
const files = ['worker.py', 'session_policy.py', 'stop_guard.py', 'contracts.py', 'core_rules.py',
    'work_packages.py', 'agent_transport.py', 'mcp_server.py', 'runtime_revision.py', 'routing.py', 'routing_config.py', 'provider-catalog.json', 'routing-policy.default.json', 'COLLABORATION-PLAYBOOK.md', 'AGENT-GUIDANCE.md',
    'client.py', 'mcp_server.py'];
beforeEach(() => {
    state.mode = 0o100600; state.nlink = 1; state.regular = true; state.tampered = false;
    const digest = createHash('sha256');
    for (const name of files) digest.update(name).update('\0').update(state.content).update('\0');
    const legacy = createHash('sha256').update(state.content).update(state.content).digest('hex');
    state.marker = { version: 1, accepted: true, revision: digest.digest('hex'), clientRevision: legacy };
});

describe('reviewed root-bound DeepSeek collaboration', () => {
    it('keeps the session identity local to each root and uses automatic tool approval', () => {
        const a = deepseekCollaborationConfig('session-a-123');
        const b = deepseekCollaborationConfig('session-b-123');
        expect(a).toMatchObject({ enabled: true, default_tools_approval_mode: 'approve',
            env: { DEEPSEEK_HAPI_SESSION_ID: 'session-a-123', DEEPSEEK_COLLABORATION_REVISION: state.marker.revision } });
        expect(b).toMatchObject({ env: { DEEPSEEK_HAPI_SESSION_ID: 'session-b-123' } });
    });
    it('does not advertise an unaccepted or modified runtime', () => {
        state.marker.accepted = false;
        expect(deepseekCollaborationConfig('session-a-123')).toBeNull();
        state.marker.accepted = true; state.tampered = true;
        expect(deepseekCollaborationConfig('session-a-123')).toBeNull();
    });
    it('rejects unsafe deployment files and invalid identity without enabling a helper', () => {
        for (const name of ['../session-id', '', 'short']) expect(deepseekCollaborationConfig(name)).toBeNull();
        state.mode = 0o100644;
        expect(deepseekCollaborationConfig('session-a-123')).toBeNull();
        state.mode = 0o100600; state.nlink = 2;
        expect(deepseekCollaborationConfig('session-a-123')).toBeNull();
        state.nlink = 1; state.regular = false;
        expect(deepseekCollaborationConfig('session-a-123')).toBeNull();
    });
});
