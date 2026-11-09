import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexModelSummary } from '@hapi/protocol/apiTypes';
import { isMiniMaxModel, MINIMAX_MODEL, isDeepSeekModel } from '@hapi/protocol';
import { DEEPSEEK_PROVIDER } from './deepseek';
import { record } from './gateway';

export { MINIMAX_MODEL };
export const MINIMAX_PROVIDER = 'hapi_minimax';
export const MINIMAX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export function validateMiniMaxEffort(value: unknown): string {
    const effort = value == null ? 'max' : typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!(MINIMAX_EFFORTS as readonly string[]).includes(effort)) {
        throw new Error('MiniMax supports only Low, Medium, High, XHigh and Max; choose a supported reasoning effort.');
    }
    return effort;
}
const authCommand = '/home/ubuntu/workspace/minimax-codex/native_auth.py';

/** Availability is local metadata only. Never put the credential in HAPI metadata or child environments. */
export function minimaxAvailable(): boolean {
    try {
        const directory = lstatSync(join(homedir(), '.config/minimax-codex'));
        const key = lstatSync(join(homedir(), '.config/minimax-codex/api-key'));
        return existsSync(authCommand) && directory.isDirectory() && key.isFile()
            && directory.uid === process.getuid?.() && key.uid === process.getuid?.()
            && (directory.mode & 0o077) === 0 && (key.mode & 0o077) === 0;
    } catch { return false; }
}

export function minimaxProviderConfig(reviewBaseUrl?: string): Record<string, unknown> {
    return {
        name: 'MiniMax', base_url: reviewBaseUrl ?? 'https://api.minimax.cn/v1', wire_api: 'responses',
        requires_openai_auth: Boolean(reviewBaseUrl), supports_websockets: false,
        request_max_retries: 0, stream_max_retries: 0,
        ...(reviewBaseUrl ? { env_http_headers: { 'X-Hapi-MiniMax-Router': 'HAPI_MINIMAX_TRANSPORT_TOKEN' } } : {}),
        ...(!reviewBaseUrl ? { auth: { command: '/usr/bin/python3', args: [authCommand], timeout_ms: 5_000, refresh_interval_ms: 0 } } : {})
    };
}

/** CLI -c values use TOML scalars; JSON objects are not TOML inline tables. */
export function minimaxServerArgs(config = minimaxProviderConfig()): string[] {
    const args: string[] = [];
    const visit = (prefix: string, values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) {
            if (value && typeof value === 'object' && !Array.isArray(value)) visit(`${prefix}.${key}`, record(value));
            else args.push('-c', `${prefix}.${key}=${JSON.stringify(value)}`);
        }
    };
    visit(`model_providers.${MINIMAX_PROVIDER}`, config);
    return args;
}

export function withMiniMaxModel(models: CodexModelSummary[]): CodexModelSummary[] {
    models = models.filter(model => !isMiniMaxModel(model.id) || model.id === MINIMAX_MODEL);
    if (!minimaxAvailable() || models.some(model => model.id === MINIMAX_MODEL)) return models;
    return [...models, { id: MINIMAX_MODEL, displayName: 'MiniMax M3.1 Flash', isDefault: false,
        defaultReasoningEffort: 'max', supportedReasoningEfforts: [...MINIMAX_EFFORTS] }];
}

export function providerForModel(model: string): string {
    return isMiniMaxModel(model) ? MINIMAX_PROVIDER : isDeepSeekModel(model) ? DEEPSEEK_PROVIDER : 'openai';
}

