import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
    HybridModelToggle,
    getNextHybridModelMode,
    getHybridModelToggleStateText
} from './HybridModelToggle'

const LABELS = {
    label: '混合模型',
    on: '已开启',
    off: '已关闭',
    pending: '切换中…'
}

describe('HybridModelToggle state helpers', () => {
    it('flips between the two session modes in both directions', () => {
        expect(getNextHybridModelMode('openai')).toBe('hybrid')
        expect(getNextHybridModelMode('hybrid')).toBe('openai')
    })

    it('only shows the confirmed text when idle and the pending text while in flight', () => {
        expect(getHybridModelToggleStateText('openai', false, LABELS)).toBe('已关闭')
        expect(getHybridModelToggleStateText('hybrid', false, LABELS)).toBe('已开启')
        expect(getHybridModelToggleStateText('openai', true, LABELS)).toBe('切换中…')
        expect(getHybridModelToggleStateText('hybrid', true, LABELS)).toBe('切换中…')
    })
})

describe('HybridModelToggle', () => {
    it('exposes an accessible switch name from the caller labels', () => {
        render(
            <HybridModelToggle
                mode="openai"
                onChange={vi.fn()}
                labels={LABELS}
            />
        )

        const toggle = screen.getByRole('switch', { name: /混合模型/ })
        expect(toggle).toHaveTextContent('混合模型')
        expect(toggle).toHaveTextContent('已关闭')
        expect(toggle).toHaveAttribute('aria-checked', 'false')
    })

    it('reports aria-checked from the confirmed mode prop', () => {
        const { rerender } = render(
            <HybridModelToggle mode="openai" onChange={vi.fn()} labels={LABELS} />
        )
        expect(screen.getByRole('switch', { name: /混合模型/ })).toHaveAttribute('aria-checked', 'false')

        rerender(<HybridModelToggle mode="hybrid" onChange={vi.fn()} labels={LABELS} />)
        const toggle = screen.getByRole('switch', { name: /混合模型/ })
        expect(toggle).toHaveAttribute('aria-checked', 'true')
        expect(toggle).toHaveTextContent('已开启')
    })

    it('requests hybrid when the confirmed mode is openai without flipping locally', () => {
        const onChange = vi.fn()
        render(<HybridModelToggle mode="openai" onChange={onChange} labels={LABELS} />)

        fireEvent.click(screen.getByRole('switch', { name: /混合模型/ }))

        expect(onChange).toHaveBeenCalledTimes(1)
        expect(onChange).toHaveBeenCalledWith('hybrid')
        // Controlled: the unconfirmed mode is never displayed as applied.
        expect(screen.getByRole('switch', { name: /混合模型/ })).toHaveAttribute('aria-checked', 'false')
    })

    it('requests openai when the confirmed mode is hybrid without flipping locally', () => {
        const onChange = vi.fn()
        render(<HybridModelToggle mode="hybrid" onChange={onChange} labels={LABELS} />)

        fireEvent.click(screen.getByRole('switch', { name: /混合模型/ }))

        expect(onChange).toHaveBeenCalledTimes(1)
        expect(onChange).toHaveBeenCalledWith('openai')
        expect(screen.getByRole('switch', { name: /混合模型/ })).toHaveAttribute('aria-checked', 'true')
    })

    it('follows the parent only after the new mode is confirmed', () => {
        const onChange = vi.fn()
        const { rerender } = render(
            <HybridModelToggle mode="openai" onChange={onChange} labels={LABELS} />
        )

        fireEvent.click(screen.getByRole('switch', { name: /混合模型/ }))
        expect(screen.getByRole('switch', { name: /混合模型/ })).toHaveAttribute('aria-checked', 'false')

        rerender(<HybridModelToggle mode="hybrid" onChange={onChange} labels={LABELS} />)
        expect(screen.getByRole('switch', { name: /混合模型/ })).toHaveAttribute('aria-checked', 'true')
    })

    it('blocks clicks while pending and shows the pending label', () => {
        const onChange = vi.fn()
        render(
            <HybridModelToggle
                mode="openai"
                pending
                onChange={onChange}
                labels={LABELS}
            />
        )

        const toggle = screen.getByRole('switch', { name: /混合模型/ })
        expect(toggle).toBeDisabled()
        expect(toggle).toHaveTextContent('切换中…')
        expect(toggle).not.toHaveTextContent('已开启')

        fireEvent.click(toggle)
        expect(onChange).not.toHaveBeenCalled()

        // The confirmed mode is still reported while the change is in flight.
        expect(toggle).toHaveAttribute('aria-checked', 'false')
    })

    it('blocks clicks when disabled and keeps the confirmed label', () => {
        const onChange = vi.fn()
        render(
            <HybridModelToggle
                mode="hybrid"
                disabled
                onChange={onChange}
                labels={LABELS}
            />
        )

        const toggle = screen.getByRole('switch', { name: /混合模型/ })
        expect(toggle).toBeDisabled()
        expect(toggle).toHaveTextContent('已开启')

        fireEvent.click(toggle)
        expect(onChange).not.toHaveBeenCalled()
    })

    it('renders an error through role=alert and nothing when absent', () => {
        const { rerender } = render(
            <HybridModelToggle
                mode="openai"
                onChange={vi.fn()}
                error="切换失败，请重试"
                labels={LABELS}
            />
        )

        const alert = screen.getByRole('alert')
        expect(alert).toHaveTextContent('切换失败，请重试')

        rerender(<HybridModelToggle mode="openai" onChange={vi.fn()} labels={LABELS} />)
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('keeps toggling possible again once pending clears', () => {
        const onChange = vi.fn()
        const { rerender } = render(
            <HybridModelToggle mode="openai" pending onChange={onChange} labels={LABELS} />
        )

        fireEvent.click(screen.getByRole('switch', { name: /混合模型/ }))
        expect(onChange).not.toHaveBeenCalled()

        rerender(<HybridModelToggle mode="openai" onChange={onChange} labels={LABELS} />)
        const toggle = screen.getByRole('switch', { name: /混合模型/ })
        expect(toggle).not.toBeDisabled()
        expect(toggle).toHaveTextContent('已关闭')

        fireEvent.click(toggle)
        expect(onChange).toHaveBeenCalledWith('hybrid')
    })
})
