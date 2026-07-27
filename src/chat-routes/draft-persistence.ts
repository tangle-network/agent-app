/**
 * Incremental ("draft") persistence of the assistant row WHILE a turn streams.
 *
 * Why this exists — the scale argument, not a convenience:
 *
 * A live turn is readable from two places. The hot path is the session
 * gateway's in-memory/Redis event buffer, which exists so a viewer survives a
 * network blip: it is keyed one sorted set per session, refreshed on every
 * push, and expires on a TTL. Its memory cost is `arrival_rate x TTL x
 * bytes_per_session` — strictly LINEAR in the TTL. Stretching that TTL to
 * cover "a viewer who opens the tab later" is a category error: it buys memory
 * proportional to the increase and still serves nothing to a viewer who
 * arrives past the new horizon.
 *
 * So the hot buffer must stay SHORT (live delivery + reconnect only), and
 * durable storage must serve history. That only works if durable storage
 * actually HAS the in-flight turn — which, before this module, it did not: the
 * assistant row was written once, after the stream drained. A viewer arriving
 * mid-turn past the hot window read an empty transcript.
 *
 * This module closes that gap: the assistant row is inserted early and patched
 * on a coalesced cadence, so the durable transcript is at most one interval
 * (default 2 s) behind the live stream and the hot buffer never has to be the
 * history tier.
 *
 * Mechanism only. It owns no vocabulary: the caller supplies the snapshot
 * function, the store, and the deterministic row id.
 *
 * Four properties the cadence guarantees:
 * - **Time-floored.** At most one write per `intervalMs`, never one per token.
 * - **Dirty-gated.** Only content-bearing events arm a write; heartbeats,
 *   status pings, and lifecycle envelopes never do.
 * - **Single-flight.** A write already in flight suppresses the next trigger
 *   instead of queueing; the final write is authoritative regardless of how
 *   many drafts landed.
 * - **Best-effort.** A store failure is logged and swallowed — a durability
 *   optimization must never kill a healthy stream (the same rule
 *   `withDurableChatProjection` already states).
 */

import { toChatMessageParts, type ChatMessagePart } from '../chat-store/parts'
import type { ChatTurnUsage } from './turn-routes'

/** Message row shape the writer reads back when re-entering a turn. */
export interface DraftStoredMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  parts?: ChatMessagePart[] | null
}

/** Values written to the assistant row — the intersection of the append and
 *  patch shapes, so one snapshot serves both. */
export interface AssistantRowValues {
  content: string
  parts?: ChatMessagePart[]
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  reasoningTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  costUsd?: number | null
}

/** The store capability incremental persistence needs on top of
 *  `appendMessage`. A store without `updateMessage` cannot patch a row, so it
 *  cannot draft at all — the caller keeps today's single-write behavior. */
export interface AssistantDraftStore {
  listMessages(threadId: string): Promise<DraftStoredMessage[]>
  appendMessage(input: AssistantRowValues & {
    id?: string
    threadId: string
    role: 'user' | 'assistant'
  }): Promise<unknown>
  updateMessage?(id: string, patch: AssistantRowValues): Promise<unknown>
  deleteMessage?(id: string): Promise<unknown>
}

/** Live snapshot of the assistant body, taken from the producer's own
 *  accumulators. `parts` is the DRAFT projection (`draftParts()`), never the
 *  finalized one — see `draftAssistantParts`. */
export interface AssistantDraftSnapshot {
  content: string
  parts?: Array<Record<string, unknown>>
  usage?: ChatTurnUsage
  model?: string
}

/** Product-tunable cadence. Defaults are stated on each field; a product with
 *  a chattier or heavier workload moves them without forking the writer. */
