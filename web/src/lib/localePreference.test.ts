import { describe, expect, it } from 'vitest'
import { resolveLocale } from './localePreference'

describe('locale preference', () => {
    it('keeps an explicit saved choice ahead of browser detection', () => {
        expect(resolveLocale('en', ['zh-CN'])).toBe('en')
        expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN')
    })
    it('defaults to Chinese on a fresh origin for every browser locale', () => {
        for (const lang of ['zh', 'zh-CN', 'zh-TW', 'ZH-hans']) expect(resolveLocale(null, [lang])).toBe('zh-CN')
        expect(resolveLocale(null, ['en-US'])).toBe('zh-CN')
        expect(resolveLocale(null, ['en-US', 'zh-CN'])).toBe('zh-CN')
        expect(resolveLocale(null, ['en-GB', 'fr-FR'])).toBe('zh-CN')
        expect(resolveLocale(null, ['fr-FR', 'zh-CN'])).toBe('zh-CN')
        expect(resolveLocale('invalid', [])).toBe('zh-CN')
    })
})
