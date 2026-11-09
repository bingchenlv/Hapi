import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Session, SessionResponse } from '@/types/api'
import { isMiniMaxModel, isDeepSeekModel } from '@hapi/protocol'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'
import { HybridModelToggle } from './HybridModelToggle'
import { ModelRoutingStatus } from './ModelRoutingStatus'

function HelperSwitch({ api, session, provider }: { api: ApiClient | null; session: Session; provider: 'minimax' | 'deepseek' }) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const field = provider === 'minimax' ? 'hybridModel' : 'deepseekCollaboration'
    const state = session.metadata?.[field]
    const mutation = useMutation({
        mutationFn: async (mode: 'openai' | 'hybrid') => {
            if (!api) throw new Error(t('hybrid.unavailable'))
            const result = await (provider === 'minimax' ? api.setHybridModel(session.id, mode) : api.setDeepSeekCollaboration(session.id, mode))
            if (result.mode !== mode) throw new Error(t('hybrid.unconfirmed'))
            return result
        },
        onSuccess: (result) => {
            queryClient.setQueryData<SessionResponse>(queryKeys.session(session.id), previous => {
                if (!previous?.session.metadata) return previous
                return { ...previous, session: { ...previous.session,
                    metadata: { ...previous.session.metadata, [field]: result } } }
            })
            void queryClient.invalidateQueries({ queryKey: queryKeys.session(session.id) })
        }
    })
    if (!state) return null
    return <HybridModelToggle
        mode={state.mode}
        pending={mutation.isPending}
        disabled={!api || !session.active}
        onChange={mode => mutation.mutate(mode)}
        error={mutation.error?.message}
        labels={{ label: provider === 'minimax' ? 'MiniMax' : 'DeepSeek', on: t('hybrid.on'), off: t('hybrid.off'), pending: t('hybrid.pending') }}
    />
}

export function SessionHybridModelToggle({ api, session }: { api: ApiClient | null; session: Session }) {
    const { t } = useTranslation()
    if (session.metadata?.flavor !== 'codex') return null
    const minimaxState = session.metadata.hybridModel
    const deepseekState = session.metadata.capabilities?.deepseekCollaboration === true
        ? session.metadata.deepseekCollaboration : undefined
    const route = session.metadata.modelRouting
    const unconfirmed = route && route.status !== 'active'
    const standalone = isMiniMaxModel(session.model) || isDeepSeekModel(session.model)
        || route?.provider === 'minimax' || route?.provider === 'deepseek'
    return (
        <div className="mx-auto flex w-full max-w-content flex-wrap items-center gap-2 px-3 pt-1 pb-1" title={t(deepseekState ? 'hybrid.helpBoth' : 'hybrid.help')}>
            <ModelRoutingStatus session={session} />
            {(minimaxState || deepseekState) && (standalone || unconfirmed)
                ? <span role="status" className="min-w-0 truncate text-xs text-[var(--app-hint)]">
                    {t(unconfirmed ? 'hybrid.routePending' : 'hybrid.standalone')}
                </span>
                : <>
                    {minimaxState && <HelperSwitch key={`${session.id}-minimax`} api={api} session={session} provider="minimax" />}
                    {deepseekState && <HelperSwitch key={`${session.id}-deepseek`} api={api} session={session} provider="deepseek" />}
                    {!minimaxState && !deepseekState && <span className="min-w-0 truncate text-xs text-[var(--app-hint)]" title={t('hybrid.unavailable')}>{t('hybrid.unavailable')}</span>}
                </>}
        </div>
    )
}
