/**
 * InteractionPlanCard — the plan-approval round-trip card (kind:"plan",
 * claude-code plan mode). The plan itself arrives as markdown in
 * `interaction.body`; the answerSpec is producer-defined, so fields render
 * generically — a free-text field doubles as the rejection-feedback input.
 * Approve POSTs outcome:"accepted", Request changes POSTs outcome:"declined"
 * with any typed feedback.
 *
 * Markdown is injected (`renderMarkdown`, matching the rest of `web-react`);
 * without it the plan body falls back to pre-wrapped plain text. Pure data +
 * callbacks: no fetch inside the component.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatInteraction, ChatInteractionStatus, InteractionData } from './chat-interactions'
import { fieldAcceptsFreeText, isTerminalInteractionStatus } from './chat-interactions'
import {
  buildAnswerData,
  fieldAnswer,
  interactionStatusLabels,
  interactionTerminalNotes,
  isLateAnswerableStatus,
  type FieldValues,
  type SubmitInteractionAnswer,
} from './interaction-card-support'
import { InteractionActionButton, InteractionBadge } from './interaction-question-card'

function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function ChevronDownGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export interface InteractionPlanCardProps {
  interaction: ChatInteraction
  /** Viewer-vs-editor gate: false renders everything read-only. */
  canWrite: boolean
  /** POST one resolution to the product's answer route (see
   *  `createInteractionAnswerSubmitter`). */
  submitAnswer: SubmitInteractionAnswer
  /** Fired when this card resolves locally (approved/rejected, or discovered
   *  expired via a 410) so the stream/route state stays in sync. */
  onResolved?: (id: string, status: Exclude<ChatInteractionStatus, 'pending'>) => void
  /** Fired when the user asks the agent to re-submit an expired/withdrawn plan
   *  as a new chat turn. Receives the interaction so a callback shared across
   *  cards (e.g. via DurableChatCards) knows which plan fired. Return/resolve
   *  `false` (or throw) to report the send failed and keep the affordance
   *  retryable. Omit to hide it entirely. */
  onReRequest?: (interaction: ChatInteraction) => boolean | void | Promise<boolean | void>
  /** Overrides the default re-request button label
   *  ("Ask agent to re-submit the plan" — gtm's exact current copy). */
  reRequestLabel?: string
  /** Renders the plan body (markdown). Falls back to pre-wrapped plain text. */
  renderMarkdown?: (markdown: string) => ReactNode
  className?: string
}

const STATUS_LABELS = interactionStatusLabels({
  pending: 'Waiting for your approval',
  answered: 'Approved',
  declined: 'Rejected',
})

const TERMINAL_NOTES = interactionTerminalNotes('plan', {
  declined: 'The agent was asked to revise the plan.',
})

const DEFAULT_RE_REQUEST_LABEL = 'Ask agent to re-submit the plan'

/** Body height (px) beyond which the plan collapses behind a "Show full plan"
 *  control so a long plan doesn't dominate the transcript. */
const COLLAPSED_MAX_HEIGHT = 320

