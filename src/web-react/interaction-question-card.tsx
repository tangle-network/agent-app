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

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatInteraction,
  ChatInteractionField,
  ChatInteractionStatus,
  ChatSelectField,
  ChatFreeTextField,
} from './chat-interactions'
import { isTerminalInteractionStatus } from './chat-interactions'
import {
  buildAnswerData,
  fieldValuesFromAnswers,
  hasSecretField,
  interactionStatusLabels,
  interactionTerminalNotes,
  isLateAnswerableStatus,
  lateAnswerMessage,
  settleInteractionSubmit,
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
    : 'border border-border bg-transparent text-foreground hover:bg-accent'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${variantClasses}`}
    >
      {children}
    </button>
  )
}

const FIELD_INPUT_CLASSES =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary disabled:opacity-50'

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
  /** Terminal answered state: the selected rows highlight (primary edge, tint,
   *  trailing check) so the card shows WHAT was answered, not just that it was. */
  answered?: boolean
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
  answered = false,
}: QuestionOptionListProps) {
  return (
    <>
      {options.map((option, optionIndex) => {
        const inputId = `${idPrefix}-${optionIndex}`
        const checked = selectedValues.includes(option.value)
        const highlighted = answered && checked
        // The whole row is a wrapping <label> for click target, but the input's
        // accessible NAME must be the option label alone — the description is
        // linked as aria-describedby, not folded into the name.
        return (
          <label
            key={`${option.value}-${optionIndex}`}
            htmlFor={inputId}
            className={`flex gap-2 rounded-lg border p-3 transition-colors ${
              highlighted ? 'border-primary bg-primary/5' : 'border-strong'
            } ${disabled ? 'cursor-default' : 'cursor-pointer hover:bg-accent'}`}
          >
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
            <span className="min-w-0 flex-1">
              <span id={`${inputId}-label`} className="block text-sm font-medium leading-5 text-foreground">{option.label}</span>
              {option.description && <span id={`${inputId}-description`} className="mt-0.5 block text-xs leading-5 text-muted-foreground">{option.description}</span>}
            </span>
            {highlighted && <CheckGlyph className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
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
  onResolved?: (
    id: string,
    status: Exclude<ChatInteractionStatus, 'pending'>,
    answers?: ChatInteraction['answers'],
  ) => void
  /** Delivers a late answer (the ask expired/was withdrawn) as a fresh chat
   *  turn. Return/resolve `false` when the send was rejected so the card stays
   *  retryable. Omit to hide the late-answer affordance entirely. */
  onLateAnswer?: (message: string) => boolean | void | Promise<boolean | void>
  /** Overrides the kind badge ("Question"). */
  kindLabel?: string
  /** What happens if nobody answers, rendered beside the submit action.
   *
   *  The caller owns both the clock and the copy: this card holds no timer, so a
   *  deadline that counts down re-renders on the caller's cadence rather than
   *  driving one of its own — and the consequence of silence ("the default is
   *  taken", "the run fails") is the host's policy to state, not this card's to
   *  infer. */
  timeoutNote?: ReactNode
  /** Renders `body` as markdown. Omitted, `body` renders as plain text — so a
   *  host that passes authored markdown without this shows its syntax raw.
   *
   *  `body` ONLY. `title` and every `field.label` stay plain strings: a label is
   *  also the input's accessible name (`aria-label`), which has to be text, and
   *  rendering one as nodes would either break that or silently disagree with
   *  what a screen reader announces. Put prose in `body`.
   *
   *  `interaction.body` is untrusted: it arrives off the wire, written by an
   *  agent or whoever authored the ask. This card never injects HTML, but a
   *  renderer that does is an XSS sink — so return React elements, and sanitize
   *  (DOMPurify or equivalent) if you must produce HTML. */
  renderMarkdown?: (markdown: string) => ReactNode
  className?: string
}

function selectField(field: ChatInteractionField): ChatSelectField | null {
  return field.type === 'select' ? (field as ChatSelectField) : null
}

/** The free-text fields, which are the only ones that can carry a length cap. */
function freeTextField(field: ChatInteractionField): ChatFreeTextField | null {
  return field.type === 'text' || field.type === 'secret' ? (field as ChatFreeTextField) : null
}

/** The cap to stop typing at, or `undefined` for an uncapped field. A
 *  non-positive or fractional cap is treated as absent rather than clamping the
 *  field to zero characters — an unanswerable field is worse than an uncapped
 *  one, and the answer route still enforces the real bound. */
function textFieldMaxLength(field: ChatFreeTextField): number | undefined {
  const max = field.maxLength
  return typeof max === 'number' && Number.isInteger(max) && max > 0 ? max : undefined
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
  kindLabel,
  timeoutNote,
  renderMarkdown,
  className,
}: InteractionQuestionCardProps) {
  const [values, setValues] = useState<FieldValues>(() =>
    fieldValuesFromAnswers(interaction.fields, interaction.answers))
  const [submitting, setSubmitting] = useState(false)
  // Terminal state this card learned locally (submit success / 410) before the
  // stream part catches up. A terminal stream status always wins.
  const [localStatus, setLocalStatus] = useState<Exclude<ChatInteractionStatus, 'pending'> | null>(null)
  const [lateAnswerSent, setLateAnswerSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitInFlightRef = useRef(false)
  // The ask this card's state currently belongs to. State, never a ref: it is
  // compared and written during render, and a ref would not be transactional
  // with the resets below. React may abandon a render — the discarded pass's
  // `setValues` would be thrown away while a ref mutation survived it, leaving
  // this guard claiming the reset had happened over the previous ask's answers.
  const [askId, setAskId] = useState(interaction.id)

  // Every answer-bearing piece of state belongs to ONE ask, so being handed the
  // NEXT one starts over. A host can resolve one question and be handed another
  // on the same card instance (a run that re-parks, a queue that advances); left
  // alone, the new question would render with the previous answer already
  // filled in and its terminal chrome still showing — one click from submitting
  // an answer to a question the user never read.
  //
  // Keyed on `id` because `id` IS the ask's identity: a different id is a
  // different question. Re-issuing the same id with different fields is
  // therefore NOT a new ask and deliberately does not reset — an answer already
  // typed against those fields survives. A host that changes what it is asking
  // must change the id; what it may re-send under one id is the answer, which
  // arrives as `answers` and resyncs through the effect below.
  //
  // During render, not in an effect — React's documented "adjusting state when
  // a prop changes" pattern: it re-runs this component immediately with the new
  // state, before committing and before rendering children, so nothing escapes
  // the render phase. An effect would instead commit one frame of the previous
  // answer under the new question before clearing it. `submitting` and
  // `submitInFlightRef` are deliberately NOT reset — they are owned by the
  // in-flight request's `finally`, and clearing them here would let a second
  // submit start while the first is still outstanding.
  //
  // The visible cost: an id that changes WHILE a submit is outstanding leaves
  // the new question reading "Submitting…" and disabled until that request
  // settles. Bounded, because `settleInteractionSubmit` holds the submitter to
  // this card's own deadline rather than trusting it to have one. Preferred to
  // the alternative, since the only way to free the button early is to drop the
  // in-flight guard, and a second submit racing the first is a real bug where a
  // stale label is only a confusing one.
  if (askId !== interaction.id) {
    setAskId(interaction.id)
    setValues(fieldValuesFromAnswers(interaction.fields, interaction.answers))
    setLocalStatus(null)
    setLateAnswerSent(false)
    setError(null)
  }

  useEffect(() => {
    if (!interaction.answers) return
    setValues(fieldValuesFromAnswers(interaction.fields, interaction.answers))
  }, [interaction.answers, interaction.fields])

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
      const result = await settleInteractionSubmit(() =>
        submitAnswer({ id: interaction.id, outcome: 'accepted', data: answerData }),
      )
      if (result.ok) {
        setLocalStatus('answered')
        onResolved?.(interaction.id, 'answered', answerData)
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
  // Only while the ask is still open. The note says what happens if nobody
  // answers, which stops being true the moment somebody has — and a resolved
  // card still offering a countdown reads as though the answer did not land.
  // Shown to read-only viewers too: an ask about to settle itself is worth
  // knowing whether or not you are the one who can answer it.
  const showTimeoutNote = timeoutNote != null && status === 'pending'
  let submitLabel = 'Submit answer'
  if (lateAnswerable) {
    submitLabel = submitting ? 'Sending…' : 'Send as new message'
  } else if (submitting) {
    submitLabel = 'Submitting…'
  }

  return (
    // `dark:[color-scheme:dark]` keeps the native radios/checkboxes on the
    // dark control scheme — without it they paint light-scheme white on the
    // dark card.
    <div className={`rounded-xl border border-card-edge bg-card p-4 dark:[color-scheme:dark] ${className ?? ''}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <InteractionBadge variant="outline">{kindLabel ?? 'Question'}</InteractionBadge>
        <InteractionBadge variant={answered ? 'default' : status === 'expired' || status === 'declined' ? 'destructive' : 'outline'}>
          {STATUS_LABELS[status]}
        </InteractionBadge>
      </div>

      {interaction.title.trim() && interaction.fields.every((field) => field.label !== interaction.title) && (
        <p className="mb-3 text-[15px] font-semibold leading-snug text-foreground">{interaction.title}</p>
      )}
      {interaction.body && (renderMarkdown
        ? <div className="mb-3 text-sm leading-5 text-muted-foreground">{renderMarkdown(interaction.body)}</div>
        : <p className="mb-3 text-sm leading-5 text-muted-foreground">{interaction.body}</p>)}

      <div className="space-y-4">
        {interaction.fields.map((field) => {
          const value = values[field.name] ?? {}
          const select = selectField(field)
          const freeText = freeTextField(field)
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
                    answered={answered}
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
                  maxLength={freeText ? textFieldMaxLength(freeText) : undefined}
                  className={FIELD_INPUT_CLASSES}
                />
              ) : (
                <textarea
                  value={value.text ?? ''}
                  disabled={disabled}
                  aria-label={field.label}
                  onChange={(event) => setFieldValue(field.name, { text: event.target.value })}
                  rows={3}
                  maxLength={freeText ? textFieldMaxLength(freeText) : undefined}
                  placeholder={field.type === 'text' ? field.placeholder : undefined}
                  className={FIELD_INPUT_CLASSES}
                />
              )}
            </fieldset>
          )
        })}
      </div>

      {/* Announced, not just shown: a submit that failed is the one thing on this
          card that changes without the reader having moved focus. */}
      {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
      {terminalNote && <p className="mt-3 text-xs text-muted-foreground">{terminalNote}</p>}

      {(showSubmitButton || showTimeoutNote) && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {showTimeoutNote && (
            <div className="mr-auto text-xs text-muted-foreground">{timeoutNote}</div>
          )}
          {showSubmitButton && (
            <InteractionActionButton onClick={() => void submit()} disabled={disabled || !answerData}>
              {submitLabel}
            </InteractionActionButton>
          )}
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
