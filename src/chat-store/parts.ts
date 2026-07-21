/**
 * The stored shape of `message.parts` — one typed vocabulary for every part a
 * product persists into a chat transcript. NOT an ad-hoc union reverse-
 * engineered from product schemas; each member is matched field-for-field to
 * its canonical source:
 *
 * - `text` / `reasoning` / `tool`: the persisted projection `/stream`'s
 *   `normalizePersistedPart` produces from the harness lane's
 *   `message.part.updated` events (ADC sidecar
 *   `apps/sidecar/src/events/session-events.ts:56` wraps the canonical part in
 *   an `{id, sessionID, messageID}` envelope; the projection strips the
 *   session/message ids and keeps the per-segment part id).
 * - `file` / `image` / `step-start` / `step-finish`: the sidecar's canonical
 *   `MessagePartSchema` members (ADC
 *   `apps/sidecar/src/schemas/agent-schemas.ts:50-154`); `step-finish` carries
 *   the harness's per-step usage receipt — tokens
 *   `{total, input, output, reasoning, cache{write, read}}` + `cost` — which is
 *   also the shape the message-level token/cost columns mirror.
 * - `subtask`: `@tangle-network/agent-interface`'s `SubtaskPart` (a spawned
 *   sub-agent task).
 * - `interaction` / `notice`: the persisted-part codecs in
 *   `/web-react`'s chat-interactions contract (`interactionToPersistedPart`,
 *   `noticePart`) — type-only imports, one source of truth for their statuses
 *   and field shapes.
 * - `plan`: the durable-plan projection in `/plans`, derived from the sandbox
 *   SDK's authoritative plan lifecycle.
 *
 * `@tangle-network/agent-interface` exports the canonical wire `Part` union,
 * but its `PartBase` requires the `sessionID`/`messageID` stream envelope that
 * is deliberately NOT persisted, so the stored union is defined here as the
 * envelope-free projection (a type-level coverage check against the peer's
 * `Part['type']` lives in the tests). Contribute-down candidate: if
 * agent-interface grows envelope-free persisted-part types, re-export them
 * here and delete these definitions.
 *
 * Two transport lanes serialize into this SAME stored shape:
 * - harness lane: canonical `message.part.updated` parts, merged/normalized by
 *   `/stream` (`mergePersistedPart`, `finalizeAssistantParts`);
 * - router/openai-compat lane: `text_delta`/`tool_call` stream events are
 *   mapped INTO canonical part events first (`/runtime`'s `toLoopEvents` +
 *   `/stream`'s `normalizeToolEvent`) and then persisted identically — the
 *   store never sees a router-specific shape.
 */

import type { Part as HarnessWirePart } from '@tangle-network/agent-interface'
import type {
  ChatInteractionField,
  ChatInteractionStatus,
  InteractionAnswers,
  InteractionPersistedPart,
  NoticeKind,
  NoticePersistedPart,
} from '../web-react/chat-interactions'
import { persistedPartToInteraction } from '../interactions/contract'
import {
  persistedPartToPlan,
  planToPersistedPart,
  type ChatPlanPersistedPart,
} from '../plans/index'

/** Start/end wall-clock millis, as normalized by `/stream`'s `normalizeTime`. */
export interface ChatPartTime {
  start?: number
  end?: number
}

/** `id` is the harness's per-segment identity; absent on legacy/router parts,
 *  which collapse to a single logical text stream. Never invented client-side. */
export interface ChatTextPart {
  type: 'text'
  text: string
  id?: string
}

export interface ChatReasoningPart {
  type: 'reasoning'
  text: string
  id?: string
  time?: ChatPartTime
}

/** Superset of the sidecar's status enum (`pending|running|completed|failed`)
 *  and agent-interface's `ToolState` statuses; `error` is the persisted
 *  terminal form `/stream`'s `normalizePersistedPart` settles on. */
export type ChatToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'failed'

export interface ChatToolState {
  status: ChatToolStatus
  input?: unknown
  output?: unknown
  error?: string
  title?: string
  metadata?: Record<string, unknown>
  time?: ChatPartTime
}

export interface ChatToolPart {
  type: 'tool'
  id: string
  tool: string
  callID?: string
  state: ChatToolState
}

/** Union of the sidecar's legacy (path-based) and AI-SDK (url-based) file
 *  shapes; response-side every field besides `type` is optional. */
export interface ChatFilePart {
  type: 'file'
  id?: string
  filename?: string
  mediaType?: string
  url?: string
  path?: string
  content?: string
}

export interface ChatImagePart {
  type: 'image'
  filename?: string
  mediaType?: string
  url?: string
  path?: string
}

export interface ChatSubtaskPart {
  type: 'subtask'
  prompt: string
  description: string
  agent: string
  id?: string
}

/** OpenCode step-boundary marker — no renderable text; preserved so mappers
 *  never coerce it into a "[object Object]" text part. */
export interface ChatStepStartPart {
  type: 'step-start'
}

/** Per-step usage receipt as the harness reports it (sidecar
 *  `StepFinishPartSchema`). The message-level token/cost columns are this
 *  shape flattened. */
export interface ChatUsageTokens {
  total?: number
  input?: number
  output?: number
  reasoning?: number
  cache?: {
    write?: number
    read?: number
  }
}

export interface ChatStepFinishPart {
  type: 'step-finish'
  reason?: string
  tokens?: ChatUsageTokens
  cost?: number
}