export function InteractionPlanCard({
  interaction,
  canWrite,
  submitAnswer,
  onResolved,
  onReRequest,
  reRequestLabel,
  renderMarkdown,
  className,
}: InteractionPlanCardProps) {
  const [values, setValues] = useState<FieldValues>({})
  const [expanded, setExpanded] = useState(false)
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | 'requesting' | null>(null)
  // Terminal state this card learned locally (resolved / 410) before the
  // stream part catches up. A terminal stream status always wins.
  const [localStatus, setLocalStatus] = useState<Exclude<ChatInteractionStatus, 'pending'> | null>(null)
  const [reRequested, setReRequested] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitInFlightRef = useRef(false)

  const status: ChatInteractionStatus = isTerminalInteractionStatus(interaction.status)
    ? interaction.status
    : localStatus ?? interaction.status
  const reRequestable = isLateAnswerableStatus(status) && onReRequest !== undefined
  const canReRequest = canWrite && reRequestable && !reRequested
  const disabled = !canWrite || status !== 'pending' || submitting !== null

  // Approve sends whatever the producer's answerSpec requires; an empty or
  // all-optional spec still approves with `data: {}` (the sidecar validates
  // fail-closed either way).
  const approveData = useMemo(() => buildAnswerData(interaction.fields, values), [interaction.fields, values])
  // Reject carries only the values actually typed/picked — feedback is
  // optional, so unanswered fields are simply omitted.
  const rejectData = useMemo(() => {
    const data: InteractionData = {}
    for (const field of interaction.fields) {
      const answer = fieldAnswer(field, values)
      if (answer !== null) data[field.name] = answer
    }
    return data
  }, [interaction.fields, values])

  async function submit(outcome: 'accepted' | 'declined') {
    const data = outcome === 'accepted' ? approveData : rejectData
    if (submitInFlightRef.current || disabled || data === null) return
    submitInFlightRef.current = true
    setSubmitting(outcome === 'accepted' ? 'approve' : 'reject')
    setError(null)
    try {
      const result = await submitAnswer({ id: interaction.id, outcome, data })
      if (result.ok) {
        const resolved = outcome === 'accepted' ? 'answered' : 'declined'
        setLocalStatus(resolved)
        onResolved?.(interaction.id, resolved)
        return
      }
      if (result.expired) {
        setLocalStatus('expired')
        onResolved?.(interaction.id, 'expired')
        return
      }
      setError(result.message)
    } finally {
      submitInFlightRef.current = false
      setSubmitting(null)
    }
  }

  async function requestReSubmission() {
    if (submitInFlightRef.current || !canReRequest || !onReRequest) return
    submitInFlightRef.current = true
    setSubmitting('requesting')
    setError(null)
    let accepted: boolean | void
    try {
      accepted = await onReRequest(interaction)
    } catch {
      accepted = false
    } finally {
      submitInFlightRef.current = false
      setSubmitting(null)
    }
    if (accepted === false) {
      setError('The re-request was not sent. Try again.')
      return
    }
    setReRequested(true)
  }

  const terminalNote = TERMINAL_NOTES[status]
  const approved = status === 'answered'

  return (
    <div className={`rounded-xl border border-border bg-card p-4 shadow-sm ${className ?? ''}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <InteractionBadge variant="outline">Plan</InteractionBadge>
          <InteractionBadge variant={approved ? 'default' : status === 'expired' || status === 'declined' ? 'destructive' : 'outline'}>
            {STATUS_LABELS[status]}
          </InteractionBadge>
        </div>
        <span className="text-xs text-muted-foreground">The agent proposed a plan</span>
      </div>

      {interaction.title.trim() && (
        <p className="mb-3 text-sm font-medium leading-5 text-foreground">{interaction.title}</p>
      )}

      {interaction.body && (
        <div className="relative">
          <div
            className="overflow-hidden text-sm text-foreground"
            style={expanded ? undefined : { maxHeight: COLLAPSED_MAX_HEIGHT }}
          >
            {renderMarkdown
              ? renderMarkdown(interaction.body)
              : <p className="whitespace-pre-wrap leading-5">{interaction.body}</p>}
          </div>
          {!expanded && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />
          )}
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDownGlyph className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            {expanded ? 'Collapse plan' : 'Show full plan'}
          </button>
        </div>
      )}

      {interaction.fields.length > 0 && (
        <div className="mt-3 space-y-4">
          {interaction.fields.map((field) => (
            <fieldset key={field.name} className="space-y-2">
              <p className="text-sm font-medium leading-5 text-foreground">{field.label}</p>
              {fieldAcceptsFreeText(field) ? (
                <textarea
                  value={values[field.name]?.text ?? ''}
                  disabled={disabled}
                  aria-label={field.label}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [field.name]: { ...prev[field.name], text: event.target.value } }))}
                  rows={2}
                  placeholder={field.type === 'text' ? field.placeholder ?? 'Optional feedback for the agent' : undefined}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
                />
              ) : (
                <input
                  type="text"
                  value={values[field.name]?.text ?? ''}
                  disabled={disabled}
                  aria-label={field.label}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [field.name]: { ...prev[field.name], text: event.target.value } }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
                />
              )}
            </fieldset>
          ))}
        </div>
      )}

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      {terminalNote && <p className="mt-3 text-xs text-muted-foreground">{terminalNote}</p>}

      {canReRequest && (
        <div className="mt-4 flex items-center justify-end">
          <InteractionActionButton variant="outline" onClick={() => void requestReSubmission()} disabled={submitting !== null}>
            {submitting === 'requesting' ? 'Asking…' : reRequestLabel ?? DEFAULT_RE_REQUEST_LABEL}
          </InteractionActionButton>
        </div>
      )}
      {reRequested && (
        <div className="mt-4 flex items-center justify-end">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><CheckGlyph className="h-3 w-3" />Re-submission requested</span>
        </div>
      )}

      {status === 'pending' && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <InteractionActionButton variant="outline" onClick={() => void submit('declined')} disabled={disabled}>
            {submitting === 'reject' ? 'Sending…' : 'Request changes'}
          </InteractionActionButton>
          <InteractionActionButton onClick={() => void submit('accepted')} disabled={disabled || approveData === null}>
            {submitting === 'approve' ? 'Approving…' : 'Approve plan'}
          </InteractionActionButton>
        </div>
      )}
      {approved && (
        <div className="mt-4 flex items-center justify-end">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><CheckGlyph className="h-3 w-3" />Approved</span>
        </div>
      )}
    </div>
  )
}
