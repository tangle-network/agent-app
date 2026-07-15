/**
 * InteractionQuestionCard — the agent-ask card every sandbox-backed chat UI
 * forked (~1,000 lines each in gtm/legal/tax). Renders the answerSpec
 * verbatim: selects (radio/checkbox by `multi`, write-in row only when the
 * sidecar granted `allowCustom`), free text, and minimal number/boolean/secret
 * inputs for open kinds.
 *
 * Behavior lifted from the gtm-agent fork (the most fix-absorbed):
 *   - a terminal stream status always wins over local optimistic state,
 *   - a 410 from the answer route flips the card to the same dead state a
 *     cancel event produces (never a raw error),
 *   - expired/withdrawn asks stay answerable: the answer is delivered as a NEW
 *     chat turn via `onLateAnswer` (secret-bearing asks are blocked from that
 *     path),
 *   - one submit in flight at a time; a failed/timed-out submit stays
 *     retryable.
 *
 * Pure data + callbacks: no fetch inside the component. Products bind the wire
 * via `createInteractionAnswerSubmitter` (or any `SubmitInteractionAnswer`).
 */

import { useMemo, useRef, useState } from 'react'
import type {
  ChatInteraction,
  ChatInteractionField,
  ChatInteractionStatus,
  ChatSelectField,
} from './chat-interactions'
import { isTerminalInteractionStatus } from './chat-interactions'
import {
  buildAnswerData,
  hasSecretField,
  interactionStatusLabels,
  interactionTerminalNotes,
  isLateAnswerableStatus,
  lateAnswerMessage,
  type FieldValues,
  type SubmitInteractionAnswer,
} from './interaction-card-support'

// ── glyphs + primitives (no icon-library / UI-kit dependency) ───────────────

function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export type InteractionBadgeVariant = 'outline' | 'default' | 'destructive'

const BADGE_VARIANT_CLASSES: Record<InteractionBadgeVariant, string> = {
  outline: 'border-border text-foreground',
  default: 'border-transparent bg-primary text-primary-foreground',
  destructive: 'border-transparent bg-destructive/15 text-destructive',
}

export function InteractionBadge({ variant, children }: { variant: InteractionBadgeVariant; children: string }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${BADGE_VARIANT_CLASSES[variant]}`}>
      {children}
    </span>
  )
}

export function InteractionActionButton({
  variant = 'primary',
  onClick,
  disabled,
  children,
}: {
  variant?: 'primary' | 'outline'
  onClick: () => void
  disabled?: boolean
  children: string
}) {
  const variantClasses = variant === 'primary'
    ? 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90'
    : 'border border-border bg-transparent text-foreground hover:bg-accent/40'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${variantClasses}`}
    >
      {children}
    </button>
  )
}

const FIELD_INPUT_CLASSES =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50'

// ── option rows ─────────────────────────────────────────────────────────────

export interface QuestionOptionListProps {
  /** Radio/checkbox group name — unique per field so selection is isolated. */
  groupName: string
  /** Stable prefix for per-option input ids (label htmlFor pairing). */
  idPrefix: string
  options: ChatSelectField['options']
  /** Checkbox (multi-select) vs radio (single). */
  multi: boolean
  selectedValues: string[]
  disabled: boolean
  onToggle: (value: string) => void
}

/** The radio/checkbox option rows for a select field. Renders a fragment of
 *  option `<label>` rows so a card keeps its own wrapping layout and appends
 *  its own write-in input. */
export function QuestionOptionList({
  groupName,
  idPrefix,
  options,
  multi,
  selectedValues,
  disabled,
  onToggle,
}: QuestionOptionListProps) {
  return (
    <>
      {options.map((option, optionIndex) => {
        const inputId = `${idPrefix}-${optionIndex}`
        const checked = selectedValues.includes(option.value)
        // The whole row is a wrapping <label> for click target, but the input's
        // accessible NAME must be the option label alone — the description is
        // linked as aria-describedby, not folded into the name.
        return (
          <label key={`${option.value}-${optionIndex}`} htmlFor={inputId} className="flex cursor-pointer gap-2 rounded-lg border border-border/70 p-3 transition-colors hover:bg-muted/50">
            <input
              id={inputId}
              type={multi ? 'checkbox' : 'radio'}
              name={groupName}
              value={option.value}
              checked={checked}
              disabled={disabled}
              onChange={() => onToggle(option.value)}
              aria-labelledby={`${inputId}-label`}
              aria-describedby={option.description ? `${inputId}-description` : undefined}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            />
            <span className="min-w-0">
              <span id={`${inputId}-label`} className="block text-sm font-medium leading-5 text-foreground">{option.label}</span>
              {option.description && <span id={`${inputId}-description`} className="mt-0.5 block text-xs leading-5 text-muted-foreground">{option.description}</span>}
            </span>
          </label>
        )
      })}
    </>
  )
}

