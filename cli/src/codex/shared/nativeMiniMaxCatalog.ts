import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodexCommand } from '../utils/codexExecutable';
import { MINIMAX_MODEL, MINIMAX_EFFORTS } from './minimax';

type Catalog = { models: Array<Record<string, unknown>>; [key: string]: unknown };
function parseCatalog(value: string): Catalog {
    let data: any;
    try { data = JSON.parse(value); }
    catch { throw new Error('Invalid native model catalog'); }
    if (!data || !Array.isArray(data.models) || !data.models.length
        || data.models.some((model: unknown) => !model || typeof model !== 'object'
            || Array.isArray(model) || typeof (model as Record<string, unknown>).slug !== 'string')) {
        throw new Error('Invalid native model catalog');
    }
    return data;
}

/** Preserve every effective native/custom descriptor. Use the native generic
 * agent template only for MiniMax, never a GPT-specific code-mode template.
 * An explicitly configured MiniMax descriptor remains authoritative.
 */
export function extendMiniMaxCatalog(effective: string, bundled: string): string {
    const current = parseCatalog(effective);
    if (current.models.some(model => model.slug === MINIMAX_MODEL)) return JSON.stringify(current);
    const template = parseCatalog(bundled).models.find(model => model.slug === 'gpt-5.5');
    if (!template || typeof template.base_instructions !== 'string') throw new Error('Native generic agent model template unavailable');
    const mini = { ...template,
        slug: MINIMAX_MODEL, display_name: 'MiniMax M3.1 Flash', description: 'MiniMax independent coding agent',
        default_reasoning_level: 'max',
        supported_reasoning_levels: MINIMAX_EFFORTS.map(effort => ({ effort, description: effort })),
        context_window: 1_000_000, max_context_window: 1_000_000,
        effective_context_window_percent: 95,
        // This is a native prompt compatibility hash, not a provider/model ID.
        // MiniMax has no Codex-issued hash; inheriting GPT-5.5's hash would
        // spuriously compact even tiny histories on every provider round trip.
        comp_hash: null,
        additional_speed_tiers: [], service_tiers: [], available_access_programs: { cyber: [] },
        availability_nux: null, upgrade: null, model_messages: null,
        experimental_supported_tools: [], supports_search_tool: false, use_responses_lite: false,
        support_verbosity: false, supports_reasoning_effort_updates: true,
        // Keep the installed native agent's generic operating instructions,
        // without asserting GPT identity or its provider-specific features.
        base_instructions: template.base_instructions.replace(/^You are Codex[^\n]*/, 'You are a coding assistant powered by MiniMax.')
    };
    return JSON.stringify({ ...current, models: [...current.models, mini] });
}

/** Catalog selection is startup-only in native Codex. A thread/fork config
 * cannot register a model. Ask the same executable to resolve its effective
 * catalog/config, then pass a private process-local overlay to app-server.
 * No global config/cache is edited. Never log catalog contents or stderr.
 */
export async function prepareMiniMaxCatalog(command: CodexCommand, args: string[], cwd: string,
    env: NodeJS.ProcessEnv, directory: string): Promise<string[]> {
    const load = (extra: string[]) => new Promise<string>((resolve, reject) => {
        execFile(command.command, [...command.args, 'debug', 'models', ...args.filter(arg => arg !== '--strict-config'), ...extra],
            { cwd, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
                if (error) reject(new Error('Cannot resolve native MiniMax model catalog; no model request was made.'));
                else resolve(stdout);
            });
    });
    const effective = await load([]);
    const bundled = parseCatalog(effective).models.some(model => model.slug === MINIMAX_MODEL) ? effective : await load(['--bundled']);
    const path = join(directory, 'minimax-model-catalog.json');
    await writeFile(path, extendMiniMaxCatalog(effective, bundled), { flag: 'wx', mode: 0o600 });
    return ['-c', `model_catalog_json=${JSON.stringify(path)}`];
}
