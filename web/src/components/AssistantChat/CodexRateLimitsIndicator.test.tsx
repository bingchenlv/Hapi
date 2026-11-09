import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import {
    CodexRateLimitsIndicator,
    formatRateLimitPercent,
    formatRateLimitUpdatedAt,
    formatRateLimitWindowLabel,
    formatResetCountdown,
    getRateLimitTone
} from './CodexRateLimitsIndicator'

describe('Codex rate-limit formatting', () => {
    it('labels known and future window durations without guessing', () => {
        expect(formatRateLimitWindowLabel(300)).toBe('5h')
        expect(formatRateLimitWindowLabel(10_080)).toBe('Weekly')
        expect(formatRateLimitWindowLabel(10_080, true)).toBe('Wk')
        expect(formatRateLimitWindowLabel(2_880)).toBe('2d')
        expect(formatRateLimitWindowLabel(90)).toBe('90m')
    })

    it('keeps stale update ages readable instead of accumulating minutes', () => {
        expect(formatRateLimitUpdatedAt(1_000_000, 1_000_000, 'en')).toBe('this minute')
        expect(formatRateLimitUpdatedAt(1_000_000, 1_000_000 + 2 * 60 * 60_000, 'en')).toBe('2 hours ago')
        expect(formatRateLimitUpdatedAt(1_000_000, 1_000_000 + 3 * 24 * 60 * 60_000, 'en')).toBe('3 days ago')
    })

    it('formats and tones bounded usage consistently with the context bar', () => {
        expect(formatRateLimitPercent(4.44)).toBe('4.4%')
        expect(formatRateLimitPercent(42.4)).toBe('42%')
        expect(getRateLimitTone([{ usedPercent: 70, windowDurationMins: 300 }])).toBe('text-amber-500')
        expect(getRateLimitTone([{ usedPercent: 90, windowDurationMins: 300 }])).toBe('text-red-500')
    })

    it('uses a compact countdown and marks elapsed reset times', () => {
        expect(formatResetCountdown(1_000_000 + 90 * 60_000, 1_000_000)).toEqual({
            expired: false,
            value: '1h 30m'
        })
        expect(formatResetCountdown(999_999, 1_000_000)).toEqual({ expired: true, value: null })
    })
})

describe('CodexRateLimitsIndicator', () => {
    const now = 1_800_000_000_000

    beforeEach(() => {
        localStorage.clear()
        localStorage.setItem('hapi-lang', 'zh-CN')
        vi.spyOn(Date, 'now').mockReturnValue(now)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('shows both limits in the status bar and full localized details', async () => {
        render(
            <I18nProvider>
                <CodexRateLimitsIndicator rateLimits={{
                    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: now + 90 * 60_000 },
                    secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: now + 3 * 24 * 60 * 60_000 },
                    planType: 'plus',
                    updatedAt: now
                }} />
            </I18nProvider>
        )

        const trigger = screen.getByRole('button', { name: 'Codex 用量限额' })
        expect(trigger.textContent).toContain('5h 42% · Wk 18%')
        expect(trigger.textContent).toContain('Weekly 18%')
        expect(screen.getByRole('progressbar', { name: '5h 用量：42%' })).toHaveAttribute('aria-valuenow', '42')

        fireEvent.click(trigger)

        expect(await screen.findByText('Codex 用量限额')).toBeInTheDocument()
        expect(screen.getByText('plus')).toBeInTheDocument()
        expect(screen.getByText('已使用 42%')).toBeInTheDocument()
        expect(screen.getByText(/1h 30m 后重置/)).toBeInTheDocument()
        expect(screen.getByText('更新于此刻')).toBeInTheDocument()
    })

    it('renders nothing when the account exposes no rolling windows', () => {
        const { container } = render(
            <I18nProvider>
                <CodexRateLimitsIndicator rateLimits={{ planType: 'api', updatedAt: now }} />
            </I18nProvider>
        )
        expect(container).toBeEmptyDOMElement()
    })
})
