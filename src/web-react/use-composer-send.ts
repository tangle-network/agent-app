/** Optimistic send admission, rejected-draft recovery, and explicit retry. */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ChatComposerProps, ComposerFilePart, ComposerSendOutcome, ComposerSendRejected, ComposerSendResult } from './chat-composer-types'

/** A rejection the handler reported by value rather than by throwing. */
function isRejectedOutcome(outcome: ComposerSendOutcome): outcome is ComposerSendRejected {
  return typeof outcome === 'object' && outcome !== null && outcome.ok === false
}

function isPromise(value: ComposerSendResult): value is Promise<ComposerSendOutcome> {
  return typeof (value as Promise<ComposerSendOutcome> | undefined)?.then === 'function'
}

/** The reason to show. A rejection's own `error` string wins; then an Error's
 *  message; else the caller's copy — never an empty notice. */
function sendFailureText(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'ok' in error) {
    const named = (error as ComposerSendRejected).error
    if (typeof named === 'string' && named.trim() !== '') return named
    return fallback
  }
  if (typeof error === 'string' && error.trim() !== '') return error
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return fallback
}

interface FailedSend {
  message: string
  /** The user's exact draft, untrimmed — what a restore puts back. */
  text: string
  /** The trimmed form the handler was called with, so Retry sends the same
   *  bytes the rejected attempt did. */
  trimmed: string
  parts: ComposerFilePart[]
  restored: boolean
}

type ComposerSendOptions = Pick<ChatComposerProps, 'onSend' | 'onSendParts' | 'onSendFailed' | 'attachmentsNotReadyMessage' | 'selectedSkillId'> & {
  text: string
  textRef: { current: string }
  textareaRef: RefObject<HTMLTextAreaElement | null>
  setText: (next: string) => void
  pendingFiles: NonNullable<ChatComposerProps['pendingFiles']>
  sendFailureMessage: string
  sendBlockedByStream: boolean
  disabled: boolean
  sendDisabled: boolean
  canSubmitAttachmentsOnly: boolean
}

