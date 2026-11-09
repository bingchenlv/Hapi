import { describe, expect, it } from 'bun:test'

import { inheritSessionProject, type SessionProject, SessionProjectSchema } from './sessionProject'

const controllerSessionId = 'hapi-7c1e9d40'

const controllerProject: SessionProject = {
    id: 'family-finance.2026',
    name: '家庭记账 · 归集',
    directory: '/home/ubuntu/workspace/family-finance',
    controllerSessionId,
    role: 'controller',
}

const CONTRACT_KEYS = ['controllerSessionId', 'createdFromSessionId', 'directory', 'id', 'name', 'role']

const successOf = (payload: Record<string, unknown>): boolean => SessionProjectSchema.safeParse(payload).success

// createdFromSessionId 是可选字段，缺失时它在解析结果里是否出现由 zod 版本决定，
// 因此“不得出现契约外字段”只断言多余键为空，不断言可选键一定缺席。
const extraKeysOf = (value: object): string[] =>
    Object.keys(value)
        .filter((key) => !CONTRACT_KEYS.includes(key))
        .sort()

describe('SessionProjectSchema 协议边界', () => {
    it('接受中文名称并只产出契约字段', () => {
        const parsed = SessionProjectSchema.parse(controllerProject)

        expect(parsed.name).toBe('家庭记账 · 归集')
        expect(parsed.role).toBe('controller')
        expect(extraKeysOf(parsed)).toEqual([])
        for (const key of ['controllerSessionId', 'directory', 'id', 'name', 'role']) {
            expect(Object.keys(parsed)).toContain(key)
        }
    })

    it('裁剪 id 与 name 的首尾空白', () => {
        const parsed = SessionProjectSchema.parse({ ...controllerProject, id: '  family-finance  ', name: '  家庭记账  ' })

        expect(parsed.id).toBe('family-finance')
        expect(parsed.name).toBe('家庭记账')
    })

    it('拒绝非法项目 id', () => {
        const rejected = ['', '   ', '-family', '_family', '.family', 'family finance', 'family/finance', '家计']

        expect(rejected.map((id) => successOf({ ...controllerProject, id }))).toEqual(rejected.map(() => false))
    })

    it('按长度上界接受或拒绝载荷', () => {
        const accepted: Record<string, unknown>[] = [
            { id: `a${'b'.repeat(63)}` },
            { name: 'n'.repeat(160) },
            { controllerSessionId: 's'.repeat(128) },
            { directory: 'd'.repeat(4096) },
        ]
        const rejected: Record<string, unknown>[] = [
            { id: `a${'b'.repeat(64)}` },
            { name: 'n'.repeat(161) },
            { controllerSessionId: 's'.repeat(129) },
            { directory: `${'d'.repeat(4096)}/` },
        ]

        expect(accepted.map((patch) => successOf({ ...controllerProject, ...patch }))).toEqual(accepted.map(() => true))
        expect(rejected.map((patch) => successOf({ ...controllerProject, ...patch }))).toEqual(rejected.map(() => false))
    })

    it('拒绝空字段、纯空白名称与异常 role', () => {
        const rejected: Record<string, unknown>[] = [
            { name: '' },
            { name: '   ' },
            { directory: '' },
            { controllerSessionId: '' },
            { createdFromSessionId: '' },
            { role: 'researcher' },
            { role: 'Research' },
            { role: 'controller ' },
            { role: undefined },
        ]

        expect(rejected.map((patch) => successOf({ ...controllerProject, ...patch }))).toEqual(rejected.map(() => false))
    })

    it('拒绝含 NUL 的目录并按字面保留路径', () => {
        expect(successOf({ ...controllerProject, directory: '/tmp/family\u0000finance' })).toBe(false)
        expect(successOf({ ...controllerProject, directory: '\u0000/tmp/family' })).toBe(false)

        const literal = './sessions/家庭 记账/../family/'
        expect(SessionProjectSchema.parse({ ...controllerProject, directory: literal }).directory).toBe(literal)
    })

    it('未知权限或身份字段不会变成契约字段', () => {
        const parsed = SessionProjectSchema.parse({
            ...controllerProject,
            createdFromSessionId: 'hapi-child-1',
            writeAuthorized: true,
            sandbox: 'off',
            approvalReviewer: 'lead',
            model: 'some-model',
            minimaxEnabled: true,
            toolBridge: 'root',
            forkedFrom: 'hapi-other',
            sessionId: controllerSessionId,
        })

        expect(Object.keys(parsed).sort()).toEqual([...CONTRACT_KEYS].sort())
        expect(parsed).not.toHaveProperty('writeAuthorized')
        expect(parsed).not.toHaveProperty('forkedFrom')
        expect(parsed.createdFromSessionId).toBe('hapi-child-1')
    })

    it('未知字段不能顶替必填契约字段', () => {
        expect(successOf({ writeAuthorized: false, role: 'controller', name: '家庭记账' })).toBe(false)
    })
})

