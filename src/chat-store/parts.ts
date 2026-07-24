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
 * - `mention`: an `@`-picked reference to a file that already lives in the
 *   workspace sandbox (`FileMention` in `/chat-routes`'s wire contract, plus
 *   the image/file discriminant). Neither transport lane produces it — the
 *   turn route persists it from the request's `mentions` field — but it is a
 *   part a product persists into a transcript, so it belongs in this
 *   vocabulary rather than in a parallel one.
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
// `./wire` is import-free by construction, so this edge costs the store
// nothing and keeps ONE image-extension table for the whole mention layer.
import {
  mentionKindForPath,
  type ChatAttachmentInput,
  type ChatAttachmentKind,
  type ChatMentionKind,
  type FileMention,
} from '../chat-routes/wire'

export type { ChatMentionKind, ChatAttachmentKind }

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

/** Define a reasoning part of a chat with text content and optional metadata fields */
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

/** Describe the current state and data of a chat tool including status, input, output, and metadata */
export interface ChatToolState {
  status: ChatToolStatus
  input?: unknown
  output?: unknown
  error?: string
  title?: string
  metadata?: Record<string, unknown>
  time?: ChatPartTime
}

/** Define a chat component representing a tool with its state and optional call identifier */
export interface ChatToolPart {
  type: 'tool'
  id: string
  tool: string
  callID?: string
  state: ChatToolState
}

/** Union of the sidecar's legacy (path-based) and AI-SDK (url-based) file
 *  shapes; response-side every field besides `type` is optional. `name` is the
 *  attachment-flavored display label an uploaded/promoted file carries (see
 *  {@link ChatAttachmentPart}) — absent on a harness-emitted file part, which
 *  uses `filename`. */
export interface ChatFilePart {
  type: 'file'
  id?: string
  filename?: string
  name?: string
  mediaType?: string
  url?: string
  path?: string
  content?: string
}

/** Define properties for an image part within a chat message including optional metadata fields */
export interface ChatImagePart {
  type: 'image'
  filename?: string
  name?: string
  mediaType?: string
  url?: string
  path?: string
}

/** Define a subtask part of a chat with prompt, description, agent, and optional identifier */
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

/** Define a chat step finish part indicating completion with optional reason, tokens, and cost */
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

/** Resolve a chat plan part by aliasing it to the persisted chat plan part type */
export type ChatPlanPart = ChatPlanPersistedPart

/** Persisted one-line transcript notice — byte-matches `noticePart` in
 *  `/web-react`'s chat-interactions contract. */
export interface ChatNoticePart {
  type: 'notice'
  id: string
  noticeKind: NoticeKind
  text: string
}

/**
 * A file the user `@`-mentioned on this turn: a workspace-relative path into
 * the sandbox, never bytes. `type: 'mention'` is its own discriminant
 * precisely so it does NOT collide with the `file`/`image` attachment parts —
 * an attachment carries content the product uploaded, a mention points at
 * something the box already has, and a transcript renders them differently
 * (an inline pill, not an attachment card).
 *
 * `path` is the identity: mentioning one file twice in a turn folds to one
 * part. `turnId` is optional and set by products that rebuild a turn's
 * mentions on retry.
 */
