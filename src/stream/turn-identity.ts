import type { JsonRecord } from './stream-normalizer'

/** Define the structure of a chat message stored for a specific conversation turn */
export interface PersistedChatMessageForTurn {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  parts: Array<Record<string, unknown>> | null
}

/** Represent a chat turn with resolved user message insertion and prior message context */
export interface ResolvedChatTurn {
  turnIndex: number
  shouldInsertUserMessage: boolean
  priorMessages: PersistedChatMessageForTurn[]
  userParts: JsonRecord[]
}

/** Normalize and validate a client turn ID string ensuring it meets format and length requirements */
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

/** Build an array of text parts with optional turn ID for user input */
export function buildUserTextParts(text: string, turnId: string | undefined): JsonRecord[] {
  const part: JsonRecord = { type: 'text', text }
  if (turnId) part.turnId = turnId
  return [part]
}

/** Resolve whether a message contains any part with the specified turn ID */
export function messageHasTurnId(message: PersistedChatMessageForTurn, turnId: string): boolean {
  for (const part of message.parts ?? []) {
    if (part && typeof part === 'object' && String(part.turnId ?? '') === turnId) {
      return true
    }
  }
  return false
}

/** Resolve a chat turn by determining message reuse and constructing user message parts */
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