export function useComposerSend({ text, textRef, textareaRef, setText, pendingFiles, sendFailureMessage, sendBlockedByStream, disabled, sendDisabled, canSubmitAttachmentsOnly, onSend, onSendParts, onSendFailed, attachmentsNotReadyMessage, selectedSkillId }: ComposerSendOptions) {
  // A restored draft gets the caret back where the user left it — same
  // post-render rule as the seed above, but to the recorded offsets rather than
  // to the end, so a failed send returns the user to the word they were on.
  const restoreCaretRef = useRef<{ text: string; start: number; end: number } | null>(null)
  useEffect(() => {
    const pending = restoreCaretRef.current
    if (!pending || pending.text !== text) return
    restoreCaretRef.current = null
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const start = Math.min(pending.start, text.length)
    const end = Math.min(pending.end, text.length)
    el.setSelectionRange(start, end)
  }, [text])

  const [failedSend, setFailedSend] = useState<FailedSend | null>(null)

  // The draft comes back only when the box is still empty. If the user typed a
  // replacement while the send was in flight, overwriting it would trade one
  // lost message for another — the unsent text is held in the notice instead,
  // where Retry can send it without touching what they typed.
  const failSend = useCallback(
    (error: unknown, draft: string, trimmed: string, parts: ComposerFilePart[], caret: { start: number; end: number }) => {
      const message = sendFailureText(error, sendFailureMessage)
      const restored = textRef.current === ''
      if (restored) {
        const el = textareaRef.current
        setText(draft)
        if (el && el.value === draft) {
          // A handler that rejected SYNCHRONOUSLY did so inside the same event
          // as the clear, so React collapses clear+restore into no state change
          // at all — no re-render is coming and the effect below will never
          // fire. Place the caret now rather than stranding the pending ref.
          el.focus()
          el.setSelectionRange(Math.min(caret.start, draft.length), Math.min(caret.end, draft.length))
        } else {
          restoreCaretRef.current = { text: draft, start: caret.start, end: caret.end }
        }
      }
      setFailedSend({ message, text: draft, trimmed, parts, restored })
      onSendFailed?.({ message, text: draft, parts, error, restored })
    },
    [onSendFailed, sendFailureMessage, setText],
  )

  // Hand the message to the host and watch the outcome. The input has already
  // been cleared by the caller — this only decides whether it comes back.
  const dispatchSend = useCallback(
    (draft: string, trimmed: string, parts: ComposerFilePart[], caret: { start: number; end: number }) => {
      let outcome: ComposerSendResult
      try {
        outcome = onSendParts ? onSendParts(trimmed, parts) : onSend?.(trimmed)
      } catch (error) {
        failSend(error, draft, trimmed, parts, caret)
        return
      }
      if (isPromise(outcome)) {
        void outcome.then(
          (settled) => {
            if (isRejectedOutcome(settled)) failSend(settled, draft, trimmed, parts, caret)
          },
          (error: unknown) => failSend(error, draft, trimmed, parts, caret),
        )
        return
      }
      if (isRejectedOutcome(outcome)) failSend(outcome, draft, trimmed, parts, caret)
    },
    [onSend, onSendParts, failSend],
  )

  const send = useCallback(() => {
    const trimmed = text.trim()
    if (sendBlockedByStream || disabled || sendDisabled) return
    const readyFiles = pendingFiles.filter((f) => f.status === 'ready')
    const sendable = canSubmitAttachmentsOnly ? pendingFiles : readyFiles
    if (!trimmed && sendable.length === 0 && !selectedSkillId) return
    // `canSubmitAttachmentsOnly` keeps the control live while a file is staged,
    // but a turn carrying no text and no file the host can deliver must not go
    // out: it would arrive empty and the attachment would be lost. Refuse it
    // here and say why, rather than dispatching and trusting every host to
    // re-derive the same check.
    if (!trimmed && readyFiles.length === 0 && pendingFiles.length > 0) {
      const message =
        attachmentsNotReadyMessage ??
        (pendingFiles.some((f) => f.status === 'error')
          ? 'Retry or remove the failed attachment before sending.'
          : 'Wait for the attachment to finish uploading.')
      setFailedSend({ message, text: '', trimmed: '', parts: [], restored: true })
      return
    }
    // Only a parts-aware send carries parts; `onSend`'s files travel through the
    // host's own `pendingFiles`, so its failure payload names none. Parts come
    // from READY files whatever `canSubmitAttachmentsOnly` says — an unfinished
    // upload has no part to send.
    const parts = onSendParts
      ? readyFiles.filter((f) => f.part).map((f) => f.part as ComposerFilePart)
      : []
    const el = textareaRef.current
    const caret = { start: el?.selectionStart ?? text.length, end: el?.selectionEnd ?? text.length }
    setFailedSend(null)
    setText('')
    textRef.current = ''
    dispatchSend(text, trimmed, parts, caret)
  }, [
    text,
    sendBlockedByStream,
    disabled,
    sendDisabled,
    canSubmitAttachmentsOnly,
    attachmentsNotReadyMessage,
    onSendParts,
    pendingFiles,
    selectedSkillId,
    setText,
    dispatchSend,
  ])

  // Re-send the message the notice is holding. Reached only when the draft was
  // NOT restored (the restored path leaves the text in the box, where Send is
  // the affordance), so it never competes with the primary control.
  const retryFailedSend = useCallback(() => {
    const failure = failedSend
    if (!failure || sendBlockedByStream || disabled || sendDisabled) return
    setFailedSend(null)
    const caret = { start: failure.text.length, end: failure.text.length }
    dispatchSend(failure.text, failure.trimmed, failure.parts, caret)
  }, [failedSend, sendBlockedByStream, disabled, sendDisabled, dispatchSend])

  return { failedSend, setFailedSend, send, retryFailedSend }
}
