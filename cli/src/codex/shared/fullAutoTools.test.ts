import { expect, it } from 'vitest';
import { fullAutoConfig, fullAutoToolOverrides } from './fullAutoTools';

it('overrides all independent tool approval layers without copying credentials or enabling tools', () => {
    const result = fullAutoToolOverrides({
        mcp_servers: { helper: { enabled: false, env: { PRIVATE: 'SENSITIVE_SENTINEL' }, tools: { write: { approval_mode: 'prompt' } } } },
        apps: { drive: { enabled: false, tools: { write: { approval_mode: 'prompt' } }, links: { account: { default_tools_approval_mode: 'prompt' } } } },
        plugins: { 'google-drive@openai': { mcp_servers: { drive: { tools: { write: {} } } } } },
        'mcp_servers.hapi': { tools: { display_image: { approval_mode: 'prompt' } } }
    });
    expect(result).toMatchObject({
        mcp_servers: { helper: { default_tools_approval_mode: 'approve', tools: { write: { approval_mode: 'approve' } } },
            hapi: { tools: { display_image: { approval_mode: 'approve' } } } },
        apps: { drive: { tools: { write: { approval_mode: 'approve' } }, links: { account: { default_tools_approval_mode: 'approve' } } } },
        plugins: { 'google-drive@openai': { mcp_servers: { drive: { tools: { write: { approval_mode: 'approve' } } } } } }
    });
    expect(JSON.stringify(result)).not.toContain('SENSITIVE_SENTINEL');
    expect(JSON.stringify(result)).not.toContain('enabled');
});

it('clears explicit injected prompt overrides while preserving transport and enablement', () => {
    const input = { enabled: false, command: 'worker', env: { BINDING: 'root' }, tools: { display_image: { approval_mode: 'prompt' } } };
    expect((fullAutoConfig({ 'mcp_servers.hapi': input }).mcp_servers as any).hapi).toMatchObject({ enabled: false, command: 'worker', env: { BINDING: 'root' },
        default_tools_approval_mode: 'approve', tools: { display_image: { approval_mode: 'approve' } } });
    expect(input.tools.display_image.approval_mode).toBe('prompt');
});

it('does not invent a transport-less MCP server when an optional bridge is absent', () => {
    expect((fullAutoConfig({ 'mcp_servers.hapi': undefined }).mcp_servers as any).hapi).toBeUndefined();
    expect((fullAutoToolOverrides({ 'mcp_servers.hapi': undefined }).mcp_servers as any)?.hapi).toBeUndefined();
});

it('drops absent nullable native read fields instead of writing them back as null', () => {
    // `config/read` reports an absent optional field as null. A thread config
    // override cannot represent null, so the field must be omitted to keep the
    // native inheritance of the global config.
    const native = {
        apps: { _default: { enabled: true, approvals_reviewer: null, destructive_enabled: true, open_world_enabled: true,
            default_tools_approval_mode: 'approve' } },
        plugins: { 'plugin@registry': { enabled: false, marketplace_path: null,
            mcp_servers: { proof: { enabled: false, tools: { write: { approval_mode: null } } } } } },
        mcp_servers: { proof: { command: 'worker', args: [], env: { PRIVATE: 'local-sentinel' },
            enabled: false, startup_timeout_sec: 0, url: null, tools: { write: { approval_mode: null } } } }
    };
    const before = JSON.stringify(native);
    const result = fullAutoConfig({}, native) as any;
    // The absent reviewer is omitted, not replaced: the top-level reviewer of
    // the global config keeps applying.
    expect(result.apps._default.approvals_reviewer).toBeUndefined();
    expect(result.apps._default).toMatchObject({ enabled: true, destructive_enabled: true, open_world_enabled: true,
        default_tools_approval_mode: 'approve' });
    // Explicit values keep their meaning.
    expect(result.plugins['plugin@registry'].enabled).toBe(false);
    expect(result.mcp_servers.proof).toMatchObject({ command: 'worker', args: [], env: { PRIVATE: 'local-sentinel' },
        enabled: false, startup_timeout_sec: 0, tools: { write: { approval_mode: 'approve' } } });
    expect(JSON.stringify(result)).not.toContain(':null');
    // The read snapshot itself is never mutated.
    expect(JSON.stringify(native)).toBe(before);
});

it('keeps an explicit reviewer and an explicit caller override', () => {
    const native = { apps: { _default: { approvals_reviewer: 'auto_review' } } };
    expect((fullAutoConfig({}, native) as any).apps._default.approvals_reviewer).toBe('auto_review');
    // A caller override is a write, not a read projection: it is not rewritten.
    expect((fullAutoConfig({ apps: { _default: { approvals_reviewer: 'user' } } }, native) as any).apps._default.approvals_reviewer).toBe('user');
    expect((fullAutoConfig({ unrelated: null }, native) as any).unrelated).toBeNull();
});
