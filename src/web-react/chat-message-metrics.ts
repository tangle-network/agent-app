import type { CatalogModel } from '../runtime/model-catalog'
import type { ChatMessageMetrics } from './chat-message-types'

/** "$0.0042" from token counts × catalogue per-token pricing; null when unknown. */
export function formatModelCost(msg: ChatMessageMetrics, models: CatalogModel[]): string | null {
  if (msg.promptTokens == null && msg.completionTokens == null) return null
  const pricing = models.find((m) => m.id === msg.modelUsed)?.pricing
  if (!pricing) return null
  const cost =
    (msg.promptTokens ?? 0) * Number(pricing.prompt ?? 0) +
    (msg.completionTokens ?? 0) * Number(pricing.completion ?? 0)
  if (!isFinite(cost) || cost <= 0) return null
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
}

/** "38 tok/s" from completion tokens over first-token→end duration; null when unknown. */
export function formatTokensPerSecond(msg: ChatMessageMetrics): string | null {
  if (msg.completionTokens == null || !msg.durationMs) return null
  return `${Math.round(msg.completionTokens / (msg.durationMs / 1000))} tok/s`
}