export interface DraftPersistenceTuning {
  /** Minimum wall-clock gap between draft writes, in ms. Default 2000.
   *
   *  Justification for 2 s, from a measured tool-heavy production run (517
   *  stream events over ~90 s wall = ~5.7 events/s): a 2 s floor with the
   *  dirty gate turns 517 candidate writes into <= 45, while leaving the
   *  durable row at most 2 s stale — an order of magnitude below the time it
   *  takes a viewer to open a tab and render, so a late viewer never perceives
   *  the lag. Fleet arithmetic at 10k concurrent 60 s runs: <= 30 updates per
   *  run x 167 run-starts/s = ~334 row-updates/s spread over per-tenant
   *  shards. Lower it and write amplification grows with no perceptible
   *  freshness gain; raise it past ~5 s and a late viewer starts seeing a
   *  visibly truncated answer. */
  intervalMs?: number
  /** Serialized-parts size (bytes) past which the interval backs off, so a
   *  turn accumulating a megabyte-scale `parts` blob does not rewrite it every
   *  interval. Default 262144 (256 KiB) -> interval x 2.5; ten times that ->
   *  interval x 5. The final write is never throttled. */
  backoffBytes?: number
  /** Per-tool-part output cap applied to DRAFTS ONLY (bytes). A tool returning
   *  a large blob would otherwise be rewritten in full on every draft. The
   *  final write always carries the untruncated value. Default 32768 (32 KiB);
   *  0 disables truncation. */
  maxDraftToolOutputBytes?: number
}

/** Define the inputs required to construct an assistant draft writer */
export interface AssistantDraftWriterOptions extends DraftPersistenceTuning {
  store: AssistantDraftStore
  threadId: string
  /** DETERMINISTIC row id for this turn's assistant message — the whole
   *  idempotency mechanism. Derived from the turn's existing identity
   *  (`deriveExecutionId` in the interactive lane, the turn id in the detached
   *  lane), so a re-entered turn addresses the SAME row: the writer looks the
   *  id up before its first insert and patches what it finds. */
  messageId: string
  /** Read the producer's live accumulators. Returns null before the producer
   *  is resolved (the assembly defers box resolution into the first pull). */
  snapshot(): AssistantDraftSnapshot | null
  /** Pre-persist text transform (`/redact`'s `redactPII`). Applied to the
   *  draft's scalar content AND every draft text part — parity with the final
   *  write, or incremental persistence would re-open the at-rest PII leak that
   *  transform closed, just seconds earlier and on every turn. */
  transformText?(text: string): string | Promise<string>
  log?: (message: string, meta?: Record<string, unknown>) => void
}

/** Coalescing writer that keeps one durable assistant row in step with a
 *  streaming turn. Created per turn; not reusable. */
export interface AssistantDraftWriter {
  /** Arm/trigger a draft write from one engine event. Synchronous by design —
   *  the write itself is fire-and-forget so the stream is never blocked on
   *  store latency. */
  notify(event: { type?: unknown }): void
  /** Stop drafting and settle any in-flight write. Called before the final
   *  write so a late draft can never clobber the authoritative row. */
  close(): Promise<void>
  /** Write the AUTHORITATIVE completion values onto this turn's row —
   *  insert-or-patch under the same deterministic id, un-throttled and
   *  un-truncated. Errors propagate: the final write is the one that must not
   *  fail silently. Implies {@link close}. */
  finalize(values: AssistantRowValues): Promise<void>
  /** The durable row this turn is writing, once one exists. */
  rowId(): string | undefined
  /** Retract the row for a turn that produced nothing (mirrors the final
   *  write's empty-turn skip, which leaves no row at all today). Also retracts
   *  a row a PREVIOUS attempt left behind, so a re-entered turn that ends
   *  empty converges on "no row" rather than a stale partial. */
  discard(): Promise<void>
  /** Diagnostics: how many draft writes actually reached the store. */
  writeCount(): number
}

/** Event types that carry assistant content and therefore arm a draft write.
 *  An allowlist on purpose: an unknown type (a product heartbeat, a bespoke
 *  passthrough) must NEVER arm a write, or a silent producer would rewrite the
 *  same row forever. */
const CONTENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'reasoning',
  'tool_call',
  'tool_result',
  'usage',
  'notice',
  'error',
  'file',
  'interaction',
  'interaction.cancel',
  'plan.submitted',
  'message.part.updated',
])

