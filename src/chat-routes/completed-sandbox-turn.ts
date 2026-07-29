/**
 * Recover a detached Sandbox turn from its durable completed records.
 *
 * A fast detached run can finish before the live event subscriber receives
 * every message-part event. The Sandbox still retains two exact records: a
 * turn-id keyed result cache and the completed assistant message on the
 * session. This adapter joins them without guessing across turns, then returns
 * the same `DetachedTurnFinal` shape `runDetachedTurn` already consumes.
 */

import type { SandboxInstance, SessionMessage } from '@tangle-network/sandbox'
import {
  asRecord,
  asString,
  collapseRedundantTextParts,
  finalizeAssistantParts,
  getPartKey,
  mergePersistedPart,
  normalizePersistedPart,
  type JsonRecord,
} from '../stream/index'
import { addStepFinishUsage } from './sandbox-turn-usage'
import type { DetachedTurnFinal } from './detached-turn'
import type { ChatTurnUsage } from './turn-routes'

/** The official Sandbox methods needed for completed-turn recovery. */
export type CompletedSandboxTurnSource = Pick<
  SandboxInstance,
  'findCompletedTurn' | 'session'
>

/** Options for resolving one exact detached turn. */
export interface ReadCompletedSandboxTurnOptions {
  turnId: string
  sessionId: string
  log?: (message: string, meta?: Record<string, unknown>) => void
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function firstNumber(record: JsonRecord | undefined, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(record?.[key])
    if (value !== undefined) return value
  }
  return undefined
}

function usageFromResult(result: JsonRecord | undefined): ChatTurnUsage {
  const raw = asRecord(result?.usage) ?? asRecord(result?.tokenUsage)
  const inputTokens = firstNumber(raw, ['inputTokens', 'promptTokens', 'input'])
  const outputTokens = firstNumber(raw, ['outputTokens', 'completionTokens', 'output'])
  const reasoningTokens = firstNumber(raw, ['reasoningTokens', 'reasoning'])
  const cacheReadTokens = firstNumber(raw, [
    'cacheReadTokens',
    'cacheReadInputTokens',
    'cacheRead',
  ])
  const cacheWriteTokens = firstNumber(raw, [
    'cacheWriteTokens',
    'cacheCreationInputTokens',
    'cacheWrite',
  ])
  const costUsd = firstNumber(result, ['costUsd', 'totalCostUsd', 'cost'])
    ?? firstNumber(raw, ['costUsd', 'cost'])

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  }
}

function textFromResult(result: JsonRecord | undefined): string | undefined {
  return asString(result?.response)
    ?? asString(result?.finalText)
    ?? asString(result?.text)
    ?? asString(result?.output)
}

function completedMessagesForTurn(
  messages: SessionMessage[],
  turnId: string,
): SessionMessage[] {
  return messages.filter((message) =>
    message.role === 'assistant'
    && message.metadata?.turnId === turnId
    && message.metadata?.interrupted !== true
    && (
      message.metadata?.completed === true
      || message.metadata?.status === 'completed'
    ),
  )
}

function normalizedMessageParts(
  message: SessionMessage,
): { parts: JsonRecord[]; usage: ChatTurnUsage; derivedText: string } {
  const normalized: JsonRecord[] = []
  const usage: ChatTurnUsage = {}
  for (const raw of message.parts) {
    const record = asRecord(raw)
    if (!record) continue
    const part = normalizePersistedPart(record)
    if (!part) continue
    normalized.push(part)
    if (part.type === 'step-finish') addStepFinishUsage(part, usage)
  }

  const collapsed = collapseRedundantTextParts(normalized)
  const derivedText = collapsed
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('')
  return { parts: normalized, usage, derivedText }
}

