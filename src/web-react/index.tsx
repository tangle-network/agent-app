/**
 * `@tangle-network/agent-app/web-react` — the shared chat-shell components
 * every agent app's web UI hand-rolls: a model picker over the runtime's
 * model catalogue, a reasoning-effort selector, and a message thread with
 * User/Agent identity, per-message model + cost + tokens/sec metrics, tool
 * chips, and a collapsible thinking section.
 *
 * Works for BOTH chat shapes: router-backed copilots (LoopEvents from
 * `runtime/openai-stream`) and sandbox-backed chats — the thread renders
 * `ChatUiMessage`s; how they're produced is the app's business.
 *
 * Styling contract: Tailwind classes against the shared design tokens
 * (`bg-card`, `border-border`, `text-muted-foreground`, `bg-primary`, …) that
 * Tangle app shells define. No icon library — the few glyphs are inline SVGs.
 * Markdown and provider logos are injected (`renderMarkdown`,
 * `renderProviderBadge`) so this package stays dependency-free beyond React.
 */

import { useEffect, useMemo, useRef, useState, memo, type ReactNode } from 'react'
import { useSmoothText } from './smooth-text'
import { ChevronDown, POPOVER_OPTION_FOCUS, usePending } from './controls'
import { BrandMark } from './brand-mark'

export * from './chat-stream'
export * from './provider-logo'
export * from './smooth-text'
export * from './mission-activity'
export * from './sandbox-terminal'
export * from './workspace-terminal-panel'
export * from './seat-paywall'
export {
  usePopover,
  usePending,
  ModelPicker,
  EffortPicker,
  DEFAULT_EFFORT_LEVELS,
  type ModelPickerProps,
  type EffortPickerProps,
  type EffortLevel,
} from './controls'
export {
  AgentSessionControls,
  type AgentSessionControlsProps,
} from './agent-session-controls'
import type { CatalogModel } from '../runtime/model-catalog'

// ── metrics helpers ───────────────────────────────────────────────────────

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
    <div className="fixed inset-y-0 right-0 z-50 flex w-[480px] max-w-full flex-col border-l border-border bg-card shadow-xl">
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
          className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent/30 hover:text-foreground"
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
          <div key={i} className="rounded-lg border border-border/60 bg-background">
            <div className="flex items-baseline gap-2 border-b border-border/40 px-3 py-1.5">
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
 *  is rendered in order — interleaving text and tool chips — so the agent's
 *  pre- and post-tool reasoning reads chronologically instead of as one text
 *  blob with the tool chips collected after it. */
export type ChatMessageSegment =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; call: ChatToolCallInfo }

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
}

export interface ChatMessagesProps {
  messages: ChatUiMessage[]
  /** Catalogue models, for per-message cost from pricing. Pass [] to skip cost. */
  models?: CatalogModel[]
  /** Markdown renderer for assistant content; default renders pre-wrapped text. */
  renderMarkdown?: (content: string) => ReactNode
  /** Extra per-message content (artifacts, custom panels) appended after the body. */
  renderExtras?: (message: ChatUiMessage) => ReactNode
  userLabel?: string
  agentLabel?: string
  /** Render the trailing "agent is thinking" row. */
  loading?: boolean
  /** Approve/Reject handlers for proposals awaiting approval. When omitted the
   *  chip still shows "awaiting approval" but without action buttons. */
  approval?: ProposalApprovalHandlers
  /** Open a full-transcript view (e.g. {@link RunDrillIn}) from a tool card. */
  onToolCallClick?: (call: ChatToolCallInfo, message: ChatUiMessage) => void
  /** Per-tool custom detail renderers for expanded tool cards. */
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
}

/** One starting "door" in the chat first-run state — a concrete, labeled action
 *  (start from a template, do it by hand, ask the agent), not a placeholder. */
