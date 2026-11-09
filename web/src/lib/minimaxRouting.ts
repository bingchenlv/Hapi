import type { CodexModelSummary } from '@/types/api'
import { isMiniMaxModel, isDeepSeekModel } from '@hapi/protocol'

/** Machine discovery can be newer than a still-running session. */
export function sessionModelCatalog(models: readonly CodexModelSummary[], standaloneSupported: boolean, deepseekSupported = false): CodexModelSummary[] {
    return models.filter(model => (!isMiniMaxModel(model.id) || standaloneSupported) && (!isDeepSeekModel(model.id) || deepseekSupported))
}
