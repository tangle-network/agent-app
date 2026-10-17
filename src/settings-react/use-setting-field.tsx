/**
 * One setting's save behaviour: the control shows the person's value at once,
 * the write goes through `useConfirmedMutation`, and the row says what
 * happened — "Saving…" only after the pending delay, "Saved" only on a
 * confirmed write and only for two seconds, the server's own sentence and a
 * Retry when it refused. The control keeps the person's value on a failure.
 * Writes go one at a time: a change made while one is in flight waits for it,
 * and only the newest waiting value is sent, so the server ends on the
 * person's last choice. A confirmed write the person has not edited since
 * shows the value the server kept, so a name it trims reads as saved.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useConfirmedMutation, type AsyncLoadContext, type MutationOutcome } from '../web-react/async'
import { PENDING_DELAY_MS, SAVED_VISIBLE_MS, SavedStatus, SavingStatus, UnsavedStatus } from './save-status'

/**
 * - `idle`: the control shows the saved value.
 * - `unsaved`: an edit is waiting for blur or Enter (`commitOn: 'blur'`).
 * - `invalid`: the edit fails `validate`; nothing is sent.
 * - `saving`: the write is in flight.
 * - `saved`: the write was confirmed in the last two seconds.
 * - `failed`: the write was refused; the edit stays for a retry.
 */
export type SettingFieldState = 'idle' | 'unsaved' | 'invalid' | 'saving' | 'saved' | 'failed'

export interface UseSettingFieldOptions<T> {
  /** The value the server holds. A new value replaces the draft unless the person is editing it. */
  saved: T
  /**
   * Writes the value and resolves with the value the server kept, which the control then shows:
   * `confirmSettingResponse(fetch(...), () => next)` for a route that answers `{ success: true }`
   * or 204, a `parse` that reads the kept value from a route that answers with the record, or
   * `confirmWrite`/`rejectWrite` from `web-react/async`. A refusal's message is what the row shows.
   */
  save: (next: T, context: AsyncLoadContext) => Promise<MutationOutcome<T>>
  /** `change` (default) saves on every change: selects, switches, segmented choices. `blur` saves on `commit()`: text. */
  commitOn?: 'change' | 'blur'
  /** With `commitOn: 'change'`, waits this long after the last change before saving. */
  debounceMs?: number
  /** Returns the sentence that says what to fix, or null. Checked on every change; an invalid value is never sent. */
  validate?: (draft: T) => string | null
  /** Defaults to `Object.is`. */
  isEqual?: (a: T, b: T) => boolean
  /** Fires with the confirmed value. */
  onSaved?: (value: T) => void
}

/** Spread into `SettingsRow`: the status after the label, the error that replaces the description, and Retry. */
export interface SettingFieldRowProps {
  status?: ReactNode
  error?: ReactNode
  onRetry?: () => void
}

export interface SettingField<T> {
  draft: T
  /** Shows the value at once; with `commitOn: 'change'` it also saves it. */
  setDraft: (next: T) => void
  /** Saves the draft (or `next`) unless it is invalid or already saved. Use it on blur and Enter. */
  commit: (next?: T) => void
  /** Puts the saved value back and clears any error. */
  revert: () => void
  state: SettingFieldState
  /** The validation or failure sentence, or null. */
  error: string | null
  rowProps: SettingFieldRowProps
}

