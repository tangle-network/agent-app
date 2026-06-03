import type { JsonRecord } from './stream-normalizer'

export interface PersistedChatMessageForTurn {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  parts: Array<Record<string, unknown>> | null
}

export interface ResolvedChatTurn {
  turnIndex: number
  shouldInsertUserMessage: boolean
  priorMessages: PersistedChatMessageForTurn[]
  userParts: JsonRecord[]
}

export function normalizeClientTurnId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('turnId must be a string')
  const trimmed = value.trim()
  if (!trimmed) throw new Error('turnId must not be blank')
  if (trimmed.length > 160) throw new Error('turnId is too long')
  if (!/^[A-Za-z0-9:_-]+$/.test(trimmed)) {
    throw new Error('turnId contains unsupported characters')
  }
  return trimmed
}

export function buildUserTextParts(text: string, turnId: string | undefined): JsonRecord[] {
  const part: JsonRecord = { type: 'text', text }
  if (turnId) part.turnId = turnId
  return [part]
}

export function messageHasTurnId(message: PersistedChatMessageForTurn, turnId: string): boolean {
  for (const part of message.parts ?? []) {
    if (part && typeof part === 'object' && String(part.turnId ?? '') === turnId) {
      return true
    }
  }
  return false
}

export function resolveChatTurn(input: {
  existingMessages: PersistedChatMessageForTurn[]
  userContent: string
  turnId?: string
}): ResolvedChatTurn {
  const { existingMessages, userContent, turnId } = input
  const reusableIndex = findReusableUserMessageIndex(existingMessages, userContent, turnId)
  if (reusableIndex >= 0) {
    return {
      turnIndex: countUserMessages(existingMessages.slice(0, reusableIndex)),
      shouldInsertUserMessage: false,
      priorMessages: existingMessages.slice(0, reusableIndex),
      userParts: buildUserTextParts(userContent, turnId),
    }
  }

  return {
    turnIndex: countUserMessages(existingMessages),
    shouldInsertUserMessage: true,
    priorMessages: existingMessages,
    userParts: buildUserTextParts(userContent, turnId),
  }
}

function findReusableUserMessageIndex(
  messages: PersistedChatMessageForTurn[],
  userContent: string,
  turnId: string | undefined,
): number {
  if (turnId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role === 'user' && messageHasTurnId(message, turnId)) return index
    }
  }

  const latest = messages.at(-1)
  if (latest?.role === 'user' && latest.content === userContent) {
    return messages.length - 1
  }

  return -1
}

function countUserMessages(messages: PersistedChatMessageForTurn[]): number {
  return messages.filter((message) => message.role === 'user').length
}
