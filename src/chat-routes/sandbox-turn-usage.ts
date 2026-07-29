import { asRecord, type JsonRecord } from '../stream/index'
import type { ChatTurnUsage } from './turn-routes'

/** Add one canonical Sandbox `step-finish` receipt to a turn total. */
export function addStepFinishUsage(part: JsonRecord, usage: ChatTurnUsage): void {
  const tokens = asRecord(part.tokens)
  if (tokens) {
    const cache = asRecord(tokens.cache)
    const add = (current: number | undefined, value: unknown): number | undefined => {
      const n = Number(value)
      if (!Number.isFinite(n)) return current
      return (current ?? 0) + n
    }
    usage.inputTokens = add(usage.inputTokens, tokens.input)
    usage.outputTokens = add(usage.outputTokens, tokens.output)
    usage.reasoningTokens = add(usage.reasoningTokens, tokens.reasoning)
    if (cache) {
      usage.cacheReadTokens = add(usage.cacheReadTokens, cache.read)
      usage.cacheWriteTokens = add(usage.cacheWriteTokens, cache.write)
    }
  }
  const cost = Number(part.cost)
  if (Number.isFinite(cost)) usage.costUsd = (usage.costUsd ?? 0) + cost
}
