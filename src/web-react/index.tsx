/**
 * `@tangle-network/agent-app/web-react` — the shared chat-shell components
 * every agent app's web UI hand-rolls: a model picker over the runtime's
 * model catalogue, a reasoning-effort selector, and a message thread with
 * User/Agent identity, per-message model + cost + tokens/sec metrics,
 * canonical tool rows, and a collapsible thinking section.
 *
 * Works for BOTH chat shapes: router-backed copilots (LoopEvents from
 * `runtime/openai-stream`) and sandbox-backed chats — the thread renders
 * `ChatUiMessage`s; how they're produced is the app's business.
 *
 * Styling contract: Tailwind classes against the shared design tokens
 * (`bg-card`, `border-border`, `text-muted-foreground`, `bg-primary`, …) that
 * Tangle app shells define. No icon library of its own — the few local glyphs
 * are inline SVGs. Markdown and provider logos are injected (`renderMarkdown`,
 * `renderProviderBadge`).
 *
 * Tool rows compose the canonical run-row grammar from `@tangle-network/ui`
 * (`InlineToolItem` over `RunRowShell`): `chatToolCallPart` adapts each
 * `ChatToolCallInfo` to ui's `ToolPart` (the same adapter pattern ui's own
 * `ToolCallStep` uses), so the chat surface and every other Tangle run view
 * share one row implementation instead of drifting. That makes
 * `@tangle-network/ui` a peer of this subpath.
 */

import { useEffect, useId, useMemo, useRef, useState, memo, type ReactNode } from 'react'
import { InlineToolItem } from '@tangle-network/ui/run'
import type { ToolPart } from '@tangle-network/ui/types'
import { useSmoothText } from './smooth-text'
import { inertProps } from './inert'
import { useArrivalStyle } from './motion'
import { ChevronDown, OVERLAY_SHADOW, POPOVER_OPTION_FOCUS, usePending } from './controls'
import { BrandMark } from './brand-mark'
import { DurableChatCards, type DurableChatCardsProps } from './durable-chat-cards'
import { attachmentPartsFromMessageParts, type ChatAttachmentPart } from './chat-attachments'
import { MessageAttachments } from './message-attachments'
import { WorkProductCard, workProductPartsFromMessageParts } from './work-product'
import type { WorkProductPersistedPart } from '../work-product/types'

export * from './chat-stream'
export * from './chat-interactions'
export * from './chat-composer'
export * from './interaction-card-support'
export * from './interaction-question-card'
export * from './interaction-plan-card'
export * from './durable-plan-flow'
export * from './durable-plan-card'
export * from './durable-chat-cards'
export * from './durable-interaction-submit'
export * from './use-chat-interactions'
export * from './use-file-mentions'
export * from './chat-mentions'
export * from './chat-attachments'
export * from './message-attachments'
export * from './use-composer-attachments'
export * from './provider-logo'
export * from './harness-glyphs'
export * from './smooth-text'
export * from './mission-activity'
export * from './work-product'
export * from './provenance'
export * from './sandbox-terminal'
export * from './seat-paywall'
export * from './session-history'
export * from './record-grid'
export {
  usePopover,
  usePending,
  PopoverSurface,
  POPOVER_SURFACE_ATTR,
  ModelPicker,
  EffortPicker,
  EffortMeter,
  effortMeterFill,
  effortLevelLabel,
  effortLevelsFromIds,
  reconcileEffortLevels,
  DEFAULT_EFFORT_LEVELS,
  EFFORT_METER_SEGMENTS,
  OVERLAY_SHADOW,
  type ModelPickerProps,
  type EffortPickerProps,
  type EffortLevel,
  type PopoverSurfaceProps,
} from './controls'
export {
  AgentSessionControls,
  type AgentSessionControlsProps,
} from './agent-session-controls'
import type { CatalogModel } from '../runtime/model-catalog'
// Re-export the model type the chat components consume, so a web-react consumer
// imports it from here rather than the package root.
export type { CatalogModel } from '../runtime/model-catalog'

// ── metrics helpers ───────────────────────────────────────────────────────

/** Describe metrics related to a chat message including model, token counts, and duration */
export interface ChatMessageMetrics {
  modelUsed?: string
  promptTokens?: number
  completionTokens?: number
  durationMs?: number
}

/** "$0.0042" from token counts × catalogue per-token pricing; null when unknown. */
export function formatModelCost(msg: ChatMessageMetrics, models: CatalogModel[]): string | null {
  if (msg.promptTokens == null && msg.completionTokens == null) return null
  const pricing = models.find((m) => m.id === msg.modelUsed)?.pricing
  if (!pricing) return null
  const cost =
    (msg.promptTokens ?? 0) * Number(pricing.prompt ?? 0) +
    (msg.completionTokens ?? 0) * Number(pricing.completion ?? 0)
  if (!isFinite(cost) || cost <= 0) return null
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
}

/** "38 tok/s" from completion tokens over first-token→end duration; null when unknown. */
export function formatTokensPerSecond(msg: ChatMessageMetrics): string | null {
  if (msg.completionTokens == null || !msg.durationMs) return null
  return `${Math.round(msg.completionTokens / (msg.durationMs / 1000))} tok/s`
}

// ── Tool run drill-in (retained runs) ─────────────────────────────────────

/** One step of a retained tool run (e.g. a sandbox command + its output). */
export interface ToolRunStep {
  at: string
  label: string
  detail?: string
  status?: 'ok' | 'error'
}

/** A retained tool run keyed by the parent message's toolCallId. The product
 *  persists these server-side (fail-closed: only ids its own loop created)
 *  and serves them to the drill-in panel. */
export interface ToolRunRecord {
  toolCallId: string
  toolName: string
  title: string
  status: 'running' | 'complete' | 'error'
  steps: ToolRunStep[]
}

/** Define properties required to run a drill and handle its closure event */
export interface RunDrillInProps {
  run: ToolRunRecord
  onClose: () => void
}

/**
 * Readonly side panel showing a retained tool run's transcript — the
 * "drill into what the sandbox actually did" view. Follow-ups happen in the
 * main chat, never here.
 */
