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

export * from './chat-stream'
export * from './provider-logo'
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
  /** The tool outcome (`{ok, result}` shape). When `result.status` is
   *  'queued_for_approval' the chip renders the approval state. */
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
  /** Make tool chips clickable (e.g. open a {@link RunDrillIn} panel). */
  onToolCallClick?: (call: ChatToolCallInfo, message: ChatUiMessage) => void
}

export interface ProposalApprovalHandlers {
  onApprove: (proposalId: string, toolCallId: string) => void | Promise<void>
  onReject: (proposalId: string, toolCallId: string) => void | Promise<void>
}

function ToolChips({
  toolCalls,
  approval,
  onClick,
}: {
  toolCalls: ChatToolCallInfo[]
  approval?: ProposalApprovalHandlers
  onClick?: (call: ChatToolCallInfo) => void
}) {
  return (
    <div className="mt-2 flex flex-col gap-1">
      {toolCalls.map((tc) => {
        const pending = tc.status === 'done' ? pendingApprovalOf(tc) : null
        if (pending) {
          return (
            <div
              key={tc.id}
              className="inline-flex w-fit items-center gap-2 rounded-md bg-amber-500/10 px-2.5 py-1 text-xs text-amber-700"
            >
              <span className="font-mono opacity-70">⏸</span>
              <span className="font-medium">{tc.name}</span>
              <span className="opacity-60">awaiting approval</span>
              {approval && (
                <span className="ml-1 inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => approval.onApprove(pending.proposalId, tc.id)}
                    className="rounded bg-green-600/90 px-2 py-0.5 text-[11px] font-semibold text-white transition hover:bg-green-600"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => approval.onReject(pending.proposalId, tc.id)}
                    className="rounded border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground transition hover:bg-accent/30"
                  >
                    Reject
                  </button>
                </span>
              )}
            </div>
          )
        }
        const Tag = onClick ? 'button' : 'div'
        return (
          <Tag
            key={tc.id}
            {...(onClick ? { type: 'button' as const, onClick: () => onClick(tc) } : {})}
            className={`inline-flex w-fit items-center gap-2 rounded-md px-2.5 py-1 text-xs ${
              tc.status === 'running'
                ? 'bg-yellow-500/10 text-yellow-700'
                : tc.status === 'error'
                  ? 'bg-red-500/10 text-red-700'
                  : 'bg-green-500/10 text-green-700'
            } ${onClick ? 'cursor-pointer transition hover:ring-1 hover:ring-border' : ''}`}
          >
            <span className="font-mono opacity-70">{tc.status === 'running' ? '⚡' : tc.status === 'error' ? '✗' : '✓'}</span>
            <span className="font-medium">{tc.name}</span>
            <span className="opacity-60">{tc.status === 'running' ? 'running…' : tc.status === 'error' ? 'failed' : 'done'}</span>
          </Tag>
        )
      })}
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
          <div key={msg.id} className="mx-auto w-full max-w-3xl px-6 py-3">
            <div className="mb-1 flex items-baseline gap-2 text-[11px] tracking-wide text-muted-foreground/60">
              <span className="font-semibold uppercase">{agentLabel}</span>
              {msg.modelUsed && <span className="font-mono normal-case">{msg.modelUsed}</span>}
              {formatTokensPerSecond(msg) && <span>{formatTokensPerSecond(msg)}</span>}
              {formatModelCost(msg, models) && <span>{formatModelCost(msg, models)}</span>}
            </div>
            {msg.reasoning && (
              <details
                className="mb-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2"
                open={!msg.content}
              >
                <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
                  {msg.content ? 'Thinking…' : 'Thinking'}
                  {!msg.content && <span className="ml-1 inline-block animate-pulse">●</span>}
                </summary>
                <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground/80">
                  {msg.reasoning}
                </div>
              </details>
            )}
            <div className="text-base leading-[1.75]">{renderBody(msg.content)}</div>
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <ToolChips
                toolCalls={msg.toolCalls}
                approval={approval}
                onClick={onToolCallClick ? (tc) => onToolCallClick(tc, msg) : undefined}
              />
            )}
            {renderExtras?.(msg)}
          </div>
        ),
      )}
      {loading && lastIsUser && (
        <div className="mx-auto w-full max-w-3xl px-6 py-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">{agentLabel}</p>
          <div className="flex items-center gap-2 text-base text-muted-foreground">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
            </svg>
            Thinking...
          </div>
        </div>
      )}
    </>
  )
}