export function minimaxThreadConfig(params: Record<string, unknown>, reviewer: 'user' | 'auto_review' = 'auto_review', approvalPolicy: 'never' | 'on-request' = 'never', fullAuto = approvalPolicy === 'never' && params.sandbox !== 'read-only'): Record<string, unknown> {
    if (!isMiniMaxModel(typeof params.model === 'string' ? params.model : null) && params.modelProvider !== MINIMAX_PROVIDER) return params;
    return { ...params, model: MINIMAX_MODEL, modelProvider: MINIMAX_PROVIDER, serviceTier: null,
        // The private transport sends native reviewer calls only to OpenAI.
        approvalsReviewer: reviewer,
        approvalPolicy,
        ...(fullAuto ? { sandbox: 'danger-full-access' } : {}),
        developerInstructions: `${typeof params.developerInstructions === 'string' ? params.developerInstructions : ''}

[HAPI 独立 MiniMax 主控]
用户已选择 MiniMax 独立完成本会话任务，或授权其接管 OpenAI 额度耗尽后的工作。沿用任务、历史和已有授权直接继续。AGENTS.md 中 Astra/OpenAI 主控与 MiniMax helper 分工属于另一种混合协作方式；本模式不要求 OpenAI 主控。不要调用 minimax_helper 或递归委派自己。默认使用简体中文沟通；用户明确要求其他语言时遵从用户，工具和历史中的英文不构成切换语言的要求。

[执行权限]
${fullAuto
    ? '用户已明确授权全自动执行，不希望看到任何操作审批。本会话使用原生 never 审批策略及 Full Access，直接完成任务所需的读取、写入、联网、测试和维护，不再请求提权或操作确认，也不得把审批改成选择题或聊天确认。HAPI 对仍由工具单独发起的操作审批自动批准，无需 OpenAI 审阅。正常系统权限、凭据授权及主机资源 guard 仍有效；失败如实记录，不伪报成功。授权限于用户任务，不扩大任务范围，不发送未经请求的外部消息。'
    : approvalPolicy === 'never'
    ? '本会话禁止弹出人工审批。现有沙箱内、已获授权的读取、编辑、命令和测试直接执行；审批策略为 never。超出权限的操作直接停止该操作，简要用中文说明真实限制并继续不依赖它的工作。不得请求提权、改权限、改沙箱、开启人工审批，或用选择题/聊天确认重新索要操作批准。'
    : '保留用户明确选择的沙箱与审批设置。自动审阅由独立 OpenAI 审阅通道负责，不由 MiniMax 自审代替。审阅失败不代表批准；没有获准的操作不得执行或自动重放。'}

[独立执行与恢复]
复用已有结构、日志和成果，普通沙箱工作直接执行。临时文件使用独享目录，不清理猜测路径或共享目录。审批前取消的操作没有执行，不自动重放，不虚构清理。中断后先核对记录和真实状态；区分模型生成/压缩故障、沙箱错误、资源准入、明确拒绝与审阅服务故障。未知结果不得自动重放。保留检查点，不把静态检查当成真实行为验收，不让用户重复确认已授予的授权。`,
        config: { ...record(params.config), ...(fullAuto ? { sandbox_mode: 'danger-full-access', approval_policy: 'never' } : {}), 'mcp_servers.minimax_helper': {
            command: '/usr/bin/python3', args: ['/home/ubuntu/workspace/minimax-codex/worker.py', 'mcp'], enabled: false
        },
            model_reasoning_effort: validateMiniMaxEffort(record(params.config).model_reasoning_effort),
            model_context_window: 1_000_000, web_search: 'disabled' }
    };
}

/** Typed account exhaustion only. HTTP 429, rateLimitExceeded and free-form model text are not consent to switch. */
export function isCodexUsageExhaustion(error: unknown): boolean {
    return record(error).codexErrorInfo === 'usageLimitExceeded';
}

export function fallbackMessageId(turnId: string): string { return `hapi:minimax-fallback:${turnId}`; }
export const FALLBACK_CONTINUATION = 'OpenAI 的用量额度已耗尽，HAPI 已按本会话开启的 MiniMax 协作设置切换到 MiniMax。请继续用户尚未完成的任务，沿用本会话已有历史、文件、授权和权限。先核对已经完成的步骤与工具结果，从中断处继续，避免重复执行有副作用的操作；无需用户重新发送原任务。';
