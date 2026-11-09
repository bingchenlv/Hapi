import { createContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { en, zhCN } from './locales'
import { resolveLocale, type Locale } from './localePreference'

export type { Locale } from './localePreference'

export type Translations = Record<string, string>

export type I18nContextValue = {
  t: (key: string, params?: Record<string, string | number>) => string
  locale: Locale
  setLocale: (locale: Locale) => void
}

export const I18nContext = createContext<I18nContextValue | null>(null)

const locales: Record<Locale, Translations> = { en, 'zh-CN': zhCN }

function interpolate(str: string, params?: Record<string, string | number>): string {
  if (!params) return str
  return str.replace(/\{(\w+)\}/g, (match, key) => {
    const value = params[key]
    return value !== undefined ? String(value) : match
  })
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    let saved: string | null = null
    try { saved = localStorage.getItem('hapi-lang') } catch { /* Storage may be unavailable in private webviews. */ }
    return resolveLocale(saved, navigator.languages?.length ? navigator.languages : [navigator.language])
  })

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale)
    try { localStorage.setItem('hapi-lang', newLocale) } catch { /* The current page can still honor the choice. */ }
    document.documentElement.lang = newLocale
  }, [])

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    const dict = locales[locale] ?? locales.en
    const value = dict[key]
    const fallback = locales.en[key] ?? key
    return interpolate(value ?? fallback, params)
  }, [locale])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  return (
    <I18nContext.Provider value={{ t, locale, setLocale }}>
      {children}
    </I18nContext.Provider>
  )
}
