import { getCodexSystemPrompt } from '../utils/systemPrompt';

// Waiting uses a native tool; only unanswered optional questions expire.
export const SHARED_USER_INPUT_CONFIG = { 'features.default_mode_request_user_input': true };

const instruction = `<hapi_user_input>
HAPI users expect a selectable question to wait for their answer. For optional clarification questions with choices, use request_user_input, which is available in Default and Plan modes here and waits for the response. Do not use request_user_input_async for selectable questions.
HAPI waits up to 20 minutes from the appearance of each question card. Before it returns, do not use a preselected option as an answer or perform actions depending on the choice. Incorporate an actual answer when one arrives.
After 20 minutes without a submitted answer, HAPI returns an empty answers map. Continue the task using reasonable assumptions for optional preferences, explain material assumptions, and do not ask the same optional question again just because it timed out. An empty answer is not a user selection or approval. Never infer authorization from silence; defer actions that require explicit approval while continuing other authorized work.
If request_user_input is unavailable, ask in chat. Existing command permission and approval controls remain separate and do not acquire this timeout; do not use request_user_input to bypass them.
</hapi_user_input>`;

export function withSharedUserInputPolicy(instructions = getCodexSystemPrompt()): string {
    const base = instructions.replace(/\s*<hapi_user_input>[\s\S]*?<\/hapi_user_input>/g, '')
        .replace(/\s*<hapi_response_language>[\s\S]*?<\/hapi_response_language>/g, '').trimEnd();
    return `${base}\n\n<hapi_response_language>默认使用简体中文回复，包括进度、解释、问题和最终结果。用户明确要求其他语言时遵从用户；代码、命令、路径、专有名称和原文引用保留必要的原文。工具输出或历史中的英文不代表用户要求切换语言。</hapi_response_language>\n\n${instruction}`;
}