// ── card ────────────────────────────────────────────────────────────────────

export interface InteractionQuestionCardProps {
  interaction: ChatInteraction
  /** Viewer-vs-editor gate: false renders everything read-only. */
  canWrite: boolean
  /** POST one resolution to the product's answer route (see
   *  `createInteractionAnswerSubmitter`). Never called for late answers. */
  submitAnswer: SubmitInteractionAnswer
  /** Fired when this card resolves locally (answered, or discovered expired
   *  via a 410) so the stream/route state stays in sync. */
  onResolved?: (id: string, status: Exclude<ChatInteractionStatus, 'pending'>) => void
  /** Delivers a late answer (the ask expired/was withdrawn) as a fresh chat
   *  turn. Return/resolve `false` when the send was rejected so the card stays
   *  retryable. Omit to hide the late-answer affordance entirely. */
  onLateAnswer?: (message: string) => boolean | void | Promise<boolean | void>
  className?: string
}

function selectField(field: ChatInteractionField): ChatSelectField | null {
  return field.type === 'select' ? (field as ChatSelectField) : null
}

function valuesWithSelected(values: FieldValues, field: ChatSelectField, optionValue: string): FieldValues {
  const current = values[field.name]?.selected ?? []
  let selected = [optionValue]
  if (field.multi === true) {
    selected = current.includes(optionValue)
      ? current.filter((item) => item !== optionValue)
      : [...current, optionValue]
  }
  return { ...values, [field.name]: { ...values[field.name], selected } }
}

const STATUS_LABELS = interactionStatusLabels({
  pending: 'Waiting for your answer',
  answered: 'Answered',
  declined: 'Declined',
})

const TERMINAL_NOTES = interactionTerminalNotes('question', {
  expired: 'The original run ended. Answer now to send a new message with this context.',
  cancelled: 'The agent withdrew this question. Answer now to send a new message with this context.',
})