/** Persisted human-in-the-loop ask — byte-matches
 *  `interactionToPersistedPart` in `/web-react`'s chat-interactions contract. */
export interface ChatInteractionPart {
  type: 'interaction'
  id: string
  kind: string
  title: string
  body?: string
  answerSpec: { fields: ChatInteractionField[] }
  status: ChatInteractionStatus
  answers?: InteractionAnswers
  cancelReason?: string
}

export type ChatPlanPart = ChatPlanPersistedPart

/** Persisted one-line transcript notice — byte-matches `noticePart` in
 *  `/web-react`'s chat-interactions contract. */
export interface ChatNoticePart {
  type: 'notice'
  id: string
  noticeKind: NoticeKind
  text: string
}

// The "byte-matches" claims above, enforced at compile time: the interaction
// contract's codec output types and the stored part types must stay mutually
// assignable, so a codec field added on one side without the other fails here.
type MutuallyAssignable<A extends B, B> = A
type _CodecEmitsStorableInteractionPart = MutuallyAssignable<InteractionPersistedPart, ChatInteractionPart>
type _StoredInteractionPartFeedsCodec = MutuallyAssignable<ChatInteractionPart, InteractionPersistedPart>
type _CodecEmitsStorableNoticePart = MutuallyAssignable<NoticePersistedPart, ChatNoticePart>
type _StoredNoticePartFeedsCodec = MutuallyAssignable<ChatNoticePart, NoticePersistedPart>
type _CodecEmitsStorablePlanPart = MutuallyAssignable<ChatPlanPersistedPart, ChatPlanPart>
type _StoredPlanPartFeedsCodec = MutuallyAssignable<ChatPlanPart, ChatPlanPersistedPart>

export type ChatMessagePart =
  | ChatTextPart
  | ChatReasoningPart
  | ChatToolPart
  | ChatFilePart
  | ChatImagePart
  | ChatSubtaskPart
  | ChatStepStartPart
  | ChatStepFinishPart
  | ChatInteractionPart
  | ChatNoticePart
  | ChatPlanPart

/** Every canonical harness wire-part kind must be storable — compile-time
 *  guarantee that a new agent-interface part kind cannot silently fall out of
 *  the persisted vocabulary. */
export type StorableHarnessPartKind = HarnessWirePart['type'] & ChatMessagePart['type']

/**
 * The typed projection at the `/stream` → `/chat-store` boundary. The stream
 * normalizers (`normalizePersistedPart`/`mergePersistedPart`/
 * `finalizeAssistantParts`) deliberately produce untyped `JsonRecord`s — they
 * normalize wire shapes and do not own the stored vocabulary. THIS module
 * owns it, so this is where rows gain the `ChatMessagePart` type: each entry
 * is validated against its kind's required fields and narrowed, junk is
 * dropped, and — enforced by the exhaustiveness check below — no storable
 * kind can silently fall out (the step-finish/interaction trap).
 */
export function toChatMessageParts(parts: Array<Record<string, unknown>>): ChatMessagePart[] {
  const out: ChatMessagePart[] = []
  for (const part of parts) {
    const typed = toChatMessagePart(part)
    if (typed) out.push(typed)
  }
  return out
}

const str = (value: unknown): value is string => typeof value === 'string'

function toChatMessagePart(part: Record<string, unknown>): ChatMessagePart | null {
  if (!part || typeof part !== 'object') return null
  const type = part.type as ChatMessagePart['type'] | undefined
  switch (type) {
    case 'text':
    case 'reasoning':
      return str(part.text) ? (part as unknown as ChatTextPart | ChatReasoningPart) : null
    case 'tool':
      return str(part.id) && str(part.tool) && part.state && typeof part.state === 'object'
        ? (part as unknown as ChatToolPart)
        : null
    case 'file':
    case 'image':
      return part as unknown as ChatFilePart | ChatImagePart
    case 'subtask':
      return str(part.prompt) && str(part.description) && str(part.agent)
        ? (part as unknown as ChatSubtaskPart)
        : null
    case 'step-start':
      return { type: 'step-start' }
    case 'step-finish':
      return part as unknown as ChatStepFinishPart
    case 'interaction':
      return persistedPartToInteraction(part) ? (part as unknown as ChatInteractionPart) : null
    case 'notice':
      return str(part.id) && str(part.noticeKind) && str(part.text)
        ? (part as unknown as ChatNoticePart)
        : null
    case 'plan': {
      const plan = persistedPartToPlan(part)
      return plan ? ({ ...part, ...planToPersistedPart(plan) } as ChatPlanPart) : null
    }
    case undefined:
      return null
    default: {
      // Compile-time exhaustiveness: a new ChatMessagePart kind that is not
      // handled above makes `type` non-never here and this line fails.
      const _exhaustive: never = type
      void _exhaustive
      return null
    }
  }
}

export function isChatToolPart(part: ChatMessagePart): part is ChatToolPart {
  return part.type === 'tool'
}

export function isChatTextPart(part: ChatMessagePart): part is ChatTextPart {
  return part.type === 'text'
}

export function isChatInteractionPart(part: ChatMessagePart): part is ChatInteractionPart {
  return part.type === 'interaction'
}

export function isChatPlanPart(part: ChatMessagePart): part is ChatPlanPart {
  return part.type === 'plan'
}

export function isChatStepFinishPart(part: ChatMessagePart): part is ChatStepFinishPart {
  return part.type === 'step-finish'
}
