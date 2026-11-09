export type Locale = 'en' | 'zh-CN'

/** A saved choice wins. Otherwise Chinese is the product default: an English
 * browser locale must never silently switch the whole UI to English, which is
 * what the user reported as "the language suddenly became English". */
export function resolveLocale(saved: string | null, languages: readonly string[]): Locale {
    if (saved === 'en' || saved === 'zh-CN') return saved
    for (const language of languages) {
        if (/^zh(?:-|$)/i.test(language)) return 'zh-CN'
    }
    return 'zh-CN'
}