const DEFAULT_INTERVAL_MS = 2000
const DEFAULT_BACKOFF_BYTES = 262144
const DEFAULT_MAX_DRAFT_TOOL_OUTPUT_BYTES = 32768

/** True when this event should arm a draft write. */
export function isDraftContentEvent(event: { type?: unknown }): boolean {
  return typeof event?.type === 'string' && CONTENT_EVENT_TYPES.has(event.type)
}

/** Caps one tool part's `output` for a DRAFT write. The value is replaced by a
 *  truncated string plus a marker, so a reader can tell a clipped draft from a
 *  real short output; the final write restores the untruncated value. */
function capDraftToolOutput(part: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  if (maxBytes <= 0) return part
  if (String(part.type ?? '') !== 'tool') return part
  const state = part.state
  if (!state || typeof state !== 'object') return part
  const record = state as Record<string, unknown>
  const output = record.output
  if (output === undefined || output === null) return part
  const serialized = typeof output === 'string' ? output : safeStringify(output)
  if (serialized.length <= maxBytes) return part
  const metadata = (record.metadata && typeof record.metadata === 'object' ? record.metadata : {}) as Record<string, unknown>
  return {
    ...part,
    state: {
      ...record,
      output: `${serialized.slice(0, maxBytes)}…[draft-truncated ${serialized.length - maxBytes} chars]`,
      metadata: { ...metadata, draftTruncated: true },
    },
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** Build the coalescing draft writer for one turn. */
export function createAssistantDraftWriter(options: AssistantDraftWriterOptions): AssistantDraftWriter {
  const log = options.log ?? (() => {})
  const baseIntervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const backoffBytes = options.backoffBytes ?? DEFAULT_BACKOFF_BYTES
  const maxToolOutput = options.maxDraftToolOutputBytes ?? DEFAULT_MAX_DRAFT_TOOL_OUTPUT_BYTES

  let dirty = false
  let closed = false
  let inFlight: Promise<void> | undefined
  let lastWriteAt = 0
  let lastBlobBytes = 0
  let rowId: string | undefined
  let writes = 0

  /** Interval for the NEXT write, backed off by the size of the last blob
   *  written — a turn accumulating a huge parts array rewrites it less often. */
  function currentIntervalMs(): number {
    if (lastBlobBytes >= backoffBytes * 10) return baseIntervalMs * 5
    if (lastBlobBytes >= backoffBytes) return Math.round(baseIntervalMs * 2.5)
    return baseIntervalMs
  }

  async function projectValues(snapshot: AssistantDraftSnapshot): Promise<AssistantRowValues> {
    const transform = options.transformText
    const content = transform ? await transform(snapshot.content) : snapshot.content
    let parts: ChatMessagePart[] | undefined
    if (snapshot.parts) {
      const capped = snapshot.parts.map((part) => capDraftToolOutput(part, maxToolOutput))
      const redacted = transform
        ? await Promise.all(
            capped.map(async (part) =>
              String((part as { type?: unknown }).type ?? '') === 'text'
                ? { ...part, text: await transform(String((part as { text?: unknown }).text ?? '')) }
                : part,
            ),
          )
        : capped
      parts = toChatMessageParts(redacted)
    }
    const usage = snapshot.usage ?? {}
    return {
      content,
      ...(parts && parts.length > 0 ? { parts } : {}),
      ...(snapshot.model ? { model: snapshot.model } : {}),
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    }
  }

  /** Adopt the row a PREVIOUS attempt at this turn already inserted, if any.
   *  This lookup — by the deterministic id, through the store's ordinary read
   *  — is the whole crash-safety mechanism: no new state, no extra column, no
   *  second index. */
  async function adoptRow(): Promise<string | undefined> {
    if (rowId) return rowId
    const existing = (await options.store.listMessages(options.threadId)).find(
      (message) => message.id === options.messageId,
    )
    if (existing) rowId = existing.id
    return rowId
  }

  /** Insert-or-patch one set of values onto this turn's single row. */
  async function writeOnce(values: AssistantRowValues): Promise<void> {
    if (await adoptRow()) {
      await options.store.updateMessage!(rowId!, values)
      writes += 1
      return
    }
    const inserted = await options.store.appendMessage({
      id: options.messageId,
      threadId: options.threadId,
      role: 'assistant',
      ...values,
    })
    // The `?? options.messageId` tail is valid HERE and only here: this writer
    // supplied the id, so a store that returns nothing still wrote that row.
    // A caller that did not assign an id has no such fallback — which is why
    // `rowIdOf` deliberately stops at the honest read.
    rowId = rowIdOf(inserted) ?? options.messageId
    writes += 1
  }

  function trigger(): void {
    if (closed) return
    if (!dirty) return
    // Single-flight: a write already in flight SUPPRESSES this trigger rather
    // than queueing behind it. `dirty` stays armed, so the next event after it
    // lands writes the newer snapshot — one write is never spent on state a
    // later one supersedes.
    if (inFlight) return
    const now = Date.now()
    // The first content event writes immediately (a late viewer sees a row at
    // once); the time floor governs every write after it.
    if (lastWriteAt !== 0 && now - lastWriteAt < currentIntervalMs()) return
    const snapshot = options.snapshot()
    if (!snapshot) return
    // Nothing to persist yet: an armed-but-empty snapshot (first event is a
    // tool call with no text and no parts) would insert a blank row.
    if (!snapshot.content && (!snapshot.parts || snapshot.parts.length === 0)) return
    dirty = false
    lastWriteAt = now
    inFlight = (async () => {
      try {
        const values = await projectValues(snapshot)
        lastBlobBytes = values.parts ? safeStringify(values.parts).length : 0
        await writeOnce(values)
      } catch (err) {
        // Best-effort by contract: a store outage degrades freshness for late
        // viewers, it does not fail a healthy turn.
        log('[chat-routes] incremental assistant persistence failed', {
          messageId: options.messageId,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        inFlight = undefined
        // A trigger that arrived while this write was in flight left `dirty`
        // armed with a NEWER snapshot. Re-run it here or that state would sit
        // unwritten until the next content event — and if this was the last
        // event of a quiet stretch, until the final write.
        if (dirty && !closed) trigger()
      }
    })()
  }

  return {
    notify(event) {
      if (closed) return
      if (isDraftContentEvent(event)) dirty = true
      trigger()
    },
    async close() {
      closed = true
      if (inFlight) await inFlight
    },
    async finalize(values) {
      closed = true
      if (inFlight) await inFlight
      await writeOnce(values)
    },
    rowId: () => rowId,
    async discard() {
      closed = true
      if (inFlight) await inFlight
      if (!options.store.deleteMessage) return
      try {
        if (!(await adoptRow())) return
        await options.store.deleteMessage(rowId!)
        rowId = undefined
      } catch (err) {
        log('[chat-routes] draft assistant row discard failed', {
          messageId: options.messageId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    writeCount: () => writes,
  }
}

/** True when a store can support incremental persistence at all. Without
 *  `updateMessage` a draft row could never be patched, so the caller keeps
 *  today's exact single-write behavior. */
export function storeSupportsDraftPersistence(store: AssistantDraftStore): boolean {
  return typeof store.updateMessage === 'function'
}

/** The row id an `appendMessage` actually returned, or `null` when the store
 *  returned nothing usable. `ChatTurnMessageStore.appendMessage` is typed
 *  `Promise<unknown>` so a product adapter is free to resolve `void`; every
 *  caller that wants to NAME the row it just wrote has to read defensively.
 *
 *  Deliberately no fallback to a caller-assigned id — see `writeOnce`, which
 *  adds its own. A caller that let the store mint the id has nothing to fall
 *  back TO, and guessing one would report a row that may not exist. */
export function rowIdOf(inserted: unknown): string | null {
  const id = (inserted as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' && id ? id : null
}

/** The default deterministic assistant-row id for a turn. Readable on purpose
 *  (an operator grepping a transcript row id finds the run), and stable across
 *  re-entries because every input already is. */
export function assistantRowIdForTurn(turnKey: string): string {
  return `assistant:${turnKey}`
}