export function InteractionQuestionCard({
  interaction,
  canWrite,
  submitAnswer,
  onResolved,
  onLateAnswer,
  className,
}: InteractionQuestionCardProps) {
  const [values, setValues] = useState<FieldValues>({})
  const [submitting, setSubmitting] = useState(false)
  // Terminal state this card learned locally (submit success / 410) before the
  // stream part catches up. A terminal stream status always wins.
  const [localStatus, setLocalStatus] = useState<Exclude<ChatInteractionStatus, 'pending'> | null>(null)
  const [lateAnswerSent, setLateAnswerSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitInFlightRef = useRef(false)

  const status: ChatInteractionStatus = isTerminalInteractionStatus(interaction.status)
    ? interaction.status
    : localStatus ?? interaction.status
  const answered = status === 'answered'
  const lateAnswerable = isLateAnswerableStatus(status) && onLateAnswer !== undefined
  const secretLateAnswerBlocked = lateAnswerable && hasSecretField(interaction.fields)
  const canLateAnswer = canWrite && lateAnswerable && !lateAnswerSent && !secretLateAnswerBlocked
  const disabled = !canWrite || (status !== 'pending' && !canLateAnswer) || submitting
  const answerData = useMemo(() => buildAnswerData(interaction.fields, values), [interaction.fields, values])

  const setFieldValue = (name: string, patch: FieldValues[string]) => {
    setValues((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }))
  }

  const toggleSelected = (field: ChatSelectField, optionValue: string) => {
    setValues((prev) => valuesWithSelected(prev, field, optionValue))
  }

  async function submitLateAnswer() {
    if (submitInFlightRef.current || !canLateAnswer || !onLateAnswer) return
    const data = buildAnswerData(interaction.fields, values)
    if (!data) return
    submitInFlightRef.current = true
    setSubmitting(true)
    setError(null)
    let accepted: boolean | void
    try {
      accepted = await onLateAnswer(lateAnswerMessage(interaction, data))
    } catch {
      accepted = false
    } finally {
      submitInFlightRef.current = false
      setSubmitting(false)
    }
    if (accepted === false) {
      setError('The new message was not sent. Try again from this card.')
      return
    }
    setLateAnswerSent(true)
  }

  async function submit() {
    if (lateAnswerable) {
      await submitLateAnswer()
      return
    }
    if (submitInFlightRef.current || disabled || !answerData) return
    submitInFlightRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitAnswer({ id: interaction.id, outcome: 'accepted', data: answerData })
      if (result.ok) {
        setLocalStatus('answered')
        onResolved?.(interaction.id, 'answered')
        return
      }
      if (result.expired) {
        // The ask is gone (answered elsewhere, timed out, or the session moved
        // on) — flip to the same dead state a cancel event produces.
        setLocalStatus('expired')
        onResolved?.(interaction.id, 'expired')
        return
      }
      setError(result.message)
    } finally {
      submitInFlightRef.current = false
      setSubmitting(false)
    }
  }

  const terminalNote = secretLateAnswerBlocked
    ? 'This question asked for a secret, so it cannot be sent as a new chat message. Ask the agent to request it again.'
    : TERMINAL_NOTES[status]
  const showSubmitButton = status === 'pending' || (canWrite && lateAnswerable && !lateAnswerSent)
  let submitLabel = 'Submit answer'
  if (lateAnswerable) {
    submitLabel = submitting ? 'Sending…' : 'Send as new message'
  } else if (submitting) {
    submitLabel = 'Submitting…'
  }

  return (
    <div className={`rounded-xl border border-border bg-card p-4 shadow-sm ${className ?? ''}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <InteractionBadge variant="outline">Question</InteractionBadge>
          <InteractionBadge variant={answered ? 'default' : status === 'expired' || status === 'declined' ? 'destructive' : 'outline'}>
            {STATUS_LABELS[status]}
          </InteractionBadge>
        </div>
        <span className="text-xs text-muted-foreground">The agent asked for input</span>
      </div>

      {interaction.title.trim() && interaction.fields.every((field) => field.label !== interaction.title) && (
        <p className="mb-3 text-sm font-medium leading-5 text-foreground">{interaction.title}</p>
      )}
      {interaction.body && <p className="mb-3 text-sm leading-5 text-muted-foreground">{interaction.body}</p>}

      <div className="space-y-4">
        {interaction.fields.map((field) => {
          const value = values[field.name] ?? {}
          const select = selectField(field)
          return (
            <fieldset key={field.name} className="space-y-2">
              <p className="text-sm font-medium leading-5 text-foreground">{field.label}</p>
              {select ? (
                <div className="space-y-2">
                  <QuestionOptionList
                    groupName={`${interaction.id}-${field.name}`}
                    idPrefix={`${interaction.id}-${field.name}`}
                    options={select.options}
                    multi={select.multi === true}
                    selectedValues={value.selected ?? []}
                    disabled={disabled}
                    onToggle={(optionValue) => toggleSelected(select, optionValue)}
                  />
                  {select.allowCustom === true && (
                    <input
                      type="text"
                      value={value.custom ?? ''}
                      disabled={disabled}
                      onChange={(event) => setFieldValue(field.name, { custom: event.target.value })}
                      placeholder="Other — type your own answer"
                      aria-label={`Custom answer for ${field.label}`}
                      className={FIELD_INPUT_CLASSES}
                    />
                  )}
                </div>
              ) : field.type === 'boolean' ? (
                <div className="flex gap-4">
                  {(['true', 'false'] as const).map((boolValue) => (
                    <label key={boolValue} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                      <input
                        type="radio"
                        name={`${interaction.id}-${field.name}`}
                        value={boolValue}
                        checked={(value.selected ?? [])[0] === boolValue}
                        disabled={disabled}
                        onChange={() => setFieldValue(field.name, { selected: [boolValue] })}
                        className="h-4 w-4 accent-primary"
                      />
                      {boolValue === 'true' ? 'Yes' : 'No'}
                    </label>
                  ))}
                </div>
              ) : field.type === 'number' ? (
                <input
                  type="number"
                  value={value.text ?? ''}
                  disabled={disabled}
                  aria-label={field.label}
                  onChange={(event) => setFieldValue(field.name, { text: event.target.value })}
                  className={FIELD_INPUT_CLASSES}
                />
              ) : field.type === 'secret' ? (
                <input
                  type="password"
                  value={value.text ?? ''}
                  disabled={disabled}
                  aria-label={field.label}
                  onChange={(event) => setFieldValue(field.name, { text: event.target.value })}
                  placeholder={field.placeholder}
                  className={FIELD_INPUT_CLASSES}
                />
              ) : (
                <textarea
                  value={value.text ?? ''}
                  disabled={disabled}
                  aria-label={field.label}
                  onChange={(event) => setFieldValue(field.name, { text: event.target.value })}
                  rows={3}
                  placeholder={field.type === 'text' ? field.placeholder : undefined}
                  className={FIELD_INPUT_CLASSES}
                />
              )}
            </fieldset>
          )
        })}
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      {terminalNote && <p className="mt-3 text-xs text-muted-foreground">{terminalNote}</p>}

      {showSubmitButton && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <InteractionActionButton onClick={() => void submit()} disabled={disabled || !answerData}>
            {submitLabel}
          </InteractionActionButton>
        </div>
      )}
      {answered && (
        <div className="mt-4 flex items-center justify-end">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><CheckGlyph className="h-3 w-3" />Answered</span>
        </div>
      )}
      {lateAnswerSent && (
        <div className="mt-4 flex items-center justify-end">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><CheckGlyph className="h-3 w-3" />Sent as new message</span>
        </div>
      )}
    </div>
  )
}
