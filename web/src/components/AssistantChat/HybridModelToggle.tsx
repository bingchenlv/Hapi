import type { MouseEvent } from 'react'

export type HybridModelToggleMode = 'openai' | 'hybrid'

export interface HybridModelToggleLabels {
    /** Accessible/visible name of the control, e.g. "混合模型". */
    label: string
    /** Confirmed text shown while mode === 'hybrid'. */
    on: string
    /** Confirmed text shown while mode === 'openai'. */
    off: string
    /** Text shown while a mode change is in flight. */
    pending: string
}

export interface HybridModelToggleProps {
    /** Last confirmed server state. Never updated optimistically by this component. */
    mode: HybridModelToggleMode
    /** A change request is in flight: show labels.pending and block clicks. */
    pending?: boolean
    /** Block clicks for any other reason (e.g. session not ready). */
    disabled?: boolean
    onChange: (next: HybridModelToggleMode) => void
    error?: string
    labels: HybridModelToggleLabels
}

/** Toggling always flips between the two known session modes. */
export function getNextHybridModelMode(mode: HybridModelToggleMode): HybridModelToggleMode {
    return mode === 'hybrid' ? 'openai' : 'hybrid'
}

/**
 * Pending text wins over the confirmed text, but the confirmed text is the only
 * thing rendered when idle: a not-yet-confirmed mode is never shown as applied.
 */
export function getHybridModelToggleStateText(
    mode: HybridModelToggleMode,
    pending: boolean,
    labels: HybridModelToggleLabels
): string {
    if (pending) return labels.pending
    return mode === 'hybrid' ? labels.on : labels.off
}

export function HybridModelToggle({
    mode,
    pending = false,
    disabled = false,
    onChange,
    error,
    labels
}: HybridModelToggleProps) {
    const isOn = mode === 'hybrid'
    const isBlocked = pending || disabled
    const stateText = getHybridModelToggleStateText(mode, pending, labels)
    const trackClassName = isOn ? 'bg-blue-500' : 'bg-[#999]'
    const knobClassName = isOn ? 'translate-x-3.5' : 'translate-x-0'

    function handleClick(_event: MouseEvent<HTMLButtonElement>) {
        // Guard even though the native disabled attribute already stops clicks,
        // so an in-flight or disabled toggle can never report a new mode.
        if (isBlocked) return
        onChange(getNextHybridModelMode(mode))
    }

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <button
                type="button"
                role="switch"
                aria-checked={isOn}
                aria-busy={pending || undefined}
                disabled={isBlocked}
                onClick={handleClick}
                className={[
                    'inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-[var(--app-hint)] px-2.5 py-1 text-left text-xs',
                    isBlocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                ].join(' ')}
            >
                <span className="min-w-0 truncate text-[var(--app-hint)]">{labels.label}</span>
                <span
                    aria-hidden="true"
                    className={`relative inline-flex h-3.5 w-7 shrink-0 items-center rounded-full transition-colors ${trackClassName}`}
                >
                    <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${knobClassName}`} />
                </span>
                <span className="min-w-0 truncate">{stateText}</span>
            </button>
            {error ? (
                <p role="alert" className="min-w-0 truncate text-xs text-red-500">{error}</p>
            ) : null}
        </div>
    )
}
