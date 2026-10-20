/** Tool result adaptation, approval cards, and expanded run-row details. */
import { useState, type ReactNode } from 'react'
import { TerminalDisplay, TerminalLine } from '@tangle-network/ui/primitives'
import { InlineToolItem } from '@tangle-network/ui/run'
import type { ToolPart } from '@tangle-network/ui/types'
import { ChevronDown, POPOVER_OPTION_FOCUS, usePending } from './controls'
import { useArrivalStyle } from './motion'
import type { ChatToolCallInfo, ChatUiMessage, ChatMessageSegment, ChatNoticeTone, ProposalApprovalHandlers, ToolDetailRenderers } from './chat-message-types'

/** Extract `{proposalId, status}` from a tool outcome when it is a proposal
 *  awaiting human approval; null otherwise. */
export function pendingApprovalOf(call: ChatToolCallInfo): { proposalId: string } | null {
  const outcome = call.result as { ok?: boolean; result?: { status?: string; proposalId?: string } } | undefined
  if (!outcome?.ok || outcome.result?.status !== 'queued_for_approval' || !outcome.result.proposalId) return null
  return { proposalId: outcome.result.proposalId }
}

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
export function toolCallFailed(call: ChatToolCallInfo): boolean {
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
 *  — nothing here is baked to a specific product's proposal type. When the agent
 *  wrote no summary, the preview is the proposal's TYPE slug rendered mono —
 *  never a "type: title" derivation, which restated the title the card header
 *  already carries. Returns nulls when there's nothing meaningful to preview. */
function proposalPreview(call: ChatToolCallInfo): { summary: string | null; meta: string[]; typeSlug: string | null } {
  const a = (call.args ?? {}) as Record<string, unknown>
  const asString = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null
  const asList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => (typeof x === 'string' ? x : null)).filter((x): x is string => !!x)
      : asString(v)
        ? [asString(v) as string]
        : []

  // The verb: only a free-form summary the agent actually wrote.
  const verbPhrase = asString(a.summary) ?? asString(a.description) ?? null

  const destinations = [
    ...asList(a.destinations),
    ...asList(a.channels),
    ...asList(a.targets),
    ...asList(a.platforms),
  ]
  const dest = destinations.length ? ` to ${destinations.join(' and ')}` : ''
  const summary = verbPhrase ? `${verbPhrase}${dest}` : destinations.length ? `Publish to ${destinations.join(' and ')}` : null
  // No authored summary: the raw type slug (`asset_publish`) says what kind of
  // action this is without duplicating the header's "Approve: {title}?".
  const typeSlug = summary === null ? asString(a.type) : null

  // Cost / reach: surfaced when the data carries it, formatted lightly.
  const meta: string[] = []
  const cost = a.cost ?? a.price ?? a.estimatedCost
  if (typeof cost === 'number' && cost > 0) meta.push(`~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`)
  else if (asString(cost)) meta.push(asString(cost) as string)
  const reach = a.reach ?? a.audience ?? a.estimatedReach
  if (typeof reach === 'number' && reach > 0) meta.push(`reaches ~${reach.toLocaleString()}`)
  else if (asString(reach)) meta.push(asString(reach) as string)

  return { summary, meta, typeSlug }
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
          <dt className="font-mono text-xs text-muted-foreground">{k}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
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
    <TerminalDisplay showHeader={false} autoScroll={false} maxHeight="14rem" className="text-xs">
      <TerminalLine type="command">{String(call.args?.command ?? '')}</TerminalLine>
      {r.exitCode != null && <TerminalLine type={r.exitCode === 0 ? 'success' : 'error'}>exit {r.exitCode}</TerminalLine>}
      <TerminalLine type={outcome?.ok === false ? 'error' : 'output'}>
        {outcome?.ok === false ? (outcome.message ?? 'failed') : [r.stdout, r.stderr].filter(Boolean).join('\n') || '(no output)'}
      </TerminalLine>
    </TerminalDisplay>
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
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Called with</p>
          <KvRows data={call.args} />
        </div>
      )}
      {envelope ? (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {envelope.ok === false ? 'Failed' : 'Result'}
          </p>
          {envelope.ok === false ? (
            <p className="text-xs text-destructive">{envelope.message ?? 'Tool failed'}</p>
          ) : envelope.result && typeof envelope.result === 'object' ? (
            <KvRows data={envelope.result as Record<string, unknown>} />
          ) : envelope.result != null ? (
            <p className="font-mono text-xs text-muted-foreground">{truncate(envelope.result)}</p>
          ) : null}
        </div>
      ) : result != null ? (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Result</p>
          <p className="font-mono text-xs text-muted-foreground">{truncate(result)}</p>
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
  const { summary, meta, typeSlug } = proposalPreview(call)
  const custom = renderers?.[call.name]?.(call, message)
  const { pending: deciding, run: decide } = usePending()

  return (
    <div className="w-full max-w-full rounded-xl border border-warning/50 bg-warning/[0.06] text-sm shadow-sm ring-1 ring-warning/10">
      <div className="flex items-start gap-2.5 px-4 pt-3.5">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
          <ToolGlyph name={call.name} className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          {/* Without handlers the card is read-only: the eyebrow reports the
              state ("Awaiting approval") instead of demanding an action the
              viewer cannot take, and the footer adds no second note. */}
          <p className="text-xs font-semibold uppercase tracking-[0.05em] text-warning-strong">
            {approval ? 'Needs your approval' : 'Awaiting approval'}
          </p>
          <p className="mt-0.5 text-[15px] font-semibold leading-snug text-foreground">{friendlyToolTitle(call)}</p>
          {summary && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{summary}</p>}
          {typeSlug && <p className="mt-1 font-mono text-xs text-muted-foreground">{typeSlug}</p>}
          {meta.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {meta.map((m, i) => (
                <span key={i} className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5 pt-3">
        {approval && (
          <>
            <button
              type="button"
              disabled={deciding}
              onClick={() => decide(() => approval.onApprove(pending.proposalId, call.id))}
              className="inline-flex min-h-[40px] flex-1 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none sm:min-w-[160px]"
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

/** "Mon, Jun 22 · 9:00 AM" for an ISO timestamp; anything unparseable renders
 *  as written — a producer's "Tomorrow 9am" is already human copy. The raw
 *  value stays on the row's `title` for the exact instant. */
function formatFollowupWhen(when: string): string {
  const date = new Date(when)
  if (Number.isNaN(date.getTime())) return when
  const day = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${time}`
}

/** A scheduled follow-up — a pending, time-based intent, not a decision and not
 *  a completed action (audit finding #5). Re-skinned onto the shared run-row
 *  geometry (full width, 24px icon chip, xs title, `when` in the description
 *  slot) so it reads as a sibling of the canonical tool rows; it is not a tool
 *  invocation, so the row does not expand. It carries the same trailing status
 *  cue its siblings do (spinner while the schedule call is in flight, a settled
 *  dot after), and a FAILED schedule keeps the follow-up identity — the clock —
 *  with the failure reported in place instead of falling back to a generic
 *  tool row. */
function FollowupCard({ call }: { call: ChatToolCallInfo }) {
  const a = (call.args ?? {}) as Record<string, unknown>
  const when = typeof a.when === 'string' ? a.when : typeof a.at === 'string' ? a.at : typeof a.schedule === 'string' ? a.schedule : null
  const failed = toolCallFailed(call)
  const errorText = failed ? (toolOutcomeOf(call)?.message ?? 'Scheduling failed') : null
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--md3-surface-container)]">
        <div className="flex w-full items-center gap-2.5 px-3 py-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-border bg-muted text-muted-foreground">
            <ToolGlyph name={call.name} className="h-3.5 w-3.5" />
          </span>
          <span className="shrink-0 whitespace-nowrap text-xs font-medium text-foreground">{friendlyToolTitle(call)}</span>
          {when && (
            <span title={when} className="hidden min-w-0 flex-1 truncate font-mono text-xs tabular-nums text-muted-foreground sm:inline">
              {formatFollowupWhen(when)}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {call.status === 'running' ? (
              <svg className="h-3 w-3 shrink-0 animate-spin text-[var(--accent-text)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
              </svg>
            ) : (
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-[var(--surface-danger-text)]' : 'bg-[var(--surface-success-text)]'}`} />
            )}
          </span>
        </div>
        {errorText && (
          <div className="border-t border-border px-3 py-2 text-xs text-[var(--surface-danger-text)]">{errorText}</div>
        )}
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

export function ToolCallCard({
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
  // from a tool invocation. A FAILED schedule keeps the row too (destructive
  // dot + error subline) rather than falling through to the generic tool row
  // and losing the clock identity.
  if (kind === 'followup') {
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
            aria-label="Open full transcript"
            title="Open full transcript"
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M7 17 17 7" />
              <path d="M7 7h10v10" />
            </svg>
          </button>
        ) : undefined
      }
    />,
  )
}
