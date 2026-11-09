import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'

vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { notification: vi.fn() } }) }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

import { PermissionFooter } from './PermissionFooter'

function fixture(disabled = false) {
    const approvePermission = vi.fn().mockResolvedValue(undefined)
    const tool: ChatToolCall = {
        id: 'exec', name: 'CodexBash', state: 'pending', input: { command: 'printf approval-check' },
        createdAt: 1, startedAt: null, completedAt: null, execStartedAt: null, execCompletedAt: null,
        description: null, permission: { id: 'permission', status: 'pending' }
    }
    render(<PermissionFooter api={{ approvePermission } as unknown as ApiClient} sessionId="minimax-session"
        metadata={{ path: '/test', host: 'test', flavor: 'codex', modelRouting: { provider: 'minimax', status: 'active', reason: 'manual' } } as SessionMetadataSummary}
        tool={tool} disabled={disabled} onDone={vi.fn()} />)
    return approvePermission
}

describe('MiniMax session approval', () => {
    it('shows session approval as an enabled action and submits it only after a click', async () => {
        const approvePermission = fixture()
        const button = screen.getByRole('button', { name: 'tool.yesForSession' })
        expect(button).toBeEnabled()
        expect(button).toHaveClass('text-[var(--app-badge-success-text)]')
        expect(approvePermission).not.toHaveBeenCalled()
        fireEvent.click(button)
        await waitFor(() => expect(approvePermission).toHaveBeenCalledExactlyOnceWith('minimax-session', 'permission',
            { decision: 'approved_for_session' }))
    })

    it('keeps one-time approval separate', async () => {
        const approvePermission = fixture()
        fireEvent.click(screen.getByRole('button', { name: 'tool.yes' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledExactlyOnceWith('minimax-session', 'permission',
            { decision: 'approved' }))
    })

    it('disables both actions while session controls are unavailable', () => {
        const approvePermission = fixture(true)
        expect(screen.getByRole('button', { name: 'tool.yesForSession' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'tool.yes' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'tool.yesForSession' }))
        expect(approvePermission).not.toHaveBeenCalled()
    })
})
