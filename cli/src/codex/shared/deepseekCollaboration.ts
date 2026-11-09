import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = '/home/ubuntu/workspace/deepseek-codex/collaboration';
const files = ['worker.py', 'session_policy.py', 'stop_guard.py', 'contracts.py', 'core_rules.py',
    'work_packages.py', 'agent_transport.py', 'mcp_server.py', 'runtime_revision.py', 'routing.py', 'routing_config.py', 'provider-catalog.json', 'routing-policy.default.json', 'COLLABORATION-PLAYBOOK.md', 'AGENT-GUIDANCE.md'];

/** Only a reviewed deployment marker can enable root-bound collaboration. */
export function deepseekCollaborationConfig(sessionId: string): Record<string, unknown> | null {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) return null;
    try {
        const marker = join(homedir(), '.config/deepseek-codex/collaboration-deployment.json');
        const info = lstatSync(marker);
        if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || info.size > 16_384 || (info.mode & 0o077) !== 0) return null;
        const data = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>;
        if (data.version !== 1 || data.accepted !== true || typeof data.revision !== 'string'
            || !/^[a-f0-9]{64}$/.test(data.revision) || typeof data.clientRevision !== 'string'
            || !/^[a-f0-9]{64}$/.test(data.clientRevision)) return null;
        const digest = createHash('sha256');
        for (const name of files) digest.update(name).update('\0').update(readFileSync(join(root, name))).update('\0');
        const legacy = createHash('sha256');
        for (const name of ['client.py', 'mcp_server.py']) {
            const content = readFileSync(join(root, '..', name));
            digest.update(name).update('\0').update(content).update('\0');
            legacy.update(content);
        }
        if (digest.digest('hex') !== data.revision || legacy.digest('hex') !== data.clientRevision) return null;
        return { command: '/usr/bin/python3', args: [`${root}/mcp_server.py`], enabled: true,
            startup_timeout_sec: 10, tool_timeout_sec: 150, default_tools_approval_mode: 'approve',
            env: { DEEPSEEK_HAPI_SESSION_ID: sessionId, DEEPSEEK_COLLABORATION_REVISION: data.revision,
                DEEPSEEK_HELPER_REVISION: data.clientRevision } };
    } catch { return null; }
}

/** Local setting only: no model turn and no change to MiniMax's preference. */
export async function deepseekCollaborationPolicy(sessionId: string, mode?: 'openai' | 'hybrid'): Promise<{ mode: 'openai' | 'hybrid' }> {
    if (!deepseekCollaborationConfig(sessionId)) throw new Error('DeepSeek collaboration runtime is unavailable');
    return new Promise((resolve, reject) => {
        const child = execFile('/usr/bin/python3', [`${root}/session_policy.py`],
            { timeout: 5_000, maxBuffer: 4096 }, (error, stdout) => {
                try {
                    const result = JSON.parse(stdout);
                    if (error || !result || !['openai', 'hybrid'].includes(result.mode)
                        || mode !== undefined && result.mode !== mode) {
                        reject(new Error('DeepSeek collaboration setting was not confirmed')); return;
                    }
                    resolve({ mode: result.mode });
                } catch { reject(new Error('DeepSeek collaboration setting was not confirmed')); }
            });
        child.stdin!.end(JSON.stringify({ session_id: sessionId, ...(mode ? { mode } : {}) }));
    });
}