export function useSettingField<T>({
  saved,
  save,
  commitOn = 'change',
  debounceMs = 0,
  validate,
  isEqual = Object.is,
  onSaved,
}: UseSettingFieldOptions<T>): SettingField<T> {
  const [confirmed, setConfirmed] = useState(saved)
  const [draft, setDraftState] = useState(saved)
  const [failedValue, setFailedValue] = useState<{ value: T } | null>(null)
  const [showSaving, setShowSaving] = useState(false)
  const [showSaved, setShowSaved] = useState(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const confirmedRef = useRef(confirmed)
  confirmedRef.current = confirmed
  const options = useRef({ validate, isEqual, onSaved })
  options.current = { validate, isEqual, onSaved }
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef(false)
  const waiting = useRef<{ value: T } | null>(null)

  const mutation = useConfirmedMutation<T, T>({
    mutate: (value, context) => save(value, context),
    onSucceeded: (value) => {
      confirmedRef.current = value
      setConfirmed(value)
      setFailedValue(null)
      setShowSaved(true)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setShowSaved(false), SAVED_VISIBLE_MS)
      options.current.onSaved?.(value)
    },
  })
  const pending = mutation.state.status === 'pending'

  // A server value that changes under a field nobody is editing replaces it.
  // Only a new server value re-syncs, so `editing` is read, not depended on.
  const editing = !isEqual(draft, confirmed) || pending
  useEffect(() => {
    if (options.current.isEqual(saved, confirmedRef.current)) return
    setConfirmed(saved)
    if (!editing) setDraftState(saved)
  }, [saved])

  useEffect(() => {
    if (!pending) {
      setShowSaving(false)
      return
    }
    const timer = setTimeout(() => setShowSaving(true), PENDING_DELAY_MS)
    return () => clearTimeout(timer)
  }, [pending])

  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current)
    if (savedTimer.current) clearTimeout(savedTimer.current)
  }, [])

  const send = useCallback(async (first: T) => {
    inFlight.current = true
    let value = first
    for (;;) {
      setShowSaved(false)
      const outcome = await mutation.run(value)
      const queued = waiting.current
      waiting.current = null
      // The same value committed again while it was in flight is already written.
      const next = queued && !(outcome.succeeded && options.current.isEqual(queued.value, value)) ? queued : null
      // The server may keep a normalised form, such as a trimmed name. Unless the
      // person edited since, the control shows what was kept and nothing re-sends.
      if (outcome.succeeded && !next && options.current.isEqual(draftRef.current, value)) {
        draftRef.current = outcome.value
        setDraftState(outcome.value)
      }
      // `confirmedRef` now holds what the server keeps: this value if it landed, the earlier one if not.
      if (next && !options.current.isEqual(next.value, confirmedRef.current)) {
        value = next.value
        continue
      }
      inFlight.current = false
      if (!outcome.succeeded && !next) setFailedValue({ value })
      return
    }
  }, [mutation.run])

  const commit = useCallback((next?: T) => {
    if (debounce.current) {
      clearTimeout(debounce.current)
      debounce.current = null
    }
    const value = next === undefined ? draftRef.current : next
    if (options.current.validate?.(value)) return
    if (inFlight.current) {
      waiting.current = { value }
      return
    }
    if (options.current.isEqual(value, confirmedRef.current)) {
      setFailedValue(null)
      return
    }
    void send(value)
  }, [send])

  const setDraft = useCallback((next: T) => {
    draftRef.current = next
    setDraftState(next)
    setFailedValue(null)
    if (commitOn !== 'change') return
    if (debounce.current) clearTimeout(debounce.current)
    if (debounceMs > 0) debounce.current = setTimeout(() => commit(next), debounceMs)
    else commit(next)
  }, [commit, commitOn, debounceMs])

  const revert = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current)
    waiting.current = null
    mutation.reset()
    setFailedValue(null)
    setDraftState(confirmedRef.current)
  }, [mutation.reset])

  const validation = validate && !isEqual(draft, confirmed) ? validate(draft) : null
  const failed = failedValue !== null && isEqual(failedValue.value, draft) && mutation.state.status === 'failed'
  const state: SettingFieldState = validation ? 'invalid'
    : pending ? 'saving'
    : failed ? 'failed'
    : !isEqual(draft, confirmed) ? 'unsaved'
    : showSaved ? 'saved'
    : 'idle'
  const error = validation ?? (failed && mutation.state.status === 'failed' ? mutation.state.message : null)
  const retry = useCallback(() => commit(draftRef.current), [commit])

  const rowProps = useMemo<SettingFieldRowProps>(() => ({
    status: state === 'saving' ? (showSaving ? <SavingStatus /> : undefined)
      : state === 'saved' ? <SavedStatus />
      : state === 'unsaved' && commitOn === 'blur' ? <UnsavedStatus />
      : undefined,
    error: error ?? undefined,
    onRetry: state === 'failed' ? retry : undefined,
  }), [state, showSaving, commitOn, error, retry])

  return { draft, setDraft, commit, revert, state, error, rowProps }
}
