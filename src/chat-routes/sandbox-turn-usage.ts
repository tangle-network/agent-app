import { asRecord, type JsonRecord } from '../stream/index'
import type { ChatTurnUsage } from './turn-routes'

/** Every usage field a turn can record, in column order. */
export const TURN_USAGE_KEYS = [
  'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd', 'harnessCostUsd',
] as const

/** The usage fields a turn measured; unknown ones stay absent, never zero. */
export function measuredUsage(usage: ChatTurnUsage | undefined): ChatTurnUsage {
  const measured: ChatTurnUsage = {}
  for (const key of TURN_USAGE_KEYS) if (usage?.[key] !== undefined) measured[key] = usage[key]
  return measured
}

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
  if (Number.isFinite(cost)) usage.harnessCostUsd = (usage.harnessCostUsd ?? 0) + cost
}