export interface ChatEmptyDoor {
  label: string
  description?: string
  onSelect: () => void
}

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
              className="group flex min-h-[44px] flex-col items-start rounded-xl border border-border bg-card px-4 py-3 text-left transition hover:border-primary/40 hover:bg-accent/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
  const outcome = toolOutcomeOf(call)
  return (
    <div className="space-y-2">
      {call.args && Object.keys(call.args).length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Called with</p>
          <KvRows data={call.args} />
        </div>
      )}
      {outcome && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {outcome.ok === false ? 'Failed' : 'Result'}
          </p>
          {outcome.ok === false ? (
            <p className="text-xs text-destructive">{outcome.message ?? 'Tool failed'}</p>
          ) : outcome.result && typeof outcome.result === 'object' ? (
            <KvRows data={outcome.result} />
          ) : (
            <p className="font-mono text-[11px] text-muted-foreground">{truncate(outcome.result)}</p>
          )}
        </div>
      )}
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
          <p className="text-[10px] font-semibold uppercase tracking-wider text-warning-foreground">Needs your approval</p>
          <p className="mt-0.5 text-[15px] font-semibold leading-snug text-foreground">{friendlyToolTitle(call)}</p>
          {summary && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{summary}</p>}
          {meta.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {meta.map((m, i) => (
                <span key={i} className="rounded-full bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
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
              className="inline-flex min-h-[40px] flex-1 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none sm:min-w-[160px]"
            >
              Approve &amp; run
            </button>
            <button
              type="button"
              disabled={deciding}
              onClick={() => decide(() => approval.onReject(pending.proposalId, call.id))}
              className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent/30 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-60"
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
          className="ml-auto inline-flex items-center gap-1 rounded text-[12px] font-medium text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
 *  a completed action (audit finding #5). Quiet left-rule card with a clock. */
function FollowupCard({ call }: { call: ChatToolCallInfo }) {
  const a = (call.args ?? {}) as Record<string, unknown>
  const when = typeof a.when === 'string' ? a.when : typeof a.at === 'string' ? a.at : typeof a.schedule === 'string' ? a.schedule : null
  return (
    <div className="w-fit min-w-[260px] max-w-full rounded-lg border border-border/60 border-l-2 border-l-primary/60 bg-muted/20 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <ToolGlyph name={call.name} className="h-3.5 w-3.5 shrink-0 text-primary/80" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{friendlyToolTitle(call)}</span>
      </div>
      {when && <p className="mt-0.5 pl-[22px] text-[12px] text-muted-foreground">{when}</p>}
    </div>
  )
}

function ToolCallCard({
  call,
  message,
  approval,
  onOpenRun,
  renderers,
}: {
  call: ChatToolCallInfo
  message: ChatUiMessage
  approval?: ProposalApprovalHandlers
  onOpenRun?: (call: ChatToolCallInfo, message: ChatUiMessage) => void
  renderers?: ToolDetailRenderers
}) {
  const [expanded, setExpanded] = useState(false)
  const pending = call.status === 'done' ? pendingApprovalOf(call) : null
  const kind = blockKindOf(call)
  const failed = call.status === 'error' || toolOutcomeOf(call)?.ok === false
  const custom = renderers?.[call.name]?.(call, message)

  // A proposal awaiting approval is a pending DECISION, not a tool chip — it
  // gets its own prominent card with primary Approve / quiet Reject.
  if (pending) {
    return (
      <ProposalCard
        call={call}
        message={message}
        pending={pending}
        approval={approval}
        renderers={renderers}
      />
    )
  }
  // A scheduled follow-up is a time-based intent — distinct from a tool chip.
  if (kind === 'followup' && !failed) {
    return <FollowupCard call={call} />
  }

  // A command chip reads as a past-tense action; its command text is monospace
  // (audit finding #1 minor). Everything else is a generic tool step. Both share
  // one card shape so the transcript reads as a worklog, not a flat list.
  const isCommand = kind === 'command'
  return (
    <div
      className={`w-fit min-w-[280px] max-w-full rounded-lg border text-xs transition ${
        failed ? 'border-destructive/40 bg-destructive/5' : 'border-border/60 bg-muted/20'
      }`}
    >
      {/* Header is a flex row, NOT a button, so any controls are siblings of the
          expand toggle rather than nested inside it (axe: nested-interactive). */}
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              call.status === 'running' ? 'animate-pulse bg-warning' : failed ? 'bg-destructive' : 'bg-success'
            }`}
          />
          <ToolGlyph name={call.name} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span
            className={`min-w-0 flex-1 truncate ${
              isCommand ? 'font-mono text-[12px] tracking-tight text-foreground/90' : 'font-medium'
            }`}
          >
            {friendlyToolTitle(call)}
          </span>
        </button>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {call.status === 'running' ? 'running…' : failed ? 'failed' : 'done'}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Collapse details' : 'Expand details'}
          aria-expanded={expanded}
          className="shrink-0 rounded p-0.5 focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {expanded && (
        <div className="border-t border-border/40 px-3 py-2.5">
          {custom ?? (call.name === 'sandbox_run_command' ? <ShellDetail call={call} /> : <DefaultToolDetail call={call} />)}
          {onOpenRun && call.name.startsWith('sandbox_') && (
            <button
              type="button"
              onClick={() => onOpenRun(call, message)}
              className="mt-2 rounded border border-border bg-card px-2 py-1 text-[11px] font-medium transition hover:bg-accent/30"
            >
              Open full transcript →
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The blinking insertion caret shown at the end of streaming answer text.
 *  Shared by the segmented and legacy branches so their streaming cue can't
 *  visually diverge. */
function StreamingCaret() {
  return (
    <span
      className="ml-0.5 inline-block h-[1.1em] w-[3px] translate-y-[2px] animate-pulse rounded-sm bg-foreground/70"
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
}: {
  content: string
  streaming: boolean
  showCaret: boolean
  renderBody: (content: string) => ReactNode
}) {
  const text = useSmoothText(content, streaming)
  const body = useMemo(() => renderBody(text), [renderBody, text])
  // An empty / whitespace-only run paints a blank line-height gap — render
  // nothing, UNLESS it's the live trailing run (showCaret), where it still
  // carries the caret so the turn doesn't look frozen. (Hooks run first, so
  // this stays rules-of-hooks safe.)
  if (!content.trim() && !showCaret) return null
  return (
    <div className="text-base leading-[1.75]">
      {body}
      {/* Gate on showCaret (not the smoothed `text`, which is '' on the first
          frame) so the caret is steady from the start instead of flickering. */}
      {showCaret && <StreamingCaret />}
    </div>
  )
}

/** Renders a turn's ordered text/tool segments interleaved. The trailing text
 *  run carries the streaming caret; if the last segment is instead a tool, a
 *  trailing caret keeps the gap before the next run from looking frozen. Any
 *  `toolCalls` not represented in `segments` (a partially-migrated producer that
 *  set both) still render, so a tool chip is never silently dropped. */
function SegmentedBody({
  segments,
  msg,
  streaming,
  renderBody,
  approval,
  onToolCallClick,
  toolRenderers,
}: {
  segments: ChatMessageSegment[]
  msg: ChatUiMessage
  streaming: boolean
  renderBody: (content: string) => ReactNode
  approval?: ProposalApprovalHandlers
  onToolCallClick?: (call: ChatToolCallInfo, message: ChatUiMessage) => void
  toolRenderers?: ToolDetailRenderers
}) {
  const lastIndex = segments.length - 1
  const segmentToolIds = new Set(
    segments.flatMap((s) => (s.kind === 'tool' ? [s.call.id] : [])),
  )
  const leftoverToolCalls = (msg.toolCalls ?? []).filter(
    (tc) => !segmentToolIds.has(tc.id),
  )
  const renderToolCard = (call: ChatToolCallInfo) => (
    <ToolCallCard
      key={`tool-${call.id}`}
      call={call}
      message={msg}
      approval={approval}
      onOpenRun={onToolCallClick}
      renderers={toolRenderers}
    />
  )
  return (
    <div className="flex flex-col gap-2">
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          <SegmentText
            // Segments only ever append within a turn, so the index is a stable
            // key — a finalized run keeps its slot as later runs/tools are added,
            // so its smooth-text state isn't reset.
            key={`text-${i}`}
            content={seg.content}
            // Only the trailing run of the live turn types out + shows the caret.
            streaming={streaming && i === lastIndex}
            showCaret={streaming && i === lastIndex}
            renderBody={renderBody}
          />
        ) : (
          renderToolCard(seg.call)
        ),
      )}
      {leftoverToolCalls.map(renderToolCard)}
      {streaming && segments[lastIndex]?.kind === 'tool' && <StreamingCaret />}
    </div>
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

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-3">
      <div className="mb-1 flex items-baseline gap-2 text-[11px] tracking-wide text-muted-foreground">
        <span className="font-semibold uppercase">{agentLabel}</span>
        {msg.modelUsed && <span className="font-mono normal-case">{msg.modelUsed}</span>}
        {formatTokensPerSecond(msg) && <span>{formatTokensPerSecond(msg)}</span>}
        {formatModelCost(msg, models) && <span>{formatModelCost(msg, models)}</span>}
      </div>
      {reasoning && (
        <details className="mb-2 rounded-lg border-l-2 border-border/70 bg-muted/20 px-3 py-2" open={!hasAnswerText}>
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
            {!hasAnswerText ? (
              <span className="animate-pulse">
                Thinking{thinkingSeconds >= 3 ? ` · ${thinkingSeconds}s` : '…'}
              </span>
            ) : thinkMsRef.current != null ? (
              `Thought for ${Math.max(1, Math.round(thinkMsRef.current / 1000))}s`
            ) : (
              'Thought process'
            )}
          </summary>
          <div ref={reasoningScrollRef} className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
            {reasoning}
          </div>
        </details>
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
        />
      ) : (
        <>
          <div className="text-base leading-[1.75]">
            {body}
            {streaming && content && !msg.toolCalls?.length && <StreamingCaret />}
          </div>
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              {msg.toolCalls.map((tc) => (
                <ToolCallCard
                  key={tc.id}
                  call={tc}
                  message={msg}
                  approval={approval}
                  onOpenRun={onToolCallClick}
                  renderers={toolRenderers}
                />
              ))}
            </div>
          )}
        </>
      )}
      {renderExtras?.(msg)}
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

function ThinkingRow({ agentLabel }: { agentLabel: string }) {
  const seconds = useThinkingSeconds(true)
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-3">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{agentLabel}</p>
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
 * tool-call chips.
 */
export function ChatMessages({
  messages,
  models = [],
  renderMarkdown,
  renderExtras,
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
}: ChatMessagesProps) {
  // Stabilize the fallback renderer's identity so it doesn't change every
  // render — otherwise the memoized `AssistantMessage` (and its per-frame body
  // memo) would invalidate on every parent render when no `renderMarkdown` is
  // supplied.
  const renderBody = useMemo(
    () => renderMarkdown ?? ((content: string) => <p className="whitespace-pre-wrap">{content}</p>),
    [renderMarkdown],
  )
  const lastIsUser = messages[messages.length - 1]?.role === 'user'
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
          <div key={msg.id} className="mx-auto w-full max-w-3xl px-6 py-3">
            <div className="ml-auto w-fit max-w-[85%]">
              <p className="mb-1 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {userLabel}
              </p>
              <div className="rounded-2xl rounded-tr-md bg-primary/10 px-4 py-2.5 text-base leading-relaxed">
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
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
          />
        ),
      )}
      {loading && lastIsUser && <ThinkingRow agentLabel={agentLabel} />}
      {error && !loading && <StreamErrorRow message={error} onRetry={onRetry} />}
    </>
  )
}
