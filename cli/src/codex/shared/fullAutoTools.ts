import { record } from './gateway';

/** Policy projection only: no credentials, transports or enablement flags. */
export function fullAutoToolOverrides(config: unknown): Record<string, unknown> {
    const source = record(config);
    const policy = (value: unknown) => ({ default_tools_approval_mode: 'approve', tools: Object.fromEntries(
        Object.keys(record(record(value).tools)).map(name => [name, { approval_mode: 'approve' }])) });
    const servers = Object.fromEntries(Object.entries(record(source.mcp_servers)).map(([name, value]) => [name, policy(value)]));
    for (const [key, value] of Object.entries(source)) {
        if (/^mcp_servers\.[A-Za-z0-9_-]+$/.test(key) && value != null) servers[key.slice('mcp_servers.'.length)] = policy(value);
    }
    const apps: Record<string, unknown> = { _default: { default_tools_approval_mode: 'approve' } };
    for (const [name, value] of Object.entries(record(source.apps))) {
        apps[name] = { ...policy(value), links: Object.fromEntries(Object.keys(record(record(value).links))
            .map(link => [link, { default_tools_approval_mode: 'approve' }])) };
    }
    const plugins = Object.fromEntries(Object.entries(record(source.plugins)).map(([name, value]) => [name,
        { mcp_servers: Object.fromEntries(Object.entries(record(record(value).mcp_servers)).map(([server, p]) => [server, policy(p)])) }]));
    return { apps, ...(Object.keys(servers).length ? { mcp_servers: servers } : {}),
        ...(Object.keys(plugins).length ? { plugins } : {}) };
}

function merge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
    const result = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
        result[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? merge(record(result[key]), record(value)) : value;
    }
    return result;
}

/** `config/read` reports an absent optional field as JSON null, but a TOML
 * write override cannot represent null: optional enums reject it with an
 * unknown-variant error. Only the read snapshot is projected here, so dropping
 * an absent field keeps the native inheritance of the global config instead of
 * substituting a value. Explicit caller overrides and every explicit value
 * (false, 0, empty list, valid reviewer, disabled flag, MCP transport and its
 * in-memory credentials) are preserved untouched. */
function writableSnapshot(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(writableSnapshot);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .filter(([, child]) => child !== null && child !== undefined)
            .map(([key, child]) => [key, writableSnapshot(child)]));
    }
    return value;
}

/** Native thread config keys split on dots; nested tables preserve literal IDs. */
export function fullAutoConfig(config: Record<string, unknown>, nativeConfig: Record<string, unknown> = {}): Record<string, unknown> {
    // Native thread overrides replace server tables, so retain the existing
    // transport in process memory. Never persist/log this merged config.
    const normalized = merge(record(writableSnapshot(nativeConfig)), config);
    const servers = { ...record(normalized.mcp_servers) }; normalized.mcp_servers = servers;
    for (const [key, value] of Object.entries(config)) {
        if (!/^mcp_servers\.[A-Za-z0-9_-]+$/.test(key)) continue;
        if (value != null) servers[key.slice('mcp_servers.'.length)] = value;
        delete (normalized as Record<string, unknown>)[key];
    }
    return merge(normalized, fullAutoToolOverrides(normalized));
}