export function RunDrillIn({ run, onClose }: RunDrillInProps) {
  return (
    <div className={`fixed inset-y-0 right-0 z-50 flex w-[480px] max-w-full flex-col border-l border-card-edge bg-popover ${OVERLAY_SHADOW}`}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            run.status === 'running' ? 'bg-warning' : run.status === 'error' ? 'bg-destructive' : 'bg-success'
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{run.title}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{run.toolName}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {run.steps.length === 0 && (
          <p className="text-sm text-muted-foreground">No steps recorded yet.</p>
        )}
        {run.steps.map((step, i) => (
          <div key={i} className="rounded-lg border border-card-edge bg-card">
            <div className="flex items-baseline gap-2 border-b border-border px-3 py-1.5">
              <span className={`font-mono text-[11px] ${step.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                {step.status === 'error' ? '✗' : '$'}
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{step.label}</code>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {new Date(step.at).toLocaleTimeString()}
              </span>
            </div>
            {step.detail && (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {step.detail}
              </pre>
            )}
          </div>
        ))}
      </div>
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        Readonly drill-in. Follow up in the main chat.
      </p>
    </div>
  )
}

// ── ChatMessages ──────────────────────────────────────────────────────────

/** Describe the structure and state of a tool call within a chat interaction */
export interface ChatToolCallInfo {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  /** The call arguments, captured from the tool_call event — shown in the
   *  expanded card so users see exactly what the agent invoked. */
  args?: Record<string, unknown>
  /** The tool outcome (`{ok, result}` shape). When `result.status` is
   *  'queued_for_approval' the card renders the approval state. */
  result?: unknown
}

/** Extract `{proposalId, status}` from a tool outcome when it is a proposal
 *  awaiting human approval; null otherwise. */
export function pendingApprovalOf(call: ChatToolCallInfo): { proposalId: string } | null {
  const outcome = call.result as { ok?: boolean; result?: { status?: string; proposalId?: string } } | undefined
  if (!outcome?.ok || outcome.result?.status !== 'queued_for_approval' || !outcome.result.proposalId) return null
  return { proposalId: outcome.result.proposalId }
}

/** One ordered piece of an assistant turn: a run of answer text, or a tool
 *  call, in the sequence the agent emitted them. A message carrying `segments`
 *  is rendered in order — interleaving text and tool rows — so the agent's
 *  pre- and post-tool reasoning reads chronologically instead of as one text
 *  blob with the tool rows collected after it. */
export type ChatMessageSegment =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; call: ChatToolCallInfo }

/** Describe the structure and properties of a chat message with roles, content, and optional metadata */
export interface ChatUiMessage extends ChatMessageMetrics {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  reasoning?: string
  toolCalls?: ChatToolCallInfo[]
  /** Ordered text/tool sequence for true chronological interleaving. When
   *  present and non-empty it is rendered in place of `content` + `toolCalls`;
   *  both remain the fallback for producers that don't segment a turn. */
  segments?: ChatMessageSegment[]
  /** Persisted assistant parts. When `ChatMessages.durableCards` is supplied,
   * shared plan/question cards render directly from these projections. */
  parts?: Array<Record<string, unknown>>
}

/** Define properties for rendering chat messages with optional models, markdown, extras, and durable cards */
export interface ChatMessagesProps {
  messages: ChatUiMessage[]
  /** Shared reading scale for both user and assistant prose. Defaults to 16px;
   *  `large` uses 17px without enlarging labels, tool chrome, or metadata. */
  messageSize?: 'default' | 'large'
  /** Transcript chrome. `labeled` (default) keeps the always-on role label +
   *  model/tok-s/cost meta line and the primary-tinted user bubble. `quiet`
   *  drops the label row into a fixed-height meta lane at each row's bottom
   *  (copy + the demoted meta, revealed on hover/focus, always visible on
   *  touch) and renders user bubbles neutral with a symmetric radius.
   *  Everything else — tool rows, reasoning, streaming — is identical. */
  chrome?: 'labeled' | 'quiet'
  /** Catalogue models, for per-message cost from pricing. Pass [] to skip cost. */
  models?: CatalogModel[]
  /** Markdown renderer for assistant content; default renders pre-wrapped text. */
  renderMarkdown?: (content: string) => ReactNode
  /** Extra per-message content (artifacts, custom panels) appended after the body. */
  renderExtras?: (message: ChatUiMessage) => ReactNode
  /** Canonical durable plan/question card wiring. Apps inject only transport,
   * access, and optional visual callbacks; card selection/dedupe stays shared. */
  durableCards?: Omit<DurableChatCardsProps, 'parts' | 'renderMarkdown'>
  userLabel?: string
  agentLabel?: string
  /** Render the trailing "agent is thinking" row. */
  loading?: boolean
  /** Approve/Reject handlers for proposals awaiting approval. When omitted the
   *  card still shows "awaiting approval" but without action buttons. */
  approval?: ProposalApprovalHandlers
  /** Open a full-transcript view (e.g. {@link RunDrillIn}) from a tool row's
   *  actions slot. */
  onToolCallClick?: (call: ChatToolCallInfo, message: ChatUiMessage) => void
  /** Per-tool custom detail renderers for the expanded tool row body. */
  toolRenderers?: ToolDetailRenderers
  /** Stream-error affordance: when the turn failed (a thrown transport error or
   *  a loop-level `onErrorEvent`), pass the message here to render an error row.
   *  A failed turn otherwise just stops with no UI signal. */
  error?: string | null
  /** Retry control shown on the error row; omit to render the error without a
   *  retry button (e.g. when the product retries automatically). */
  onRetry?: () => void
  /** Zero-state renderer, shown when there are no messages and the turn is
   *  neither loading nor errored. When omitted, a branded first-run state is
   *  shown ({@link ChatEmptyState}); pass `() => null` to render nothing. */
  renderEmpty?: () => ReactNode
  /** First-run state config used when `renderEmpty` is not supplied. Lets a
   *  product set the headline and the "doors" (e.g. start from a template, ask
   *  the agent) without replacing the whole zero-state. */
  emptyState?: ChatEmptyStateProps
  /** Optional branded header slot rendered above the thread. Off by default to
   *  preserve the current layout; pass `{ title }` (or your own node via
   *  `header`) to show the Tangle mark + product title in the chat shell. */
  header?: ReactNode
  /** Resolve a raw-bytes download URL for one attachment part. When set, any
   *  message carrying attachment parts (`file`/`image` parts with a `path`,
   *  see `attachmentPartsFromMessageParts`) renders them as a `MessageAttachments`
   *  row next to the bubble — thumbnails for images, download chips for files.
   *  Absent → today's rendering, byte-identical (no attachment row). */
  resolveAttachmentUrl?: (part: ChatAttachmentPart) => string
  /** Render persisted `type:'work_product'` anchor parts as `WorkProductCard`
   *  rows under the message body — the chat card that keeps chat the driver
   *  surface for review. `onOpen` opens the product's queue/detail surface.
   *  Absent → today's rendering, byte-identical (no card row). */
  workProductCards?: { onOpen?: (part: WorkProductPersistedPart) => void }
}

/** One starting "door" in the chat first-run state — a concrete, labeled action
 *  (start from a template, do it by hand, ask the agent), not a placeholder. */
export interface ChatEmptyDoor {
  label: string
  description?: string
  onSelect: () => void
}

/** Define properties for rendering the chat empty state with customizable text and starting doors */
export interface ChatEmptyStateProps {
  /** Product name shown next to the Tangle mark. Default "Agent". */
  productName?: string
  /** Headline. Default frames delegation, not messaging. */
  headline?: string
  /** Subline under the headline. */
  subline?: string
  /** Up to three concrete starting doors. Omit for a mark-and-prompt-only state. */
  doors?: ChatEmptyDoor[]
}

/**
 * Branded chat first-run state: the Tangle mark, a delegation-framed prompt, and
 * up to three concrete doors. Replaces the blank thread that read as "empty or
 * broken". Concrete + actionable — never a "coming soon" placeholder.
 */
export function ChatEmptyState({
  productName = 'Agent',
  headline = 'Ask the agent to do something',
  subline = 'Describe the outcome you want. The agent works through it step by step, and pauses for your approval before anything irreversible.',
  doors,
}: ChatEmptyStateProps) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-6 py-12 text-center sm:py-20">
      <span className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/15">
        <BrandMark size={32} className="shrink-0" />
      </span>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{productName}</p>
      <h2 className="mt-1.5 text-balance text-2xl font-semibold leading-tight text-foreground sm:text-[28px]">
        {headline}
      </h2>
      {subline && <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground">{subline}</p>}
      {doors && doors.length > 0 && (
        <div className="mt-7 grid w-full gap-2.5 sm:grid-cols-3">
          {doors.slice(0, 3).map((door, i) => (
            <button
              key={i}
              type="button"
              onClick={door.onSelect}
              className="group flex min-h-[44px] flex-col items-start rounded-xl border border-border bg-card px-4 py-3 text-left transition hover:border-primary/40 hover:bg-accent"
            >
              <span className="text-sm font-semibold text-foreground">{door.label}</span>
              {door.description && (
                <span className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{door.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Handle approval and rejection actions for proposals with asynchronous support */
export interface ProposalApprovalHandlers {
  onApprove: (proposalId: string, toolCallId: string) => void | Promise<void>
  onReject: (proposalId: string, toolCallId: string) => void | Promise<void>
}

/** Per-tool custom detail renderers for the expanded card body — keyed by
 *  tool name. Return null to fall back to the generic detail view. */
export type ToolDetailRenderers = Record<
  string,
  (call: ChatToolCallInfo, message: ChatUiMessage) => ReactNode
>

function ToolGlyph({ name, className }: { name: string; className?: string }) {
  if (name.startsWith('sandbox_')) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    )
  }
  if (name === 'submit_proposal') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6M9 15l2 2 4-4" />
      </svg>
    )
  }
  if (name === 'schedule_followup') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 3" />
      </svg>
    )
  }
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v3m0 12v3M3 12h3m12 0h3" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  )
}

function toolOutcomeOf(call: ChatToolCallInfo): { ok?: boolean; result?: Record<string, unknown>; message?: string } | undefined {
  return call.result as { ok?: boolean; result?: Record<string, unknown>; message?: string } | undefined
}

/** A call that failed — by status OR by an `ok:false` outcome envelope. Shared
 *  by the row adapter, the collapse guard, and the card itself so the three can
 *  never disagree about what "failed" means. */
function toolCallFailed(call: ChatToolCallInfo): boolean {
  return call.status === 'error' || toolOutcomeOf(call)?.ok === false
}

/**
 * Adapt a chat tool call to the canonical `@tangle-network/ui` `ToolPart`, so
 * the row renders through ui's `InlineToolItem` — one run-row grammar shared
 * with every other Tangle run view (the same adapter pattern ui's own
 * `ToolCallStep` uses for its flat props). `sandbox_run_command` maps to ui's
 * canonical `bash` name so the row takes the command category (terminal icon);
 * every other tool keeps its real name. agent-app carries no per-call timings,
 * so `state.time` stays unset and the row shows no duration.
 */
export function chatToolCallPart(call: ChatToolCallInfo): ToolPart {
  const failed = toolCallFailed(call)
  return {
    type: 'tool',
    id: call.id,
    tool: call.name === 'sandbox_run_command' ? 'bash' : call.name,
    state: {
      status: call.status === 'running' ? 'running' : failed ? 'error' : 'completed',
      input: call.args,
      output: call.result,
      error: failed ? (toolOutcomeOf(call)?.message ?? 'Tool failed') : undefined,
    },
  }
}

/** The four visual kinds a tool call presents as. They are *different kinds of
 *  thing* (audit chat finding #3/#4) and must read differently: a command is a
 *  past-tense action, a proposal is a pending decision, a follow-up is a
 *  scheduled intent, everything else is a generic tool step. Derived from the
 *  tool name + outcome, never from baked domain values. */
type BlockKind = 'command' | 'proposal' | 'followup' | 'generic'

function blockKindOf(call: ChatToolCallInfo): BlockKind {
  if (call.name === 'submit_proposal') return 'proposal'
  if (call.name === 'schedule_followup') return 'followup'
  if (call.name.startsWith('sandbox_')) return 'command'
  return 'generic'
}

/** Humanize an otherwise-unmapped tool name for display: `get_credit_balance`
 *  → "Get credit balance". Splits on separators and camelCase, then sentence-
 *  cases — domain-agnostic, so a host's tool reads as a label without this
 *  shared renderer knowing that host's tool taxonomy. Falls back to the raw name
 *  when there's nothing to humanize. */
function humanizeToolName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (!words) return name
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Human title for a call, derived from its real arguments. Proposals lead with
 *  the decision verb (docs/product-surfaces.md) rather than the internal tool
 *  taxonomy, so the user reads "Approve: publish …?" not "submit_proposal". An
 *  unmapped tool falls back to its humanized name rather than the raw slug. */
function friendlyToolTitle(call: ChatToolCallInfo): string {
  const a = call.args ?? {}
  switch (call.name) {
    case 'submit_proposal':
      return a.title ? `Approve: ${String(a.title)}?` : 'Approve this action?'
    case 'sandbox_create':
      return `Created sandbox (${String(a.environment ?? 'universal')})`
    case 'sandbox_run_command':
      return `Ran ${String(a.command ?? 'command')}`
    case 'sandbox_destroy':
      return `Destroyed sandbox ${String(a.sandbox_id ?? '')}`
    case 'schedule_followup':
      return `Scheduled: ${String(a.title ?? 'follow-up')}`
    case 'render_ui':
      return `Rendered view · ${String(a.title ?? '')}`
    case 'add_citation':
      return `Cited ${String(a.path ?? '')}`
    default:
      return humanizeToolName(call.name)
  }
}

/** A one-line, plain-English preview of WHAT a proposal will do, assembled from
 *  the proposal's real arguments (audit chat finding #2 — "approving a black box
 *  is the fastest way to lose trust"). Domain stays a parameter: we only read
 *  conventional fields (destinations/targets/channels, cost, reach) when present
 *  — nothing here is baked to a specific product's proposal type. Returns null
 *  when there's nothing meaningful to preview. */
function proposalPreview(call: ChatToolCallInfo): { summary: string | null; meta: string[] } {
  const a = (call.args ?? {}) as Record<string, unknown>
  const asString = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null
  const asList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => (typeof x === 'string' ? x : null)).filter((x): x is string => !!x)
      : asString(v)
        ? [asString(v) as string]
        : []

  // The verb: a free-form summary the agent wrote, else derive from type.
  const verbPhrase =
    asString(a.summary) ??
    asString(a.description) ??
    (asString(a.type)
      ? `${String(a.type).replace(/_/g, ' ')}${asString(a.title) ? `: ${asString(a.title)}` : ''}`
      : null)

  const destinations = [
    ...asList(a.destinations),
    ...asList(a.channels),
    ...asList(a.targets),
    ...asList(a.platforms),
  ]
  const dest = destinations.length ? ` to ${destinations.join(' and ')}` : ''
  const summary = verbPhrase ? `${verbPhrase}${dest}` : destinations.length ? `Publish to ${destinations.join(' and ')}` : null

  // Cost / reach: surfaced when the data carries it, formatted lightly.
  const meta: string[] = []
  const cost = a.cost ?? a.price ?? a.estimatedCost
  if (typeof cost === 'number' && cost > 0) meta.push(`~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`)
  else if (asString(cost)) meta.push(asString(cost) as string)
  const reach = a.reach ?? a.audience ?? a.estimatedReach
  if (typeof reach === 'number' && reach > 0) meta.push(`reaches ~${reach.toLocaleString()}`)
  else if (asString(reach)) meta.push(asString(reach) as string)

  return { summary, meta }
}

function truncate(v: unknown, max = 240): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  // JSON.stringify returns undefined (not a string) for undefined / functions /
  // symbols — a non-envelope tool output (a bare string, or a result with no
  // `.result`) lands here. Coerce to '' so we never read `.length` off undefined
  // and crash the whole chat surface.
  if (typeof s !== 'string') return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function KvRows({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (!entries.length) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-mono text-[11px] text-muted-foreground">{k}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
            {truncate(v)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Terminal-styled rendering for shell executions. */
function ShellDetail({ call }: { call: ChatToolCallInfo }) {
  const outcome = toolOutcomeOf(call)
  const r = (outcome?.result ?? {}) as { stdout?: string; stderr?: string; exitCode?: number }
  return (
    <div className="overflow-hidden rounded-md bg-zinc-900 font-mono text-[11px] leading-relaxed">
      <div className="flex items-center gap-2 px-3 pt-2 text-zinc-400">
        <span className="select-none text-zinc-500">$</span>
        <span className="min-w-0 flex-1 truncate text-zinc-200">{String(call.args?.command ?? '')}</span>
        {r.exitCode != null && (
          <span className={r.exitCode === 0 ? 'text-success' : 'text-destructive'}>exit {r.exitCode}</span>
        )}
      </div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap px-3 pb-2.5 pt-1.5 text-zinc-300">
        {outcome?.ok === false ? (outcome.message ?? 'failed') : [r.stdout, r.stderr].filter(Boolean).join('\n') || '(no output)'}
      </pre>
    </div>
  )
}

/** Generic expanded detail: what was called, and what actually happened. */
function DefaultToolDetail({ call }: { call: ChatToolCallInfo }) {
  // A tool result is the `{ ok, result }` proposal envelope ONLY when it is an
  // object. bash/skill/python outputs arrive as a bare string (or nothing at
  // all), so reading `.ok`/`.result` off them is meaningless — those render as
  // their raw value, not through the envelope branch.
  const result: unknown = call.result
  const envelope =
    typeof result === 'object' && result !== null
      ? (result as { ok?: boolean; result?: unknown; message?: string })
      : null
  return (
    <div className="space-y-2">
      {call.args && Object.keys(call.args).length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Called with</p>
          <KvRows data={call.args} />
        </div>
      )}
      {envelope ? (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {envelope.ok === false ? 'Failed' : 'Result'}
          </p>
          {envelope.ok === false ? (
            <p className="text-xs text-destructive">{envelope.message ?? 'Tool failed'}</p>
          ) : envelope.result && typeof envelope.result === 'object' ? (
            <KvRows data={envelope.result as Record<string, unknown>} />
          ) : envelope.result != null ? (
            <p className="font-mono text-[11px] text-muted-foreground">{truncate(envelope.result)}</p>
          ) : null}
        </div>
      ) : result != null ? (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Result</p>
          <p className="font-mono text-[11px] text-muted-foreground">{truncate(result)}</p>
        </div>
      ) : null}
    </div>
  )
}

/** The pending-decision card. The single highest-leverage surface in the repo
 *  (audit chat finding #1, critical): Approve is the affirmative path — filled,
 *  brand-colored, primary — and Reject is quiet/outline, so a user never reads
 *  both labels twice to know the safe action. Carries a plain-English preview of
 *  WHAT it will do (#2). `onApprove`/`onReject` are unchanged. */
function ProposalCard({
  call,
  message,
  pending,
  approval,
  renderers,
}: {
  call: ChatToolCallInfo
  message: ChatUiMessage
  pending: { proposalId: string }
  approval?: ProposalApprovalHandlers
  renderers?: ToolDetailRenderers
}) {
  const [expanded, setExpanded] = useState(false)
  const { summary, meta } = proposalPreview(call)
  const custom = renderers?.[call.name]?.(call, message)
  const { pending: deciding, run: decide } = usePending()

  return (
    <div className="w-full max-w-full rounded-xl border border-warning/50 bg-warning/[0.06] text-sm shadow-sm ring-1 ring-warning/10">
      <div className="flex items-start gap-2.5 px-4 pt-3.5">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
          <ToolGlyph name={call.name} className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-warning-strong">Needs your approval</p>
          <p className="mt-0.5 text-[15px] font-semibold leading-snug text-foreground">{friendlyToolTitle(call)}</p>
          {summary && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{summary}</p>}
          {meta.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {meta.map((m, i) => (
                <span key={i} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5 pt-3">
        {approval ? (
          <>
            <button
              type="button"
              disabled={deciding}
              onClick={() => decide(() => approval.onApprove(pending.proposalId, call.id))}
              className="inline-flex min-h-[40px] flex-1 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none sm:min-w-[160px]"
            >
              Approve &amp; run
            </button>
            <button
              type="button"
              disabled={deciding}
              onClick={() => decide(() => approval.onReject(pending.proposalId, call.id))}
              className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              Reject
            </button>
          </>
        ) : (
          <span className="text-[12px] font-medium text-muted-foreground">Awaiting approval…</span>
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="ml-auto inline-flex items-center gap-1 rounded text-[12px] font-medium text-muted-foreground transition hover:text-foreground"
        >
          {expanded ? 'Hide details' : 'View details'}
          <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {expanded && (
        <div className="border-t border-warning/20 px-4 py-3 text-xs">
          {custom ?? <DefaultToolDetail call={call} />}
        </div>
      )}
    </div>
  )
}

/** A scheduled follow-up — a pending, time-based intent, not a decision and not
 *  a completed action (audit finding #5). Re-skinned onto the shared run-row
 *  geometry (full width, 24px icon chip, xs title, mono `when` in the
 *  description slot) so it reads as a sibling of the canonical tool rows; it
 *  is not a tool invocation, so the row does not expand. */
function FollowupCard({ call }: { call: ChatToolCallInfo }) {
  const a = (call.args ?? {}) as Record<string, unknown>
  const when = typeof a.when === 'string' ? a.when : typeof a.at === 'string' ? a.at : typeof a.schedule === 'string' ? a.schedule : null
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--md3-surface-container)]">
        <div className="flex w-full items-center gap-2.5 px-3 py-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-border bg-muted text-muted-foreground">
            <ToolGlyph name={call.name} className="h-3.5 w-3.5" />
          </span>
          <span className="shrink-0 whitespace-nowrap text-xs font-medium text-foreground">{friendlyToolTitle(call)}</span>
          {when && (
            <span className="hidden min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground sm:inline">{when}</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Row title: short and past-tense. A command's text moves to the canonical
 *  mono description slot instead of filling the title. */
function toolRowTitle(call: ChatToolCallInfo): string {
  if (call.name === 'sandbox_run_command') return 'Ran command'
  return friendlyToolTitle(call)
}

/** The collapsed row's inline description — the canonical row's mono slot. Only
 *  a command has a natural one-liner; every other tool's title already carries
 *  its identifying argument. */
function toolRowDescription(call: ChatToolCallInfo): string | undefined {
  if (call.name !== 'sandbox_run_command') return undefined
  const command = call.args?.command
  return typeof command === 'string' && command ? command : undefined
}

function ToolCallCard({
  call,
  message,
  approval,
  onOpenRun,
  renderers,
  staggerIndex,
}: {
  call: ChatToolCallInfo
  message: ChatUiMessage
  approval?: ProposalApprovalHandlers
  onOpenRun?: (call: ChatToolCallInfo, message: ChatUiMessage) => void
  renderers?: ToolDetailRenderers
  /** Position in the surrounding run, so a group of rows arrives as a
   *  sequence. Frozen at mount by `useArrivalStyle`. */
  staggerIndex?: number
}) {
  const arrival = useArrivalStyle(staggerIndex ?? 0)
  const pending = call.status === 'done' ? pendingApprovalOf(call) : null
  const kind = blockKindOf(call)
  const failed = toolCallFailed(call)

  // One wrapper for all three row shapes, because `InlineToolItem` takes a
  // `className` but no `style`, and the stagger index has to ride an element
  // this package controls. The row arrives ONCE: a call going running → done →
  // failed re-renders this same node (its key is the call id, never its
  // status), and a CSS animation does not replay on a re-render.
  const arrive = (row: ReactNode) => (
    <div className="agent-arrive" style={arrival}>
      {row}
    </div>
  )

  // A proposal awaiting approval is a pending DECISION, not a tool row — it
  // keeps its own prominent card with primary Approve / quiet Reject.
  if (pending) {
    return arrive(
      <ProposalCard
        call={call}
        message={message}
        pending={pending}
        approval={approval}
        renderers={renderers}
      />,
    )
  }
  // A scheduled follow-up is a time-based intent — its own quiet row, distinct
  // from a tool invocation.
  if (kind === 'followup' && !failed) {
    return arrive(<FollowupCard call={call} />)
  }

  // Command and generic tool calls render through the canonical InlineToolItem
  // row (category icon chip, title, mono description, status, hairline expand).
  // The expanded body stays agent-app's — the host's custom renderer, the
  // terminal ShellDetail for commands, or the generic args/result view — via
  // ui's `renderToolDetail` seam, and `onOpenRun` maps to the row's actions
  // slot, so no agent-app capability is lost to the shared chrome.
  const custom = renderers?.[call.name]?.(call, message)
  return arrive(
    <InlineToolItem
      part={chatToolCallPart(call)}
      title={toolRowTitle(call)}
      description={toolRowDescription(call)}
      renderToolDetail={() =>
        custom ??
        (call.name === 'sandbox_run_command' ? <ShellDetail call={call} /> : <DefaultToolDetail call={call} />)
      }
      actions={
        onOpenRun && call.name.startsWith('sandbox_') ? (
          <button
            type="button"
            onClick={() => onOpenRun(call, message)}
            className="rounded border border-border bg-card px-2 py-1 text-[11px] font-medium transition hover:bg-accent"
          >
            Open full transcript →
          </button>
        ) : undefined
      }
    />,
  )
}

/** The blinking insertion caret shown at the end of streaming answer text.
 *  Shared by the segmented and legacy branches so their streaming cue can't
 *  visually diverge. */
function StreamingCaret() {
  return (
    <span
      // `animate-pulse` is a 2s ease-in-out opacity fade — a breathing
      // placeholder, not a caret. A caret is a hard 1s step blink, which is
      // what every text surface the user has ever typed into does.
      className="ml-0.5 inline-block h-[1.1em] w-[3px] translate-y-[2px] animate-[agent-caret_1s_step-end_infinite] rounded-sm bg-foreground/70"
      data-motion="essential"
      aria-hidden
    />
  )
}

/** One text run inside a segmented turn. Smooths its own text so only the
 *  actively-streaming trailing run types out; finalized runs render at once.
 *  A child component (not an inline map) so its `useSmoothText` state is stable
 *  across the parent's per-frame stream re-renders. */
function SegmentText({
  content,
  streaming,
  showCaret,
  renderBody,
  messageClassName,
}: {
  content: string
  streaming: boolean
  showCaret: boolean
  renderBody: (content: string) => ReactNode
  messageClassName: string
}) {
  const text = useSmoothText(content, streaming)
  const body = useMemo(() => renderBody(text), [renderBody, text])
  // An empty / whitespace-only run paints a blank line-height gap — render
  // nothing, UNLESS it's the live trailing run (showCaret), where it still
  // carries the caret so the turn doesn't look frozen. (Hooks run first, so
  // this stays rules-of-hooks safe.)
  if (!content.trim() && !showCaret) return null
  return (
    // A settled run arrives from a short blur; the LIVE run does not, because
    // its text is already being revealed character by character and animating
    // the container on top of that makes the paragraph shimmer while it types.
    // The distinction is what separates "the answer materialised" from "the
    // log was appended to".
    <div className={`${messageClassName}${streaming ? '' : ' agent-stream-in'}`}>
      {body}
      {/* Gate on showCaret (not the smoothed `text`, which is '' on the first
          frame) so the caret is steady from the start instead of flickering. */}
      {showCaret && <StreamingCaret />}
    </div>
  )
}

/** A settled run of at least this many consecutive tool calls collapses into a
 *  single "Worked through N steps" disclosure so a long multi-step turn does not
 *  flood the transcript. Below it, tool rows render inline as before. */
const COLLAPSE_TOOL_RUN_AT = 3

/** A tool call the user must not miss even in a settled run — a failure (by
 *  status OR by an `ok:false` outcome, the shared `toolCallFailed` predicate),
 *  a card awaiting their approval, or a tool still `running` after the turn has
 *  settled (i.e. stuck / timed out). A run containing one is NEVER collapsed, so
 *  a failed, blocked, or stuck turn can't hide behind a "Worked through N steps"
 *  summary and read as successful. */
function isImportantTool(call: ChatToolCallInfo): boolean {
  return (
    call.status === 'running' ||
    toolCallFailed(call) ||
    pendingApprovalOf(call) !== null
  )
}

/** Renders a turn's ordered text/tool segments interleaved. The trailing text
 *  run carries the streaming caret; if the last segment is instead a tool, a
 *  trailing caret keeps the gap before the next run from looking frozen. Any
 *  `toolCalls` not represented in `segments` (a partially-migrated producer that
 *  set both) still render, so a tool row is never silently dropped. A settled
 *  run of many tool calls collapses into one disclosure — see below. */
function SegmentedBody({
  segments,
  msg,
  streaming,
  renderBody,
  approval,
  onToolCallClick,
  toolRenderers,
  messageClassName,
}: {
  segments: ChatMessageSegment[]
  msg: ChatUiMessage
  streaming: boolean
  renderBody: (content: string) => ReactNode
  approval?: ProposalApprovalHandlers
  onToolCallClick?: (call: ChatToolCallInfo, message: ChatUiMessage) => void
  toolRenderers?: ToolDetailRenderers
  messageClassName: string
}) {
  const lastIndex = segments.length - 1
  const segmentToolIds = new Set(
    segments.flatMap((s) => (s.kind === 'tool' ? [s.call.id] : [])),
  )
  const leftoverToolCalls = (msg.toolCalls ?? []).filter(
    (tc) => !segmentToolIds.has(tc.id),
  )
  // `index` is the row's position WITHIN its group, so a run of six steps
  // cascades once instead of every group in the turn sharing one clock. The
  // index is stable to take from the map because segments only ever APPEND: a
  // row already on screen keeps the position it arrived at.
  const renderToolCard = (call: ChatToolCallInfo, index: number) => (
    <ToolCallCard
      key={`tool-${call.id}`}
      call={call}
      message={msg}
      approval={approval}
      onOpenRun={onToolCallClick}
      renderers={toolRenderers}
      staggerIndex={index}
    />
  )
  // Group consecutive tool segments so a SETTLED run of many tool calls (a
  // multi-step turn, e.g. workflow authoring) collapses into one disclosure
  // instead of flooding the transcript with a card per step. While the turn is
  // streaming nothing is grouped — live tool activity is exactly what the user
  // wants to watch; the run collapses once the turn settles. Text runs (the
  // actual answer) always render in full.
  const groups: Array<
    | { kind: 'text'; index: number; content: string }
    | { kind: 'tools'; index: number; calls: ChatToolCallInfo[] }
  > = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (!seg) continue
    if (seg.kind === 'text') {
      groups.push({ kind: 'text', index: i, content: seg.content })
    } else {
      const last = groups[groups.length - 1]
      if (last && last.kind === 'tools') last.calls.push(seg.call)
      else groups.push({ kind: 'tools', index: i, calls: [seg.call] })
    }
  }

  // ONE flat child list rather than a wrapper element per group, because React
  // identity is per PARENT: a call the producer reports in `toolCalls` before
  // the segment carrying it arrives starts life in `leftoverToolCalls` and later
  // lands in a `tool` segment, and a change of parent is an unmount plus a mount
  // — the row replays its entrance although the reader has been watching it for
  // seconds. Flat, every card is a sibling keyed on its call id, so that
  // migration is a re-order at worst and usually not even that (segments append,
  // and a leftover sits at the end, which is exactly where its segment lands).
  // The outer `gap-2` is what the removed per-group wrapper supplied, so the
  // layout is byte-for-byte what it was.
  const children: ReactNode[] = []
  for (const g of groups) {
    if (g.kind === 'text') {
      children.push(
        <SegmentText
          // Segments only ever append within a turn, so the index is a stable
          // key — a finalized run keeps its slot as later runs/tools are added,
          // so its smooth-text state isn't reset.
          key={`text-${g.index}`}
          content={g.content}
          // Only the trailing run of the live turn types out + shows the caret.
          streaming={streaming && g.index === lastIndex}
          showCaret={streaming && g.index === lastIndex}
          renderBody={renderBody}
          messageClassName={messageClassName}
        />,
      )
      continue
    }
    if (
      !streaming &&
      g.calls.length >= COLLAPSE_TOOL_RUN_AT &&
      !g.calls.some(isImportantTool)
    ) {
      // The fold is a quiet disclosure line, not a filled box — the canonical
      // rows inside it carry the row chrome.
      //
      // Deliberately still a `<details>` and NOT `.agent-disclose`: a closed
      // `<details>` gives its children no box at all, so their `.agent-arrive`
      // has not run yet and the run genuinely cascades on the click that
      // reveals it. `.agent-disclose` keeps the subtree laid out and merely
      // clipped, which would spend the arrival behind a zero height and open
      // onto rows that were already there. The reasoning box is the opposite
      // case — it is open while the model thinks, so what has to animate there
      // is the HEIGHT.
      //
      // The key names the FOLD, not the group: folded and unfolded are two
      // different elements for one group, and one key over two element types is
      // how React is told to tear a subtree down and rebuild it — replaying the
      // entrance of every row in it.
      children.push(
        <details key={`tools-fold-${g.index}`}>
          <summary className="cursor-pointer select-none rounded-md px-1 py-0.5 text-xs font-medium text-muted-foreground [transition:color_var(--motion-control)] hover:text-foreground">
            Worked through {g.calls.length} steps
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {g.calls.map(renderToolCard)}
          </div>
        </details>,
      )
      continue
    }
    g.calls.forEach((call, index) => children.push(renderToolCard(call, index)))
  }
  leftoverToolCalls.forEach((call, index) => children.push(renderToolCard(call, index)))
  if (streaming && segments[lastIndex]?.kind === 'tool') {
    children.push(<StreamingCaret key="streaming-caret" />)
  }

  return <div className="flex flex-col gap-2">{children}</div>
}

// ── Quiet chrome ────────────────────────────────────────────────────────────

/** The quiet chrome's per-row meta lane: a fixed ~18px strip that always
 *  reserves its height (so the reveal is pure opacity — zero layout shift) and
 *  fades in on row hover/focus-within, staying visible on touch via
 *  `@media (hover: none)`. The fade is reduced-motion-guarded. */
const QUIET_META_LANE_CLASS =
  'mt-1 flex h-[18px] items-center gap-2 text-[11px] tracking-wide text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100'

/** The text a copy of the message should carry: the ordered text runs when the
 *  turn is segmented (they render in place of `content`), else `content`. */
function copyTextOf(msg: ChatUiMessage): string {
  const textRuns = msg.segments?.filter((s) => s.kind === 'text') ?? []
  if (textRuns.length > 0) return textRuns.map((s) => s.content).join('\n\n')
  return msg.content
}

/** Copies the message's plain text; swaps to a check for a beat on success.
 *  Quiet chrome only — labeled mode's meta line is information, not action. */
function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    [],
  )
  const copy = () => {
    const clipboard = navigator.clipboard
    if (!clipboard) return
    void clipboard.writeText(text).then(
      () => {
        setCopied(true)
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), 1200)
      },
      () => {},
    )
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy message"
      title="Copy message"
      className="rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

function AssistantMessageImpl({
  msg,
  streaming,
  models,
  agentLabel,
  renderBody,
  approval,
  onToolCallClick,
  toolRenderers,
  renderExtras,
  durableCards,
  resolveAttachmentUrl,
  workProductCards,
  messageClassName,
  chrome,
}: {
  msg: ChatUiMessage
  streaming: boolean
  models: CatalogModel[]
  agentLabel: string
  renderBody: (content: string) => ReactNode
  approval?: ProposalApprovalHandlers
  onToolCallClick?: (call: ChatToolCallInfo, message: ChatUiMessage) => void
  toolRenderers?: ToolDetailRenderers
  renderExtras?: (message: ChatUiMessage) => ReactNode
  durableCards?: Omit<DurableChatCardsProps, 'parts' | 'renderMarkdown'>
  resolveAttachmentUrl?: (part: ChatAttachmentPart) => string
  workProductCards?: { onOpen?: (part: WorkProductPersistedPart) => void }
  messageClassName: string
  chrome: 'labeled' | 'quiet'
}) {
  // Smooth reveal: chunky network slabs (model bursts, flush windows, replay
  // polls) paint as a continuous typewriter. Reasoning often arrives as one
  // burst right before the answer — smoothing makes it visibly type out in
  // the open thinking box instead of popping in and collapsing.
  const content = useSmoothText(msg.content, streaming)
  const reasoning = useSmoothText(msg.reasoning ?? '', streaming)
  // The smooth reveal re-renders on every rAF frame while streaming, but the
  // FLOORED visible length only advances every few frames — re-parsing markdown
  // each frame is wasted work on the hot path. Memo on (renderBody, content) so
  // the parse runs only when the visible text actually changes.
  const body = useMemo(() => renderBody(content), [renderBody, content])
  // When a turn is segmented, render the ordered text/tool runs interleaved;
  // otherwise fall back to the single content body + trailing tool group.
  const segments = msg.segments
  // "Has the answer started?" — true once any answer text exists, whether the
  // producer puts it in `content` (legacy) or in a text `segment`. Drives the
  // reasoning box (open while still thinking, the thinking timer, the summary
  // label), so a segmented message with `content: ''` doesn't read as
  // perpetually "Thinking…" after its answer segments are visible.
  const hasAnswerText =
    content !== '' ||
    (segments?.some((s) => s.kind === 'text' && s.content.trim() !== '') ??
      false)
  const reasoningScrollRef = useRef<HTMLDivElement>(null)
  // Measure visible thinking time: first reasoning reveal → first answer text.
  const thinkStartRef = useRef<number | null>(null)
  const thinkMsRef = useRef<number | null>(null)
  if (streaming && reasoning && !hasAnswerText && thinkStartRef.current === null) {
    thinkStartRef.current = performance.now()
  }
  if (
    hasAnswerText &&
    thinkStartRef.current !== null &&
    thinkMsRef.current === null
  ) {
    thinkMsRef.current = performance.now() - thinkStartRef.current
  }
  useEffect(() => {
    const el = reasoningScrollRef.current
    if (el && streaming && !hasAnswerText) el.scrollTop = el.scrollHeight
  }, [reasoning, streaming, hasAnswerText])
  // Live seconds while the model is reasoning before its answer starts, so a
  // long thinking gap shows progress rather than a static "Thinking…".
  const thinkingSeconds = useThinkingSeconds(
    streaming && !!reasoning && !hasAnswerText,
  )
  const reasoningId = useId()
  // Open while the model is still thinking, closed once the answer starts —
  // and a click outranks that default from then on. `<details open={…}>` could
  // not express the second half: React re-asserts the attribute on every
  // render, so a reader who opened the box mid-stream had it shut again by the
  // next frame of tokens.
  const [reasoningToggled, setReasoningToggled] = useState<boolean | null>(null)
  const reasoningOpen = reasoningToggled ?? !hasAnswerText

  const quiet = chrome === 'quiet'
  return (
    <div className={`mx-auto w-full max-w-3xl px-6 ${quiet ? 'group pb-1 pt-3' : 'py-3'}`}>
      {!quiet && (
        <div className="mb-1 flex items-baseline gap-2 text-[11px] tracking-wide text-muted-foreground">
          <span className="font-semibold uppercase">{agentLabel}</span>
          {msg.modelUsed && <span className="font-mono normal-case">{msg.modelUsed}</span>}
          {formatTokensPerSecond(msg) && <span>{formatTokensPerSecond(msg)}</span>}
          {formatModelCost(msg, models) && <span>{formatModelCost(msg, models)}</span>}
        </div>
      )}
      {reasoning && (
        // A button + `.agent-disclose` rather than `<details>`: a native
        // disclosure has no transition to give, so the trace SNAPPED to full
        // height the moment the answer arrived — the single largest layout jump
        // in a turn, at the exact moment the reader is trying to start reading.
        // The grid row animates the content's REAL height (0fr → 1fr), which a
        // max-height guess cannot do without either clipping a long trace or
        // easing toward a number it never reaches. The keyboard contract
        // `<details>` supplied for free is restated explicitly: a real
        // `<button>` (Enter/Space, focusable, in the tab order) carrying
        // `aria-expanded` and `aria-controls` — which also announces the state
        // that a `<summary>` leaves to the browser.
        <div className="mb-2 rounded-lg border-l-2 border-border bg-secondary px-3 py-2">
          <button
            type="button"
            onClick={() => setReasoningToggled(!reasoningOpen)}
            aria-expanded={reasoningOpen}
            aria-controls={reasoningId}
            // `transition-colors`/`transition-transform` carry TAILWIND's
            // duration and curve (150ms, its own cubic-bezier), not this
            // package's — a component that writes its own timing is the defect
            // `docs/product-surfaces.md` Pattern 4 rejects. The label reads
            // `--motion-control` (the token for a colour change) and the chevron
            // reads `--motion-surface`, the SAME pair `.agent-disclose` runs its
            // grid row on, so the arrow and the panel it points at travel
            // together instead of on two clocks.
            className="flex w-full select-none items-center gap-1.5 text-left text-xs font-medium text-muted-foreground [transition:color_var(--motion-control)] hover:text-foreground"
          >
            <ChevronDown className={`h-3 w-3 shrink-0 [transition:transform_var(--motion-surface)] ${reasoningOpen ? '' : '-rotate-90'}`} />
            {!hasAnswerText ? (
              // A pulse dims the whole word on a loop, which is the same cue a
              // skeleton placeholder uses — it reads as "nothing here yet". A
              // sweep travels THROUGH the glyphs, which reads as work in
              // flight, and the elapsed seconds say how much. `essential`
              // because it is the only signal separating a working agent from
              // a stuck one — and `essential` is an exemption from the blanket
              // floor, never a licence to sweep forever at someone who asked
              // for less motion: under `prefers-reduced-motion` tokens.css
              // stops this animation and holds the label in a static state
              // (full-strength text under a dotted rule) that a settled label
              // still does not have.
              <span className="agent-shimmer" data-motion="essential">
                Thinking{thinkingSeconds >= 1 ? ` · ${thinkingSeconds}s` : '…'}
              </span>
            ) : thinkMsRef.current != null ? (
              `Thought for ${Math.max(1, Math.round(thinkMsRef.current / 1000))}s`
            ) : (
              'Thought process'
            )}
          </button>
          <div className="agent-disclose" data-open={reasoningOpen ? 'true' : 'false'}>
            {/* The single child `.agent-disclose` clips. The scroller is its
                child rather than itself, so `overflow-hidden` from the grid rule
                and `overflow-y-auto` from the trace's own cap never contend for
                the same element. `inert` restores the last thing `<details>`
                gave for free: a collapsed trace is genuinely gone — not read by
                a screen reader, not hit by find-in-page — rather than merely
                clipped to nothing.

                It is emitted only when it must be ON. `inert={!open}` reads
                correctly and is wrong on React 18, which this package's peer
                range admits: React 18 does not know the attribute, writes
                `inert="false"` through verbatim, and HTML reads any value as
                inert — so the OPEN panel would be the unfocusable one. See
                `./inert`. */}
            <div {...inertProps(!reasoningOpen)}>
              <div
                id={reasoningId}
                ref={reasoningScrollRef}
                className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground"
              >
                {reasoning}
              </div>
            </div>
          </div>
        </div>
      )}
      {segments && segments.length > 0 ? (
        <SegmentedBody
          segments={segments}
          msg={msg}
          streaming={streaming}
          renderBody={renderBody}
          approval={approval}
          onToolCallClick={onToolCallClick}
          toolRenderers={toolRenderers}
          messageClassName={messageClassName}
        />
      ) : (
        <>
          <div className={messageClassName}>
            {body}
            {streaming && content && !msg.toolCalls?.length && <StreamingCaret />}
          </div>
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              {msg.toolCalls.map((tc, index) => (
                <ToolCallCard
                  key={tc.id}
                  call={tc}
                  message={msg}
                  approval={approval}
                  onOpenRun={onToolCallClick}
                  renderers={toolRenderers}
                  staggerIndex={index}
                />
              ))}
            </div>
          )}
        </>
      )}
      {durableCards && msg.parts && (
        <DurableChatCards
          {...durableCards}
          parts={msg.parts}
          renderMarkdown={renderBody}
          className="mt-3"
        />
      )}
      {workProductCards &&
        workProductPartsFromMessageParts(msg.parts).map((part) => (
          <WorkProductCard
            key={`${part.ref.id}:${part.ref.version}`}
            part={part}
            onOpen={workProductCards.onOpen}
            className="mt-3"
          />
        ))}
      {renderExtras?.(msg)}
      {resolveAttachmentUrl && attachmentPartsFromMessageParts(msg.parts).length > 0 && (
        <div className="mt-2">
          <MessageAttachments
            parts={attachmentPartsFromMessageParts(msg.parts)}
            resolveFileUrl={resolveAttachmentUrl}
            justify="start"
          />
        </div>
      )}
      {quiet && (
        <div data-testid="message-meta-lane" className={QUIET_META_LANE_CLASS}>
          <CopyMessageButton text={copyTextOf(msg)} />
          {msg.modelUsed && <span className="font-mono">{msg.modelUsed}</span>}
          {formatTokensPerSecond(msg) && <span>{formatTokensPerSecond(msg)}</span>}
          {formatModelCost(msg, models) && <span>{formatModelCost(msg, models)}</span>}
        </div>
      )}
    </div>
  )
}

/**
 * Only the actively-streaming message changes per frame; historical messages
 * are referentially stable. `memo` keeps a stable `AssistantMessage` from
 * re-rendering (and re-running its markdown parse) when a sibling streams —
 * default shallow-equal prop comparison is exactly right here since every prop
 * is referentially stable except the one being streamed.
 */
const AssistantMessage = memo(AssistantMessageImpl)

/** Whole seconds elapsed while `active`, ticking once a second. Powers the live
 *  "thinking" timers (the pre-first-token row and the reasoning box) so a long
 *  thinking gap shows progress instead of a frozen label. Counts from when
 *  `active` first turns true; freezes when it clears. */
export function useThinkingSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!active) return
    // Reset on each (re)activation so a reused component resuming "thinking"
    // counts from 0 rather than showing the prior phase's stale elapsed time.
    setSeconds(0)
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [active])
  return seconds
}

function ThinkingRow({ agentLabel, chrome = 'labeled' }: { agentLabel: string; chrome?: 'labeled' | 'quiet' }) {
  const seconds = useThinkingSeconds(true)
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-3">
      {chrome !== 'quiet' && (
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{agentLabel}</p>
      )}
      <div className="flex items-center gap-2 text-base text-muted-foreground">
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
        </svg>
        Thinking{seconds >= 3 ? ` · ${seconds}s` : '...'}
      </div>
    </div>
  )
}

/** Top-level turn-failure row with an optional Retry — the affordance a failed
 *  stream otherwise lacks (the turn just stopped). */
function StreamErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-3">
      <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
        <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4m0 4h.01" />
        </svg>
        <span className="min-w-0 flex-1 break-words">{message}</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className={`shrink-0 rounded border border-destructive/40 bg-card px-2 py-0.5 text-[11px] font-medium text-destructive transition hover:bg-destructive/10 ${POPOVER_OPTION_FOCUS}`}
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The message thread: one centered column; user messages are right-aligned
 * bubbles with a User label; agent messages carry an Agent meta line with
 * model id, tokens/sec, and cost, plus a collapsible thinking section and
 * tool rows. `chrome="quiet"` opts into the label-free variant: the
 * label/meta row becomes a hover-revealed meta lane under each row.
 */
export function ChatMessages({
  messages,
  messageSize = 'default',
  chrome = 'labeled',
  models = [],
  renderMarkdown,
  renderExtras,
  durableCards,
  userLabel = 'User',
  agentLabel = 'Agent',
  loading,
  approval,
  onToolCallClick,
  toolRenderers,
  error,
  onRetry,
  renderEmpty,
  emptyState,
  header,
  resolveAttachmentUrl,
  workProductCards,
}: ChatMessagesProps) {
  const messageClassName =
    messageSize === 'large'
      ? 'agent-app-message-copy text-[17px] leading-[1.75]'
      : 'agent-app-message-copy text-base leading-[1.75]'
  // Stabilize the fallback renderer's identity so it doesn't change every
  // render — otherwise the memoized `AssistantMessage` (and its per-frame body
  // memo) would invalidate on every parent render when no `renderMarkdown` is
  // supplied.
  const renderBody = useMemo(
    () => renderMarkdown ?? ((content: string) => <p className="whitespace-pre-wrap">{content}</p>),
    [renderMarkdown],
  )
  const lastIsUser = messages[messages.length - 1]?.role === 'user'
  const quiet = chrome === 'quiet'
  if (messages.length === 0 && !loading && !error) {
    // Explicit renderEmpty wins (incl. `() => null` to opt out); otherwise show
    // the branded first-run state instead of a blank thread.
    const empty = renderEmpty ? renderEmpty() : <ChatEmptyState {...emptyState} />
    return (
      <>
        {header}
        {empty}
      </>
    )
  }
  return (
    <>
      {header}
      {messages.map((msg) =>
        msg.role === 'user' ? (
          <div key={msg.id} className={`mx-auto w-full max-w-3xl px-6 ${quiet ? 'group pb-1 pt-3' : 'py-3'}`}>
            <div className={`ml-auto w-fit ${quiet ? 'max-w-[72%]' : 'max-w-[85%]'}`}>
              {!quiet && (
                <p className="mb-1 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {userLabel}
                </p>
              )}
              <div
                className={
                  quiet
                    ? `rounded-2xl bg-[color-mix(in_srgb,hsl(var(--secondary))_65%,hsl(var(--background)))] px-4 py-2.5 ${messageClassName}`
                    : `rounded-2xl rounded-tr-md bg-primary/10 px-4 py-2.5 ${messageClassName}`
                }
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
              {resolveAttachmentUrl && attachmentPartsFromMessageParts(msg.parts).length > 0 && (
                <div className="mt-1.5">
                  <MessageAttachments
                    parts={attachmentPartsFromMessageParts(msg.parts)}
                    resolveFileUrl={resolveAttachmentUrl}
                    justify="end"
                  />
                </div>
              )}
            </div>
            {quiet && (
              <div data-testid="message-meta-lane" className={`${QUIET_META_LANE_CLASS} justify-end`}>
                <CopyMessageButton text={msg.content} />
              </div>
            )}
          </div>
        ) : (
          <AssistantMessage
            key={msg.id}
            msg={msg}
            streaming={!!loading && msg.id === messages[messages.length - 1]?.id}
            models={models}
            agentLabel={agentLabel}
            renderBody={renderBody}
            approval={approval}
            onToolCallClick={onToolCallClick}
            toolRenderers={toolRenderers}
            renderExtras={renderExtras}
            durableCards={durableCards}
            resolveAttachmentUrl={resolveAttachmentUrl}
            workProductCards={workProductCards}
            messageClassName={messageClassName}
            chrome={chrome}
          />
        ),
      )}
      {loading && lastIsUser && <ThinkingRow agentLabel={agentLabel} chrome={chrome} />}
      {error && !loading && <StreamErrorRow message={error} onRetry={onRetry} />}
    </>
  )
}
