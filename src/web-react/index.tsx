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

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ProviderLogo } from './provider-logo'
import { useSmoothText } from './smooth-text'

export * from './chat-stream'
export * from './provider-logo'
export * from './smooth-text'
export * from './mission-activity'
export * from './sandbox-terminal'
export * from './seat-paywall'
import type { CatalogModel } from '../runtime/model-catalog'

// ── shared glyphs (no icon-library dependency) ────────────────────────────

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function SearchGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function SparkleGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </svg>
  )
}

/** Close an absolutely-positioned popover on outside mousedown. */
function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  })
  return ref
}

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

// ── ModelPicker ───────────────────────────────────────────────────────────

export interface ModelPickerProps {
  value: string
  onChange: (id: string) => void
  /** Catalogue models — from `GET`ing the app's catalogue route (see
   *  `runtime/model-catalog`), plus any product-specific entries appended. */
  models: CatalogModel[]
  loading?: boolean
  /** Render a provider logo/badge; default is a generic sparkle. */
  renderProviderBadge?: (provider: string) => ReactNode
  /** Section label for `featured` models. */
  recommendedLabel?: string
}

function formatPrice(p?: string): string | undefined {
  if (!p) return undefined
  const n = Number(p)
  if (isNaN(n) || n === 0) return undefined
  const perM = n * 1_000_000
  return perM >= 1 ? `$${perM.toFixed(0)}/M` : `$${perM.toFixed(2)}/M`
}

function formatContext(len?: number): string | undefined {
  if (!len) return undefined
  if (len >= 1_000_000) return `${(len / 1_000_000).toFixed(1)}M ctx`
  if (len >= 1_000) return `${Math.round(len / 1_000)}K ctx`
  return `${len} ctx`
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  )
}