export interface ChatMentionPart {
  type: 'mention'
  mentionKind: ChatMentionKind
  path: string
  name: string
  size?: number
  turnId?: string
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

/** Represent parts of a chat message including text, reasoning, tools, files, images, subtasks, steps, interactions, notices, plans, and mentions */
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
  | ChatMentionPart

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
    case 'mention':
      return isChatMentionPart(part) ? part : null
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

/** Resolve whether a ChatMessagePart is specifically a ChatToolPart based on its type property */
export function isChatToolPart(part: ChatMessagePart): part is ChatToolPart {
  return part.type === 'tool'
}

/** Resolve whether a chat message part is a text part based on its type property */
export function isChatTextPart(part: ChatMessagePart): part is ChatTextPart {
  return part.type === 'text'
}

/** Resolve whether a ChatMessagePart is a ChatInteractionPart based on its type property */
export function isChatInteractionPart(part: ChatMessagePart): part is ChatInteractionPart {
  return part.type === 'interaction'
}

/** Resolve whether a chat message part is a persisted chat plan part */
export function isChatPlanPart(part: ChatMessagePart): part is ChatPlanPart {
  return part.type === 'plan'
}

/** Determine if a chat message part represents the completion of a chat step */
export function isChatStepFinishPart(part: ChatMessagePart): part is ChatStepFinishPart {
  return part.type === 'step-finish'
}

/** Widened to `unknown` — unlike its siblings this guard also runs over raw
 *  untyped stored rows (a transcript renderer reads `message.parts` before the
 *  typed projection), which is exactly what {@link mentionPartsFromMessageParts}
 *  needs. `path` and `name` carry the pill; a row missing either is unrenderable.
 *
 *  Mirrors the write contract exactly (`parseFileMention` in `/chat-routes`,
 *  then {@link mentionInputToPart}): a blank `name` is rejected there and so is
 *  rejected here, and `size` — optional, but typed `number` once present — is
 *  type-checked so `'12'` or `null` cannot ride through the guard wearing a
 *  type it does not have. Negative sizes are NOT re-rejected: the wire screens
 *  them, `mentionInputToPart` trusts its input, and a read guard stricter than
 *  what the writer can emit would drop rows it produced itself. */
export function isChatMentionPart(part: unknown): part is ChatMentionPart {
  if (!part || typeof part !== 'object') return false
  const record = part as Record<string, unknown>
  if (record.size !== undefined && (typeof record.size !== 'number' || !Number.isFinite(record.size))) {
    return false
  }
  return (
    record.type === 'mention' &&
    typeof record.path === 'string' &&
    record.path.length > 0 &&
    typeof record.name === 'string' &&
    record.name.trim().length > 0 &&
    (record.mentionKind === 'image' || record.mentionKind === 'file')
  )
}

/** Every mention part on one message, in stored order. The projection a
 *  transcript renderer runs before deciding which mentions the message text
 *  already shows inline (see `segmentMentionContent` in `/web-react`). */
export function mentionPartsFromMessageParts(
  parts: ReadonlyArray<Record<string, unknown>> | ReadonlyArray<ChatMessagePart> | null | undefined,
): ChatMentionPart[] {
  if (!parts) return []
  return (parts as ReadonlyArray<unknown>).filter(isChatMentionPart)
}

/** A validated wire mention (`parseFileMentions` in `/chat-routes`) as the
 *  part the turn route persists. An absent/non-finite `size` is DROPPED rather
 *  than stored as `undefined`, so a stored row never carries a key that means
 *  nothing. */
export function mentionInputToPart(input: FileMention): ChatMentionPart {
  const part: ChatMentionPart = {
    type: 'mention',
    mentionKind: mentionKindForPath(input.path),
    path: input.path,
    name: input.name,
  }
  if (typeof input.size === 'number' && Number.isFinite(input.size)) part.size = input.size
  return part
}

// ── attachments ──────────────────────────────────────────────────────────
//
// An attachment is a file the product uploaded into its own store (vault /
// object-store) ahead of the turn — content the box did not already have,
// unlike a `@`-mention. It persists NOT as a new `ChatMessagePart` union
// member but as an attachment-flavored `file`/`image` part: `type` is the
// existing `image`/`file` discriminant, with `path` + `name` load-bearing.
// That reuse is deliberate — a transcript already renders `file`/`image`
// parts, and `toChatMessagePart` passes them through by cast (fields survive),
// so an attachment slots into the same stored `parts` array without a parallel
// vocabulary. These helpers own the input→part projection, the path-keyed
// stream key, and the agent-facing prompt block, all byte-identical to the gtm
// source they were lifted from (gtm-agent#618 adoption reproduces its rows and
// dispatched prompt bytes through them).

/** `image` for any `image/*` mime, `file` for everything else (including an
 *  absent/empty mime) — the same split the composer and the persisted-part
 *  discriminant both key on. */
export function attachmentKindForMime(mime?: string): ChatAttachmentKind {
  return mime?.startsWith('image/') ? 'image' : 'file'
}

/** Stream/transcript part key for an attachment — ONE declaration, owned by
 *  `/stream`'s normalizer (whose `getPartKey` routes path-bearing file/image
 *  parts through it). Re-exported here (not redefined) so the root barrel's
 *  star-exports of both modules resolve to the same symbol instead of
 *  colliding (TS2308 in the dts build). */
export { attachmentPartKey } from '../stream/stream-normalizer'

/**
 * Persisted attachment part: structurally an attachment-flavored `ChatFilePart`
 * / `ChatImagePart` (`path` + `name` promoted to required) rather than a
 * separate union member — see the section note above. The index signature keeps
 * it a `Record<string, unknown>` so it drops into the same untyped `parts`
 * arrays every other stored part rides in, and lets the `type`-driven
 * constructors below build it without union-discriminant gymnastics.
 */
export interface ChatAttachmentPart {
  type: ChatAttachmentKind
  path: string
  name: string
  size?: number
  mediaType?: string
  turnId?: string
  [key: string]: unknown
}

/** True for any `image`/`file` part carrying a non-empty string `path`.
 *  DELIBERATELY also matches a sidecar path-bearing file part (a mention-style
 *  `file` part with only `path`) — the guard is a structural attachment shape,
 *  not proof of provenance; a caller that needs to exclude those filters
 *  upstream. The `path.length > 0` check diverges from gtm's original guard
 *  (which only checked `typeof`), mirroring sibling {@link isChatMentionPart}:
 *  read-side robustness against a stored `{type:'file', path:''}` row — which
 *  would otherwise render a malformed `(vault: )` pointer line — justifies the
 *  small divergence from byte-for-byte gtm parity here; no legitimate write
 *  path ever produces an empty `path`. */
export function isChatAttachmentPart(part: unknown): part is ChatAttachmentPart {
  if (!part || typeof part !== 'object') return false
  const record = part as Record<string, unknown>
  return (
    (record.type === 'image' || record.type === 'file') &&
    typeof record.path === 'string' &&
    record.path.length > 0
  )
}

/** Drop absent/empty optional fields rather than persisting `undefined`/`''`
 *  — keeps stored parts minimal. */
export function attachmentInputToPart(input: ChatAttachmentInput): ChatAttachmentPart {
  const part: ChatAttachmentPart = { type: input.kind, path: input.path, name: input.name }
  if (typeof input.size === 'number' && Number.isFinite(input.size)) part.size = input.size
  if (input.mediaType) part.mediaType = input.mediaType
  return part
}

/** Every attachment part on one message's stored `parts`, in stored order. */
export function attachmentPartsFromMessageParts(
  parts: ReadonlyArray<Record<string, unknown>> | null | undefined,
): ChatAttachmentPart[] {
  if (!parts) return []
  return parts.filter(isChatAttachmentPart)
}

/** gtm's exact default header for {@link buildAttachmentPromptBlock} — kept
 *  byte-identical because it feeds dispatched prompts (gtm-agent#618
 *  reproduces the prompt bytes through this module). Override only with intent. */
export const DEFAULT_ATTACHMENT_PROMPT_HEADER =
  'Attached files (already saved to the workspace vault — read them from these paths):'

/** Same C0-control/DEL sweep as `/chat-routes`'s `resolve-attachments.ts`
 *  (kept as a separate literal rather than a shared import — this module is
 *  the read side and must stay usable over PERSISTED rows the wire validator
 *  never saw). Replaced with a single space, not stripped or collapsed: this
 *  is defense-in-depth for legacy/corrupt stored rows that bypassed wire
 *  validation, not the primary control — a name/path a `resolveChatAttachments`
 *  call validated today never contains one, so this is a no-op on legitimate
 *  input and gtm byte-compat holds. */
const PROMPT_BLOCK_CONTROL_CHARS = /[\x00-\x1F\x7F]/g

/**
 * The agent-facing pointer block appended to the dispatched prompt — never
 * persisted in `message.content`. Empty array → `''` so callers can append
 * unconditionally. The sole producer of this text: both the current turn's
 * dispatch and history projection ({@link historyContentWithAttachments}) build
 * it from here, so the two can never drift. `header` overrides the first line
 * ({@link DEFAULT_ATTACHMENT_PROMPT_HEADER}); the per-file line format is fixed.
 *
 * Every interpolated `name`/`path` is swept for control characters first
 * (newline/carriage-return/tab included) and each one replaced with a single
 * space — a single-line-per-file guarantee. Without it, a control character
 * riding through on a PERSISTED row (`historyContentWithAttachments` reads
 * whatever is already stored; a legacy or hand-edited row was never re-checked
 * against `resolveChatAttachments`) could inject extra lines — fabricated
 * pointer entries or instructions — into a prompt the agent trusts verbatim.
 * The wire-side validator is the primary control; this is the backstop for
 * rows it never saw.
 */
export function buildAttachmentPromptBlock(
  atts: ReadonlyArray<Pick<ChatAttachmentPart, 'name' | 'path'>>,
  header: string = DEFAULT_ATTACHMENT_PROMPT_HEADER,
): string {
  if (atts.length === 0) return ''
  const clean = (value: string) => value.replace(PROMPT_BLOCK_CONTROL_CHARS, ' ')
  const lines = atts.map((a) => `- ${clean(a.name)} (vault: ${clean(a.path)})`)
  return `\n\n${header}\n${lines.join('\n')}`
}

/**
 * History projection for a persisted message: `content` unchanged when it
 * carries no attachment parts, else the block is appended once. The
 * no-double-annotation guarantee holds under the invariant that the block is
 * never persisted INTO `message.content` — it is appended only at read time,
 * by this function and the current turn's dispatch, both sourcing from
 * `attachmentPartsFromMessageParts` — never by content inspection. This
 * function does not (and cannot) detect an already-embedded block by scanning
 * `content` for its text: a message whose stored `content` happens to already
 * contain the block's bytes, alongside attachment parts, still gets the block
 * appended a second time. See the pinned test for that boundary.
 */
export function historyContentWithAttachments(
  message: {
    content: string
    parts?: ReadonlyArray<Record<string, unknown>> | null
  },
  header?: string,
): string {
  const attachmentParts = attachmentPartsFromMessageParts(message.parts)
  if (attachmentParts.length === 0) return message.content
  return `${message.content}${buildAttachmentPromptBlock(attachmentParts, header)}`
}
