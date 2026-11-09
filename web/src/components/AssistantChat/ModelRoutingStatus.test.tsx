import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@/types/api'
import { ModelRoutingStatus } from './ModelRoutingStatus'
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('model routing indicator', () => {
    it('labels a manually selected DeepSeek model independently of MiniMax takeover', () => {
        render(<ModelRoutingStatus session={session({provider:'deepseek',reason:'manual',status:'active'},'deepseek-v4-pro')} />)
        expect(screen.getByRole('status')).toHaveTextContent('modelRouting.deepseek')
        expect(screen.queryByText('modelRouting.takeover')).toBeNull()
    })
    const session = (route?: Record<string, unknown>, model = 'gpt-6-astra') => ({ model,
        metadata: { modelRouting: route } }) as unknown as Session
    it('distinguishes a confirmed quota takeover from manual selection', () => {
        const view = render(<ModelRoutingStatus session={session({ provider: 'minimax', reason: 'usage-limit', status: 'active' })} />)
        expect(screen.getByRole('status')).toHaveTextContent('modelRouting.takeover')
        expect(screen.getByRole('status')).toHaveAttribute('title', 'modelRouting.approvals')
        view.rerender(<ModelRoutingStatus session={session({ provider: 'minimax', reason: 'manual', status: 'active' })} />)
        expect(screen.getByRole('status')).toHaveTextContent('modelRouting.standalone')
    })
    it('does not report success while switching or when takeover is unconfirmed', () => {
        const view = render(<ModelRoutingStatus session={session({ provider: 'minimax', reason: 'usage-limit', status: 'switching' })} />)
        expect(screen.getByRole('status')).toHaveTextContent('modelRouting.switching')
        view.rerender(<ModelRoutingStatus session={session({ provider: 'minimax', reason: 'usage-limit', status: 'failed' })} />)
        expect(screen.getByRole('alert')).toHaveTextContent('modelRouting.failed')
    })
    it('hides for OpenAI and works for a directly created MiniMax session', () => {
        const view = render(<ModelRoutingStatus session={session()} />)
        expect(screen.queryByRole('status')).toBeNull()
        expect(screen.queryByText('modelRouting.approvals')).toBeNull()
        view.rerender(<ModelRoutingStatus session={session(undefined, 'MiniMax-M3.1-Flash-Preview')} />)
        expect(screen.getByRole('status')).toHaveTextContent('modelRouting.standalone')
    })
})