function ModelRow({
  model,
  selected,
  onSelect,
  renderProviderBadge,
}: {
  model: CatalogModel
  selected: boolean
  onSelect: () => void
  renderProviderBadge?: (provider: string) => ReactNode
}) {
  const price = formatPrice(model.pricing?.prompt)
  const ctx = formatContext(model.contextLength)
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm transition ${
        selected ? 'bg-primary/10 font-medium' : 'hover:bg-accent/30'
      }`}
    >
      {renderProviderBadge ? renderProviderBadge(model.provider) : <ProviderLogo provider={model.provider} size={16} />}
      <span className="truncate">{model.name}</span>
      {!model.supportsTools && (
        <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          no tools
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {ctx && <span>{ctx}</span>}
        {price && <span>{price}</span>}
      </span>
    </button>
  )
}

/**
 * Searchable model picker pill + popover: a featured/recommended section
 * first, then per-provider groups in catalogue order (the server already
 * sorts providers by tier).
 */
export function ModelPicker({ value, onChange, models, loading, renderProviderBadge, recommendedLabel = 'Recommended' }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useClickOutside(() => setOpen(false))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const selected = models.find((m) => m.id === value)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        (m.description?.toLowerCase() ?? '').includes(q) ||
        m.provider.toLowerCase().includes(q),
    )
  }, [models, query])

  const sections = useMemo(() => {
    const recommended = models.filter((m) => m.featured)
    const byProvider: Array<{ provider: string; items: CatalogModel[] }> = []
    for (const m of models) {
      if (m.featured) continue
      const last = byProvider[byProvider.length - 1]
      if (last && last.provider === m.provider) last.items.push(m)
      else byProvider.push({ provider: m.provider, items: [m] })
    }
    return { recommended, byProvider }
  }, [models])

  const select = (id: string) => {
    onChange(id)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent/30"
      >
        {selected ? (renderProviderBadge ? renderProviderBadge(selected.provider) : <ProviderLogo provider={selected.provider} size={16} />) : <SparkleGlyph className="h-3.5 w-3.5 text-muted-foreground" />}
        <span className="max-w-[160px] truncate">{selected?.name ?? value}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-[420px] overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <div className="border-b border-border px-3 py-2">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
              <SearchGlyph className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models..."
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <div className="max-h-[400px] overflow-y-auto p-1 pb-2">
            {loading && <div className="px-3 py-4 text-center text-sm text-muted-foreground">Loading models...</div>}
            {!loading && filtered && (
              <>
                {filtered.length === 0 && (
                  <div className="px-3 py-4 text-center text-sm text-muted-foreground">No models match your search</div>
                )}
                {filtered.map((m) => (
                  <ModelRow key={m.id} model={m} selected={m.id === value} onSelect={() => select(m.id)} renderProviderBadge={renderProviderBadge} />
                ))}
              </>
            )}
            {!loading && !filtered && (
              <>
                {sections.recommended.length > 0 && (
                  <>
                    <SectionHeader>{recommendedLabel}</SectionHeader>
                    {sections.recommended.map((m) => (
                      <ModelRow key={m.id} model={m} selected={m.id === value} onSelect={() => select(m.id)} renderProviderBadge={renderProviderBadge} />
                    ))}
                  </>
                )}
                {sections.byProvider.map((g) => (
                  <div key={g.provider}>
                    <SectionHeader>{g.provider}</SectionHeader>
                    {g.items.map((m) => (
                      <ModelRow key={m.id} model={m} selected={m.id === value} onSelect={() => select(m.id)} renderProviderBadge={renderProviderBadge} />
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── EffortPicker ──────────────────────────────────────────────────────────

const EFFORT_LEVELS = [
  { id: 'off', label: 'Off' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
] as const

export interface EffortPickerProps {
  value: string
  onChange: (id: string) => void
}

/** Reasoning-effort selector pill, styled to match {@link ModelPicker}. Show
 *  it only when the selected model `supportsReasoning`. */
export function EffortPicker({ value, onChange }: EffortPickerProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useClickOutside(() => setOpen(false))
  const selected = EFFORT_LEVELS.find((l) => l.id === value) ?? EFFORT_LEVELS[2]

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Reasoning effort"
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent/30"
      >
        <SparkleGlyph className="h-3.5 w-3.5 text-muted-foreground" />
        <span>{selected.label}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-36 overflow-hidden rounded-xl border border-border bg-card p-1 shadow-lg">
          {EFFORT_LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => {
                onChange(l.id)
                setOpen(false)
              }}
              className={`flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition ${
                l.id === value ? 'bg-primary/10 font-medium' : 'hover:bg-accent/30'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
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
            run.status === 'running' ? 'bg-yellow-500' : run.status === 'error' ? 'bg-red-500' : 'bg-green-500'
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
              <span className={`font-mono text-[11px] ${step.status === 'error' ? 'text-red-600' : 'text-muted-foreground'}`}>
                {step.status === 'error' ? '✗' : '$'}
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{step.label}</code>
              <span className="shrink-0 text-[10px] text-muted-foreground/60">
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
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground/60">
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

export interface ChatUiMessage extends ChatMessageMetrics {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  reasoning?: string
  toolCalls?: ChatToolCallInfo[]
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

/** Human title for a call, derived from its real arguments. */
function friendlyToolTitle(call: ChatToolCallInfo): string {
  const a = call.args ?? {}
  switch (call.name) {
    case 'submit_proposal':
      return `Proposal · ${String(a.type ?? '')}${a.title ? `: ${String(a.title)}` : ''}`
    case 'sandbox_create':
      return `Create sandbox (${String(a.environment ?? 'universal')})`
    case 'sandbox_run_command':
      return `$ ${String(a.command ?? '')}`
    case 'sandbox_destroy':
      return `Destroy sandbox ${String(a.sandbox_id ?? '')}`
    case 'schedule_followup':
      return `Follow-up · ${String(a.title ?? '')}`
    case 'render_ui':
      return `Render view · ${String(a.title ?? '')}`
    case 'add_citation':
      return `Citation · ${String(a.path ?? '')}`
    default:
      return call.name
  }
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
          <dt className="font-mono text-[11px] text-muted-foreground/70">{k}</dt>
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
          <span className={r.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}>exit {r.exitCode}</span>
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
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/50">Called with</p>
          <KvRows data={call.args} />
        </div>
      )}
      {outcome && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/50">
            {outcome.ok === false ? 'Failed' : 'Result'}
          </p>
          {outcome.ok === false ? (
            <p className="text-xs text-red-600">{outcome.message ?? 'Tool failed'}</p>
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
  const failed = call.status === 'error' || toolOutcomeOf(call)?.ok === false
  const custom = renderers?.[call.name]?.(call, message)

  return (
    <div
      className={`w-fit min-w-[280px] max-w-full rounded-lg border text-xs transition ${
        pending
          ? 'border-amber-300/60 bg-amber-500/5'
          : failed
            ? 'border-red-300/60 bg-red-500/5'
            : 'border-border/60 bg-muted/20'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            call.status === 'running'
              ? 'animate-pulse bg-yellow-500'
              : pending
                ? 'bg-amber-500'
                : failed
                  ? 'bg-red-500'
                  : 'bg-green-500'
          }`}
        />
        <ToolGlyph name={call.name} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{friendlyToolTitle(call)}</span>
        {pending && approval && (
          <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => approval.onApprove(pending.proposalId, call.id)}
              className="rounded bg-green-600/90 px-2 py-0.5 text-[11px] font-semibold text-white transition hover:bg-green-600"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => approval.onReject(pending.proposalId, call.id)}
              className="rounded border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground transition hover:bg-accent/30"
            >
              Reject
            </button>
          </span>
        )}
        <span className="shrink-0 text-[11px] text-muted-foreground/70">
          {call.status === 'running' ? 'running…' : pending ? 'awaiting approval' : failed ? 'failed' : 'done'}
        </span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
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

function AssistantMessage({
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
  const reasoningScrollRef = useRef<HTMLDivElement>(null)
  // Measure visible thinking time: first reasoning reveal → first answer text.
  const thinkStartRef = useRef<number | null>(null)
  const thinkMsRef = useRef<number | null>(null)
  if (streaming && reasoning && !content && thinkStartRef.current === null) {
    thinkStartRef.current = performance.now()
  }
  if (content && thinkStartRef.current !== null && thinkMsRef.current === null) {
    thinkMsRef.current = performance.now() - thinkStartRef.current
  }
  useEffect(() => {
    const el = reasoningScrollRef.current
    if (el && streaming && !content) el.scrollTop = el.scrollHeight
  }, [reasoning, streaming, content])

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-3">
      <div className="mb-1 flex items-baseline gap-2 text-[11px] tracking-wide text-muted-foreground/60">
        <span className="font-semibold uppercase">{agentLabel}</span>
        {msg.modelUsed && <span className="font-mono normal-case">{msg.modelUsed}</span>}
        {formatTokensPerSecond(msg) && <span>{formatTokensPerSecond(msg)}</span>}
        {formatModelCost(msg, models) && <span>{formatModelCost(msg, models)}</span>}
      </div>
      {reasoning && (
        <details className="mb-2 rounded-lg border-l-2 border-border/70 bg-muted/20 px-3 py-2" open={!content}>
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
            {!content ? (
              <span className="animate-pulse">Thinking…</span>
            ) : thinkMsRef.current != null ? (
              `Thought for ${Math.max(1, Math.round(thinkMsRef.current / 1000))}s`
            ) : (
              'Thought process'
            )}
          </summary>
          <div ref={reasoningScrollRef} className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground/70">
            {reasoning}
          </div>
        </details>
      )}
      <div className="text-base leading-[1.75]">
        {renderBody(content)}
        {streaming && content && !msg.toolCalls?.length && (
          <span className="ml-0.5 inline-block h-[1.1em] w-[3px] translate-y-[2px] animate-pulse rounded-sm bg-foreground/70" aria-hidden />
        )}
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
      {renderExtras?.(msg)}
    </div>
  )
}

function ThinkingRow({ agentLabel }: { agentLabel: string }) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-3">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">{agentLabel}</p>
      <div className="flex items-center gap-2 text-base text-muted-foreground">
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
        </svg>
        Thinking{seconds >= 3 ? ` · ${seconds}s` : '...'}
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
}: ChatMessagesProps) {
  const renderBody = renderMarkdown ?? ((content: string) => <p className="whitespace-pre-wrap">{content}</p>)
  const lastIsUser = messages[messages.length - 1]?.role === 'user'
  return (
    <>
      {messages.map((msg) =>
        msg.role === 'user' ? (
          <div key={msg.id} className="mx-auto w-full max-w-3xl px-6 py-3">
            <div className="ml-auto w-fit max-w-[85%]">
              <p className="mb-1 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
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
    </>
  )
}
