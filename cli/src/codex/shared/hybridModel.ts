import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const helperRoot = '/home/ubuntu/workspace/minimax-codex';
export type HybridMode = 'openai' | 'hybrid';

export function hybridModelAvailable(): boolean {
    return existsSync(`${helperRoot}/session_policy.py`);
}

/** The root owns this binding; model arguments cannot select another session. */
export function hybridMcpConfig(sessionId: string): Record<string, unknown> {
    return {
        command: '/usr/bin/python3', args: [`${helperRoot}/worker.py`, 'mcp'],
        enabled: true, startup_timeout_sec: 10, tool_timeout_sec: 60,
        default_tools_approval_mode: 'approve',
        env: { MINIMAX_HAPI_SESSION_ID: sessionId }
    };
}

export async function hybridModelPolicy(sessionId: string, mode?: HybridMode): Promise<{ mode: HybridMode }> {
    return new Promise((resolve, reject) => {
        const child = execFile('/usr/bin/python3', [`${helperRoot}/session_policy.py`],
            { timeout: 5_000, maxBuffer: 4096 }, (error, stdout) => {
                try {
                    const result = JSON.parse(stdout);
                    if (error || !['openai', 'hybrid'].includes(result.mode)) {
                        reject(new Error(result.error ?? 'MiniMax session policy unavailable')); return;
                    }
                    resolve({ mode: result.mode });
                } catch { reject(new Error('MiniMax session policy unavailable')); }
            });
        child.stdin!.end(JSON.stringify({ session_id: sessionId, ...(mode ? { mode } : {}) }));
    });
}
