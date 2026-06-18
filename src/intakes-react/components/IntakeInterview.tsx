/**
 * Agent-led intake interview: asks one question at a time, advancing as each
 * answer is saved. Fully callback-driven — the host supplies the loaded `view`
 * and the async `onAnswer` / `onComplete` callbacks (backed by `./intakes/api`),
 * so this imports no app router, fetch client, or toast. Styled with the
 * shipped Tangle Quiet tokens (`var(--*)`).
 *
 * The server owns traversal: each `onAnswer` resolves with the next view (next
 * question + progress), so the component never re-derives the graph — it renders
 * `view.nextQuestion`, and when that is null and the view is completable it
 * shows the finish action. Local validation only gates the submit button; the
 * authoritative validation runs in the store.
 */

import { useEffect, useState } from 'react'
import type { IntakeAnswerValue, IntakeQuestion } from '../../intakes/model'
import { validateAnswer } from '../../intakes/model'
import type { IntakeInterviewProps, IntakeView } from '../contracts'

export function IntakeInterview({
  view: initialView,
  onAnswer,
  onComplete,
  onDone,
  onNotice,
}: IntakeInterviewProps) {
  const [view, setView] = useState<IntakeView>(initialView)
  const [draft, setDraft] = useState<IntakeAnswerValue>(currentAnswer(initialView))
  const [busy, setBusy] = useState(false)
  const [doneFired, setDoneFired] = useState(false)

  useEffect(() => {
    setView(initialView)
    setDraft(currentAnswer(initialView))
  }, [initialView])

  useEffect(() => {
    if (view.completed && !doneFired) {
      setDoneFired(true)
      onDone?.()
    }
  }, [view.completed, doneFired, onDone])

  function notify(kind: 'success' | 'error', message: string) {
    onNotice?.({ kind, message })
  }

  const question = view.nextQuestion

  async function submit() {
    if (!question || busy) return
    const validity = validateAnswer(question, draft)
    if (!validity.ok) {
      notify('error', `Please answer: ${validity.reason}`)
      return
    }
    setBusy(true)
    try {
      const next = await onAnswer({ questionId: question.id, value: normalize(question, draft) })
      setView(next)
      setDraft(currentAnswer(next))
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to save answer')
    } finally {
      setBusy(false)
    }
  }

  async function finish() {
    if (busy) return
    setBusy(true)
    try {
      const next = await onComplete()
      setView(next)
      notify('success', 'All set.')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to finish')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">{view.title}</h2>
        {view.description && <p className="text-sm text-[var(--text-muted)]">{view.description}</p>}
        <ProgressBar answered={view.progress.answered} total={view.progress.total} />
      </header>

      {view.completed ? (
        <p className="text-sm text-[var(--text-secondary)]">Thanks — your intake is complete.</p>
      ) : question ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-base font-medium text-[var(--text-primary)]">{question.prompt}</p>
            {question.help && <p className="text-xs text-[var(--text-muted)]">{question.help}</p>}
          </div>

          <AnswerField question={question} value={draft} onChange={setDraft} onSubmit={() => void submit()} />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className="rounded bg-[var(--brand-primary)] px-4 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-secondary)]">That's everything. Ready to finish?</p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void finish()}
              disabled={busy}
              className="rounded bg-[var(--brand-primary)] px-4 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {busy ? 'Finishing…' : 'Finish'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

interface AnswerFieldProps {
  question: IntakeQuestion
  value: IntakeAnswerValue
  onChange(value: IntakeAnswerValue): void
  onSubmit(): void
}

function AnswerField({ question, value, onChange, onSubmit }: AnswerFieldProps) {
  const inputClass =
    'rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]'

  switch (question.type) {
    case 'long-text':
      return (
        <textarea
          rows={4}
          aria-label={question.prompt}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          className={inputClass}
        />
      )
    case 'boolean':
      return (
        <div className="flex gap-2">
          {[{ v: true, l: 'Yes' }, { v: false, l: 'No' }].map((opt) => (
            <button
              key={opt.l}
              type="button"
              onClick={() => onChange(opt.v)}
              className={`rounded border px-4 py-1.5 text-sm ${
                value === opt.v
                  ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white'
                  : 'border-[var(--border-default)] bg-[var(--bg-input)] text-[var(--text-secondary)]'
              }`}
            >
              {opt.l}
            </button>
          ))}
        </div>
      )
    case 'number':
      return (
        <input
          type="number"
          aria-label={question.prompt}
          value={typeof value === 'number' ? value : ''}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
          onKeyDown={(event) => { if (event.key === 'Enter') onSubmit() }}
          className={inputClass}
        />
      )
    case 'single-select':
      return (
        <div className="flex flex-col gap-1.5">
          {(question.options ?? []).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={`rounded border px-3 py-2 text-left text-sm ${
                value === option.value
                  ? 'border-[var(--brand-primary)] bg-[var(--bg-input)] text-[var(--text-primary)]'
                  : 'border-[var(--border-default)] bg-[var(--bg-input)] text-[var(--text-secondary)]'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )
    case 'multi-select': {
      const selected = Array.isArray(value) ? value : []
      return (
        <div className="flex flex-col gap-1.5">
          {(question.options ?? []).map((option) => {
            const on = selected.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                onClick={() =>
                  onChange(on ? selected.filter((v) => v !== option.value) : [...selected, option.value])
                }
                className={`rounded border px-3 py-2 text-left text-sm ${
                  on
                    ? 'border-[var(--brand-primary)] bg-[var(--bg-input)] text-[var(--text-primary)]'
                    : 'border-[var(--border-default)] bg-[var(--bg-input)] text-[var(--text-secondary)]'
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      )
    }
    default:
      return (
        <input
          type={question.type === 'email' ? 'email' : question.type === 'url' ? 'url' : 'text'}
          aria-label={question.prompt}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') onSubmit() }}
          className={inputClass}
        />
      )
  }
}

function ProgressBar({ answered, total }: { answered: number; total: number }) {
  const pct = total > 0 ? Math.round((answered / total) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-input)]">
        <div className="h-full rounded-full bg-[var(--brand-primary)] transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-[var(--text-muted)]">{answered}/{total}</span>
    </div>
  )
}

function currentAnswer(view: IntakeView): IntakeAnswerValue {
  const id = view.nextQuestion?.id
  if (!id) return null
  return view.answers[id] ?? defaultDraft(view.nextQuestion!)
}

function defaultDraft(question: IntakeQuestion): IntakeAnswerValue {
  return question.type === 'multi-select' ? [] : null
}

/** Trim text answers before submit; pass others through unchanged. */
function normalize(question: IntakeQuestion, value: IntakeAnswerValue): IntakeAnswerValue {
  if (typeof value === 'string' && (question.type === 'text' || question.type === 'long-text' || question.type === 'url' || question.type === 'email')) {
    return value.trim()
  }
  return value
}
