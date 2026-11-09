import type { Session } from '@/types/api'
import { isMiniMaxModel, isDeepSeekModel } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'

export function ModelRoutingStatus({ session }: { session: Session }) {
    const { t } = useTranslation()
    const route = session.metadata?.modelRouting
    if (!route && !isMiniMaxModel(session.model) && !isDeepSeekModel(session.model)) {
        return session.active && session.metadata?.hybridModel && !session.metadata.capabilities?.minimaxStandalone
            ? <span className="min-w-0 truncate text-xs text-[var(--app-hint)]" title={t('modelRouting.upgrade')}>{t('modelRouting.upgrade')}</span> : null
    }
    const failed = route?.status === 'failed'
    const key = failed ? 'modelRouting.failed'
        : route?.status === 'switching' ? 'modelRouting.switching'
            : route?.provider === 'minimax' && route.reason === 'usage-limit' ? 'modelRouting.takeover'
                : isDeepSeekModel(session.model) || route?.provider === 'deepseek' ? 'modelRouting.deepseek'
                    : isMiniMaxModel(session.model) || route?.provider === 'minimax' ? 'modelRouting.standalone' : null
    if (!key) return null
    const approvalsHint = !failed && route?.status !== 'switching'
        && (route?.provider === 'minimax' || isMiniMaxModel(session.model))
        ? t('modelRouting.approvals') : undefined
    return <span role={failed ? 'alert' : 'status'} aria-live="polite" title={approvalsHint ?? t(key)}
        className={`min-w-0 max-w-full truncate rounded px-2 py-1 text-xs ${failed ? 'bg-amber-500/15 text-amber-600' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'}`}>
        {t(key)}
    </span>
}