function projectMessageParts(parts: JsonRecord[], finalText: string): JsonRecord[] {
  const order: string[] = []
  const map = new Map<string, JsonRecord>()
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!
    const type = String(part.type ?? '')
    // A session's aggregate message contains every step receipt. Preserve each
    // occurrence just as the live producer does; other kinds merge by their
    // canonical identity.
    const key = type === 'step-start' || type === 'step-finish'
      ? `${type}:#${index}`
      : getPartKey(part)
    if (!map.has(key)) order.push(key)
    map.set(key, mergePersistedPart(map.get(key), part))
  }
  return finalizeAssistantParts(order, map, finalText)
}

function hasUsage(usage: ChatTurnUsage): boolean {
  return Object.values(usage).some((value) =>
    typeof value === 'number' && Number.isFinite(value),
  )
}

/**
 * Read the exact completed turn. The session-level result is consulted only
 * when the matching completed assistant message is still the latest message;
 * otherwise that result could belong to a newer turn on the same session.
 */
export async function readCompletedSandboxTurn(
  box: CompletedSandboxTurnSource,
  options: ReadCompletedSandboxTurnOptions,
): Promise<DetachedTurnFinal | null> {
  const { turnId, sessionId, log } = options
  const session = box.session(sessionId)
  const [cacheOutcome, messagesOutcome] = await Promise.allSettled([
    box.findCompletedTurn(turnId, { sessionId }),
    session.messages({ limit: 1_000 }),
  ])

  if (cacheOutcome.status === 'rejected') {
    log?.('[chat-routes] completed Sandbox turn cache lookup failed', {
      turnId,
      sessionId,
      error: String(cacheOutcome.reason),
    })
  }
  if (messagesOutcome.status === 'rejected') {
    log?.('[chat-routes] completed Sandbox session message lookup failed', {
      turnId,
      sessionId,
      error: String(messagesOutcome.reason),
    })
  }

  const rawCached = cacheOutcome.status === 'fulfilled' ? cacheOutcome.value : null
  const cached = rawCached
    && rawCached.turnId === turnId
    && rawCached.sessionId === sessionId
      ? rawCached
      : null
  if (rawCached && !cached) {
    log?.('[chat-routes] ignored mismatched completed Sandbox turn cache record', {
      turnId,
      sessionId,
    })
  }

  const messages = messagesOutcome.status === 'fulfilled'
    ? messagesOutcome.value
    : []
  const matchingMessages = completedMessagesForTurn(messages, turnId)
  const matchingCount = matchingMessages.length
  const message = matchingCount === 1 ? matchingMessages[0]! : null
  if (matchingCount > 1) {
    log?.('[chat-routes] ignored ambiguous completed Sandbox session messages', {
      turnId,
      sessionId,
      matchingCount,
    })
  }

  if (!cached && !message) return null

  let result = cached ? asRecord(cached.result) : undefined
  const latestConversationMessage = messages
    .filter((candidate) => candidate.role === 'user' || candidate.role === 'assistant')
    .at(-1)
  if (!result && message && latestConversationMessage === message) {
    try {
      result = asRecord(await session.result())
    } catch (error) {
      log?.('[chat-routes] completed Sandbox session result lookup failed', {
        turnId,
        sessionId,
        error: String(error),
      })
    }
  }

  const recovered = message ? normalizedMessageParts(message) : null
  const text = textFromResult(result) ?? recovered?.derivedText
  const resultUsage = usageFromResult(result)
  const usage = { ...(recovered?.usage ?? {}), ...resultUsage }
  const resultParts = Array.isArray(result?.parts)
    ? result.parts
        .map((part) => asRecord(part))
        .filter((part): part is JsonRecord => Boolean(part))
        .map((part) => normalizePersistedPart(part))
        .filter((part): part is JsonRecord => Boolean(part))
    : null
  const sourceParts = recovered?.parts ?? resultParts
  const parts = sourceParts
    ? projectMessageParts(sourceParts, text ?? recovered?.derivedText ?? '')
    : undefined

  return {
    ...(text !== undefined ? { text } : {}),
    ...(hasUsage(usage) ? { usage } : {}),
    ...(parts ? { parts } : {}),
  }
}
