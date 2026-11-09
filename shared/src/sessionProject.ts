import { z } from 'zod'

// 共享会话项目契约（纯模块，无副作用）：
// - 只描述项目绑定的协议字段与继承规则，不访问文件系统、不读环境变量、不依赖当前 cwd。
// - directory 按字面保存：不做 normalize/resolve，也不改写成现有总控 cwd；
//   跨平台相对路径是否可用由机器创建入口检查，不在这个纯契约模块调用 OS。
// - 不引入模型、沙箱、审批、MiniMax 开关、工具桥或布尔权限标志。
// - controllerSessionId 只是指向总控真实 HAPI ID 的关联引用，绝不是子会话身份。
// - createdFromSessionId 记录普通新建的直接来源会话，不替换 forkedFrom。
// - 平台 role 只是业务分工，本模块不提供任何安全隔离。

// 首字符必须是字母数字，其余允许 . _ -；总长度 1..64 由 min/max 单独约束。
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const SessionProjectSchema = z.object({
    id: z.string().trim().min(1).max(64).regex(PROJECT_ID_PATTERN),
    name: z.string().trim().min(1).max(160),
    directory: z
        .string()
        .min(1)
        .max(4096)
        .refine((value) => !value.includes('\u0000'), { message: 'directory 不能包含 NUL' }),
    controllerSessionId: z.string().min(1).max(128),
    role: z.enum(['controller', 'research', 'development']),
    createdFromSessionId: z.string().min(1).max(128).optional(),
})

export type SessionProject = z.infer<typeof SessionProjectSchema>

/**
 * 会话新建时的项目绑定继承。
 *
 * - 无绑定（undefined）时返回 undefined：不凭空创造项目，无绑定会话行为保持不变。
 * - 有绑定时返回独立对象：保留 id/name/directory/controllerSessionId，
 *   role 重置为 research（不继承开发授权），createdFromSessionId 置为直接来源会话。
 * - 不修改入参，也不复制入参上可能存在的非契约键（权限/身份等字段）。
 */
export function inheritSessionProject(project: SessionProject | undefined, sourceSessionId: string): SessionProject | undefined {
    if (project === undefined) {
        return undefined
    }

    return {
        id: project.id,
        name: project.name,
        directory: project.directory,
        controllerSessionId: project.controllerSessionId,
        role: 'research',
        createdFromSessionId: sourceSessionId,
    }
}
