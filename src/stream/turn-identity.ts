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
  /** The id of the user row this turn REUSES (retry dedup), when one was
   *  found. Absent on the insert path, where no row exists yet.
   *
   *  The reused row is deliberately EXCLUDED from `priorMessages` (it is this
   *  turn's own user message, not prior context), so this field is the only
   *  way a caller can name it. */
  reusedUserMessageId?: string
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
  /** True when the thread has a turn still RUNNING in the turn-event buffer
   *  (`turnStore.listRunning(threadId)`).
   *
   *  Without incremental persistence the trailing row of a thread mid-turn is
   *  always the user row, so the content fallback below could assume it. With
   *  incremental persistence the assistant row lands seconds into the turn, so
   *  a retry of that same turn finds an ASSISTANT row trailing and would
   *  insert a duplicate user row.
   *
   *  This flag is the discriminator that keeps both cases right, and it needs
   *  no new state: an assistant row trailing a turn that is still running is
   *  that turn's in-flight draft (walk past it — this is a retry), whereas an
   *  assistant row trailing a SETTLED turn is a completed answer (stop — the
   *  user genuinely repeated a message and deserves a new turn). */
  hasRunningTurn?: boolean
}): ResolvedChatTurn {
  const { existingMessages, userContent, turnId } = input
  const reusableIndex = findReusableUserMessageIndex(
    existingMessages,
    userContent,
    turnId,
    input.hasRunningTurn === true,
  )
  if (reusableIndex >= 0) {
    // Guarded read: `id` is typed `string`, but these rows come from a product
    // store the shell does not validate, so an adapter that omits it must
    // surface as "no id" rather than as the string "undefined".
    const reusedId = existingMessages[reusableIndex]?.id
    return {
      turnIndex: countUserMessages(existingMessages.slice(0, reusableIndex)),
      shouldInsertUserMessage: false,
      priorMessages: existingMessages.slice(0, reusableIndex),
      userParts: buildUserTextParts(userContent, turnId),
      ...(typeof reusedId === 'string' && reusedId ? { reusedUserMessageId: reusedId } : {}),
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
  hasRunningTurn: boolean,
): number {
  if (turnId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role === 'user' && messageHasTurnId(message, turnId)) return index
    }
    // A caller-supplied id is authoritative. A different id with identical
    // text is a deliberate new turn, while a transport retry reuses the same
    // id and takes the match above. Falling through to content dedup here lets
    // an unrelated abandoned running row swallow an intentional repeat.
    return -1
  }

  // Content fallback for a client that sends no turnId. Only the trailing rows
  // of a turn still RUNNING are walked past (they are that turn's incrementally
  // persisted assistant draft); a settled assistant row still ends the scan, so
  // a user who genuinely repeats a message gets a new turn exactly as before.
  let index = messages.length - 1
  if (hasRunningTurn) {
    while (index >= 0 && messages[index]?.role === 'assistant') index -= 1
  }
  const latest = index >= 0 ? messages[index] : undefined
  if (latest?.role === 'user' && latest.content === userContent) return index

  return -1
}

function countUserMessages(messages: PersistedChatMessageForTurn[]): number {
  return messages.filter((message) => message.role === 'user').length
}