describe('inheritSessionProject 继承规则', () => {
    it('无绑定时不创造项目', () => {
        expect(inheritSessionProject(undefined, 'hapi-child-1')).toBeUndefined()
    })

    it('两代继承保持项目与总控不变，只更新直接来源并重置研究职责', () => {
        const controllerSnapshot = { ...controllerProject }

        const generation1 = inheritSessionProject(controllerProject, 'hapi-child-1')
        const generation2 = inheritSessionProject(generation1, 'hapi-child-2')

        for (const derived of [generation1, generation2]) {
            expect(derived?.id).toBe(controllerProject.id)
            expect(derived?.name).toBe(controllerProject.name)
            expect(derived?.directory).toBe(controllerProject.directory)
            expect(derived?.controllerSessionId).toBe(controllerSessionId)
            expect(derived?.role).toBe('research')
        }

        expect(generation1?.createdFromSessionId).toBe('hapi-child-1')
        expect(generation2?.createdFromSessionId).toBe('hapi-child-2')
        expect(generation2).not.toBe(generation1)
        expect(generation2).not.toBe(controllerProject)
        expect(controllerProject).toEqual(controllerSnapshot)
        expect(controllerProject.role).toBe('controller')
    })

    it('派生项目不继承开发授权，也不引入契约外字段', () => {
        const developmentProject: SessionProject = {
            ...controllerProject,
            role: 'development',
            createdFromSessionId: 'hapi-lead',
        }

        const derived = inheritSessionProject(developmentProject, 'hapi-child-3')

        expect(derived?.role).toBe('research')
        expect(derived?.controllerSessionId).toBe(controllerSessionId)
        expect(Object.keys(derived ?? {}).sort()).toEqual([...CONTRACT_KEYS].sort())
        expect(SessionProjectSchema.safeParse(derived).success).toBe(true)
    })

    it('继承不复制调用方对象上的非契约键', () => {
        const looseProject = { ...controllerProject, writeAuthorized: true, model: 'some-model' }
        const snapshot = { ...looseProject }

        const derived = inheritSessionProject(looseProject, 'hapi-child-5')

        expect(extraKeysOf(derived ?? {})).toEqual([])
        expect(derived?.role).toBe('research')
        expect(derived?.createdFromSessionId).toBe('hapi-child-5')
        expect(looseProject).toEqual(snapshot)
    })

    it('不修改源会话项目及其角色与来源', () => {
        const developmentProject: SessionProject = {
            ...controllerProject,
            role: 'development',
            createdFromSessionId: 'hapi-lead',
        }
        const snapshot = { ...developmentProject }

        inheritSessionProject(developmentProject, 'hapi-child-4')

        expect(developmentProject).toEqual(snapshot)
        expect(developmentProject.role).toBe('development')
        expect(developmentProject.createdFromSessionId).toBe('hapi-lead')
    })
})
