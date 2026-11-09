import type { CodexRateLimits, CodexRateLimitWindow } from '@hapi/protocol/types'
import * as Popover from '@radix-ui/react-popover'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/lib/use-translation'

const FIVE_HOURS_MINS = 5 * 60
const WEEK_MINS = 7 * 24 * 60

function clampPercent(value: number): number {
    return Math.min(100, Math.max(0, value))
}

export function formatRateLimitPercent(value: number): string {
    const clamped = clampPercent(value)
    return `${clamped < 10 ? Math.round(clamped * 10) / 10 : Math.round(clamped)}%`
}

export function getRateLimitTone(windows: CodexRateLimitWindow[]): string {
    const highest = Math.max(...windows.map(window => clampPercent(window.usedPercent)), 0)
    if (highest >= 90) return 'text-red-500'
    if (highest >= 70) return 'text-amber-500'
    return 'text-[var(--app-hint)]'
}

export function formatRateLimitWindowLabel(minutes: number, compact = false): string {
    if (minutes === FIVE_HOURS_MINS) return '5h'
    if (minutes === WEEK_MINS) return compact ? 'Wk' : 'Weekly'
    if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`
    if (minutes % 60 === 0) return `${minutes / 60}h`
    return `${minutes}m`
}

export function formatRateLimitUpdatedAt(updatedAt: number, now: number, locale: string): string {
    const elapsedMins = Math.max(0, Math.round((now - updatedAt) / 60_000))
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    if (elapsedMins < 90) return formatter.format(-elapsedMins, 'minute')
    const elapsedHours = Math.round(elapsedMins / 60)
    if (elapsedHours < 36) return formatter.format(-elapsedHours, 'hour')
    return formatter.format(-Math.round(elapsedHours / 24), 'day')
}

export function formatResetCountdown(resetAt: number | undefined, now: number): {
    expired: boolean
    value: string | null
} {
    if (!resetAt) return { expired: false, value: null }
    const remainingMins = Math.ceil((resetAt - now) / 60_000)
    if (remainingMins <= 0) return { expired: true, value: null }
    const days = Math.floor(remainingMins / (24 * 60))
    const hours = Math.floor((remainingMins % (24 * 60)) / 60)
    const minutes = remainingMins % 60
    if (days > 0) return { expired: false, value: hours > 0 ? `${days}d ${hours}h` : `${days}d` }
    if (hours > 0) return { expired: false, value: minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h` }
    return { expired: false, value: `${minutes}m` }
}

function windowEntries(rateLimits: CodexRateLimits): CodexRateLimitWindow[] {
    const windows = [rateLimits.primary, rateLimits.secondary]
        .filter((window): window is CodexRateLimitWindow => Boolean(window))
        .sort((left, right) => left.windowDurationMins - right.windowDurationMins)
    return windows.filter((window, index) => (
        index === 0 || window.windowDurationMins !== windows[index - 1]?.windowDurationMins
    ))
}

export function CodexRateLimitsIndicator(props: { rateLimits?: CodexRateLimits }) {
    const { t, locale } = useTranslation()
    const [now, setNow] = useState(Date.now)
    const windows = useMemo(
        () => props.rateLimits ? windowEntries(props.rateLimits) : [],
        [props.rateLimits]
    )

    useEffect(() => {
        if (windows.length === 0) return
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 60_000)
        return () => window.clearInterval(timer)
    }, [windows.length])

    if (!props.rateLimits || windows.length === 0) return null

    const tone = getRateLimitTone(windows)
    const compactLabel = windows
        .map(window => `${formatRateLimitWindowLabel(window.windowDurationMins, true)} ${formatRateLimitPercent(window.usedPercent)}`)
        .join(' · ')

    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    aria-label={t('misc.codexLimitsDetails')}
                    className={`min-w-0 cursor-pointer whitespace-nowrap rounded-sm bg-transparent p-0 text-[10px] leading-4 outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-link)] ${tone}`}
                >
                    <span className="sm:hidden">{compactLabel}</span>
                    <span className="hidden items-center gap-2 sm:inline-flex">
                        {windows.map(window => {
                            const label = formatRateLimitWindowLabel(window.windowDurationMins)
                            const percent = formatRateLimitPercent(window.usedPercent)
                            return (
                                <span key={window.windowDurationMins} className="inline-flex items-center gap-1">
                                    <span
                                        role="progressbar"
                                        aria-label={t('misc.codexLimitUsage', { window: label, percent })}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={Math.round(clampPercent(window.usedPercent))}
                                        className="h-1 w-7 shrink-0 overflow-hidden rounded-full bg-[var(--app-link-muted)]"
                                    >
                                        <span
                                            className="block h-full rounded-full bg-current"
                                            style={{ width: `${clampPercent(window.usedPercent)}%` }}
                                        />
                                    </span>
                                    <span>{label} {percent}</span>
                                </span>
                            )
                        })}
                    </span>
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    side="top"
                    align="start"
                    sideOffset={6}
                    collisionPadding={8}
                    className="z-50 w-[min(19rem,calc(100vw-1rem))] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-lg"
                >
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <span className="text-xs font-medium text-[var(--app-fg)]">{t('misc.codexLimits')}</span>
                        {props.rateLimits.planType ? (
                            <span className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--app-hint)]">
                                {props.rateLimits.planType}
                            </span>
                        ) : null}
                    </div>
                    <div className="flex flex-col gap-3">
                        {windows.map(window => {
                            const label = formatRateLimitWindowLabel(window.windowDurationMins)
                            const percent = formatRateLimitPercent(window.usedPercent)
                            const reset = formatResetCountdown(window.resetsAt, now)
                            const exactReset = window.resetsAt
                                ? new Intl.DateTimeFormat(locale, {
                                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                                }).format(new Date(window.resetsAt))
                                : null
                            return (
                                <div key={window.windowDurationMins} className="flex flex-col gap-1.5">
                                    <div className="flex items-baseline justify-between gap-3 text-xs">
                                        <span className="font-medium text-[var(--app-fg)]">{label}</span>
                                        <span className={getRateLimitTone([window])}>
                                            {t('misc.codexLimitUsed', { percent })}
                                        </span>
                                    </div>
                                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--app-link-muted)]">
                                        <div
                                            className={`h-full rounded-full bg-current ${getRateLimitTone([window])}`}
                                            style={{ width: `${clampPercent(window.usedPercent)}%` }}
                                        />
                                    </div>
                                    {reset.expired ? (
                                        <span className="text-[10px] text-[var(--app-hint)]">{t('misc.codexLimitRefreshPending')}</span>
                                    ) : reset.value ? (
                                        <span className="text-[10px] text-[var(--app-hint)]" title={exactReset ?? undefined}>
                                            {t('misc.codexLimitResetsIn', { value: reset.value })}{exactReset ? ` · ${exactReset}` : ''}
                                        </span>
                                    ) : null}
                                </div>
                            )
                        })}
                    </div>
                    <div className="mt-3 border-t border-[var(--app-border)] pt-2 text-[10px] text-[var(--app-hint)]">
                        {t('misc.codexLimitUpdated', {
                            value: formatRateLimitUpdatedAt(props.rateLimits.updatedAt, now, locale)
                        })}
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
