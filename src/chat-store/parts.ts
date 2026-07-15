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
  InteractionPersistedPart,
  NoticeKind,
  NoticePersistedPart,
} from '../web-react/chat-interactions'

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
  cancelReason?: string
}

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

/** Every canonical harness wire-part kind must be storable — compile-time
 *  guarantee that a new agent-interface part kind cannot silently fall out of
 *  the persisted vocabulary. */
export type StorableHarnessPartKind = HarnessWirePart['type'] & ChatMessagePart['type']

export function isChatToolPart(part: ChatMessagePart): part is ChatToolPart {
  return part.type === 'tool'
}

export function isChatTextPart(part: ChatMessagePart): part is ChatTextPart {
  return part.type === 'text'
}

export function isChatInteractionPart(part: ChatMessagePart): part is ChatInteractionPart {
  return part.type === 'interaction'
}

export function isChatStepFinishPart(part: ChatMessagePart): part is ChatStepFinishPart {
  return part.type === 'step-finish'
}
