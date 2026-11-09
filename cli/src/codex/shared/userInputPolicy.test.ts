import { expect, it } from 'vitest';
import { withSharedUserInputPolicy } from './userInputPolicy';

it('keeps Chinese as the default without overriding an explicit language request or duplicating injected policies', () => {
    const policy = withSharedUserInputPolicy('Project instructions');
    expect(policy).toContain('默认使用简体中文');
    expect(policy).toContain('用户明确要求其他语言时遵从用户');
    expect(policy).toContain('工具输出或历史中的英文不代表用户要求切换语言');
    expect(withSharedUserInputPolicy(policy)).toBe(policy);
    expect(policy).toContain('Project instructions');
});
