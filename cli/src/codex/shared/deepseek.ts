import { existsSync, lstatSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEEPSEEK_MODELS, DEEPSEEK_EFFORTS, isDeepSeekModel } from '@hapi/protocol';
import type { CodexModelSummary } from '@hapi/protocol/apiTypes';
import type { CodexCommand } from '../utils/codexExecutable';
import { record } from './gateway';

export const DEEPSEEK_PROVIDER = 'hapi_deepseek';
const authCommand = '/home/ubuntu/workspace/deepseek-codex/native_auth.py';
const catalogPath = () => join(homedir(), '.config/deepseek-codex/codex-home/models.json');

export function deepseekAvailable(): boolean {
    try {
        const directory = lstatSync(join(homedir(), '.config/deepseek-codex'));
        const key = lstatSync(join(homedir(), '.config/deepseek-codex/api-key'));
        return existsSync(authCommand) && existsSync(catalogPath()) && directory.isDirectory() && key.isFile()
            && directory.uid === process.getuid?.() && key.uid === process.getuid?.()
            && (directory.mode & 0o077) === 0 && (key.mode & 0o077) === 0;
    } catch { return false; }
}

export function validateDeepSeekEffort(value: unknown): string {
    const effort = value == null ? 'high' : typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!(DEEPSEEK_EFFORTS as readonly string[]).includes(effort)) throw new Error('DeepSeek supports only Low, High and Max');
    return effort;
}

export function deepseekServerArgs(): string[] {
    const config = { name: 'DeepSeek', base_url: 'https://api.deepseek.com/', wire_api: 'responses',
        requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0,
        auth: { command: '/usr/bin/python3', args: [authCommand], timeout_ms: 5_000, refresh_interval_ms: 0 } };
    const args: string[] = [];
    const visit = (prefix: string, object: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(object)) {
            if (value && typeof value === 'object' && !Array.isArray(value)) visit(`${prefix}.${key}`, record(value));
            else args.push('-c', `${prefix}.${key}=${JSON.stringify(value)}`);
        }
    };
    visit(`model_providers.${DEEPSEEK_PROVIDER}`, config);
    return args;
}

export function withDeepSeekModels(models: CodexModelSummary[]): CodexModelSummary[] {
    if (!deepseekAvailable()) return models.filter(model => !isDeepSeekModel(model.id));
    return [...models.filter(model => !isDeepSeekModel(model.id)), ...DEEPSEEK_MODELS.map(id => ({
        id, displayName: id === 'deepseek-flash' ? 'DeepSeek Flash' : 'DeepSeek V4 Pro', isDefault: false,
        defaultReasoningEffort: 'high', supportedReasoningEfforts: [...DEEPSEEK_EFFORTS], serviceTiers: []
    }))];
}

export function deepseekThreadConfig(params: Record<string, unknown>): Record<string, unknown> {
    if (!isDeepSeekModel(typeof params.model === 'string' ? params.model : null) && params.modelProvider !== DEEPSEEK_PROVIDER) return params;
    if (!isDeepSeekModel(typeof params.model === 'string' ? params.model : null)) throw new Error('Unknown DeepSeek model');
    return { ...params, modelProvider: DEEPSEEK_PROVIDER, serviceTier: null,
        developerInstructions: `${typeof params.developerInstructions === 'string' ? params.developerInstructions : ''}\n\n你是由 DeepSeek 提供的编程助手。用户已在 HAPI 手动选择此模型独立执行当前任务，沿用既有授权、历史与停止条件。默认简体中文。不要将此选择解释成 MiniMax 自动接管，不要调用 deepseek MCP 递归委派自己。`,
        config: { ...record(params.config), model_reasoning_effort: validateDeepSeekEffort(record(params.config).model_reasoning_effort),
            web_search: 'disabled', 'mcp_servers.deepseek': { enabled: false } } };
}

export function extendDeepSeekCatalog(effective: string, official: string): string {
    const current = JSON.parse(effective), source = JSON.parse(official);
    if (!Array.isArray(current.models) || !Array.isArray(source.models)) throw new Error('Invalid DeepSeek model catalog');
    const additions = DEEPSEEK_MODELS.map(slug => {
        const model = source.models.find((m: Record<string, unknown>) => m.slug === slug);
        if (!model || !Array.isArray(model.supported_reasoning_levels)
            || JSON.stringify(model.supported_reasoning_levels.map((x: { effort: string }) => x.effort)) !== JSON.stringify(DEEPSEEK_EFFORTS)) {
            throw new Error('DeepSeek official model descriptor unavailable');
        }
        return model;
    });
    return JSON.stringify({ ...current, models: [...current.models.filter((m: { slug: string }) => !isDeepSeekModel(m.slug)), ...additions] });
}

export async function prepareDeepSeekCatalog(command: CodexCommand, args: string[], cwd: string,
    env: NodeJS.ProcessEnv, directory: string): Promise<string[]> {
    const effective = await new Promise<string>((resolve, reject) => {
        execFile(command.command, [...command.args, 'debug', 'models', ...args.filter(arg => arg !== '--strict-config')],
            { cwd, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
            (error, stdout) => error ? reject(new Error('Cannot resolve native model catalog')) : resolve(stdout));
    });
    const path = join(directory, 'deepseek-model-catalog.json');
    await writeFile(path, extendDeepSeekCatalog(effective, await readFile(catalogPath(), 'utf8')), { flag: 'wx', mode: 0o600 });
    return ['-c', `model_catalog_json=${JSON.stringify(path)}`];
}
