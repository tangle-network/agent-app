/**
 * ChatComposer — the shared message input every agent app used to hand-roll:
 * an auto-resizing textarea (Enter sends, Shift+Enter inserts a newline), an
 * opt-in attach + drag-and-drop surface with pending-file chips, a streaming
 * Stop/Send toggle, a slot for inline controls (model picker, reasoning
 * effort), and a Cmd/Ctrl+L focus shortcut.
 *
 * A REJECTED send never destroys the draft. The input clears optimistically —
 * the composer stays editable while a turn streams precisely so the next
 * message can be typed against a live answer, and holding the sent text in the
 * box until the server confirms would put the clear on a collision course with
 * that typing. So the clear happens immediately and the draft is held until the
 * send is known to have landed: a handler that throws, rejects, or returns
 * `{ ok: false }` puts the exact bytes back with the caret where it was, names
 * the reason, and reports `onSendFailed` so the host can restore the
 * attachments it consumed. If the user has already typed a replacement, the
 * unsent text is shown in the notice with its own Retry instead of overwriting
 * what they typed — neither draft is ever destroyed.
 *
 * Styling contract matches the rest of `web-react`: Tailwind over the shared
 * design tokens (`bg-card`, `border-border`, `text-foreground`, `bg-primary`, …)
 * and inline-SVG glyphs. It defines NO `--chat-*` / `--brand-*` custom
 * properties, so it themes correctly in any shell that provides the standard
 * tokens — the input renders on-palette instead of collapsing to unstyled
 * fallbacks when a host hasn't defined a private chat-token set.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

// ── glyphs (no icon-library dependency) ───────────────────────────────────

function SendGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  )
}

function StopGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

function PaperclipGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <path d="M12 10v6m-3-3h6" />
    </svg>
  )
}

function CloseGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function UploadGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
    </svg>
  )
}

// ── component ──────────────────────────────────────────────────────────────

/** Prompt-part descriptor an uploaded file carries (the upload route's
 *  `UploadedChatFile.part`), echoed back in the turn body on send. Mirrors
 *  `/chat-routes`' wire shape structurally — no server import here. */
export interface ComposerFilePart {
  type: 'image' | 'file'
  filename?: string
  mediaType?: string
  url?: string
  path?: string
  content?: string
}

export interface ComposerFile {
  id: string
  name: string
  size?: number
  kind: 'file' | 'folder'
  /** Number of files inside, for a folder chip. */
  fileCount?: number
  status: 'pending' | 'uploading' | 'ready' | 'error'
  /** Uploaded part descriptor; set once the upload route returns. Only
   *  `status: 'ready'` files with a part travel on a parts-aware send. */
  part?: ComposerFilePart
}

/** A send the host refused. `error` is shown verbatim in the composer's notice;
 *  omit it for the generic copy. */
export interface ComposerSendRejected {
  ok: false
  error?: string
}

/**
 * What a send handler reports back. `void` — what every handler returned before
 * this existed — reads as accepted, so wiring stays unchanged; a thrown error, a
 * rejected promise, or `{ ok: false }` is the rejection that restores the draft.
 * A handler that resolves only when the whole turn finishes still reports
 * correctly: the input already cleared on dispatch, so the answer only decides
 * whether the draft comes back.
 */
export type ComposerSendOutcome = void | { ok: true } | ComposerSendRejected
export type ComposerSendResult = ComposerSendOutcome | Promise<ComposerSendOutcome>

/**
 * A send handler, typed as a UNION with the legacy `=> void` signature rather
 * than as `(…) => ComposerSendResult` alone.
 *
 * TypeScript's return-type-`void` rule accepts a function returning ANYTHING
 * where a `=> void` is expected, and that rule fires only when the target's
 * return type is exactly `void` — not when it is a union that contains `void`.
 * So narrowing this prop to `ComposerSendResult` would reject handler shapes
 * that compiled against the shipped `onSend?: (message: string) => void`:
 * `onSend={(m) => rows.push(m)}` (returns `number`) and
 * `onSend={(m) => append({ role: 'user', content: m })}` (an ai-sdk append
 * returns `Promise<string | null | undefined>`) both stop compiling, on a
 * package whose pinned consumers must never need a source edit to take a minor.
 *
 * The union keeps both: a legacy handler lands on the first member, and a
 * handler that reports an outcome lands on the second. A call through it
 * resolves to `void | ComposerSendResult`, which IS `ComposerSendResult`, so
 * the composer reads the outcome exactly as before.
 */
export type ComposerSendHandler =
  | ((message: string) => void)
  | ((message: string) => ComposerSendResult)

/** @see ComposerSendHandler — the parts-aware arity, same union for the same reason. */
export type ComposerSendPartsHandler =
  | ((message: string, parts: ComposerFilePart[]) => void)
  | ((message: string, parts: ComposerFilePart[]) => ComposerSendResult)

/** The rejected send, handed to `onSendFailed` so the host can undo whatever it
 *  cleared optimistically — most importantly the staged attachments, which the
 *  composer does not own (`pendingFiles` is a prop). */
export interface ComposerSendFailure {
  /** The reason as the composer renders it. */
  message: string
  /** The user's exact draft, untrimmed. */
  text: string
  /** The parts the rejected send carried. */
  parts: ComposerFilePart[]
  /** Whatever the handler threw / rejected with, or the `{ ok: false }` value. */
  error: unknown
  /** True when the draft was put back in the textarea (the box was empty).
   *  False means the user had typed a replacement, so the unsent text is held in
   *  the notice instead. */
  restored: boolean
}

export interface ChatComposerProps {
  /** Send the trimmed, non-empty message. Attached files travel separately via
   *  `onAttach` + `pendingFiles` (the host consumes and clears them on send).
   *  Optional when `onSendParts` is wired.
   *
   *  Report a refused send by throwing, rejecting, or returning `{ ok: false }`
   *  — the composer restores the draft rather than losing it. */
  onSend?: ComposerSendHandler
  /** Parts-aware send: receives the trimmed message plus the `part`
   *  descriptors of every `ready` pending file. Takes precedence over
   *  `onSend`; enables file-only sends (empty text, ≥1 ready part).
   *
   *  Same rejection contract as `onSend`. */
  onSendParts?: ComposerSendPartsHandler
  /** Notified when a send is rejected, after the composer has restored what it
   *  owns. The host uses it to put back the `pendingFiles` it consumed. */
  onSendFailed?: (failure: ComposerSendFailure) => void
  /** Notice copy when the handler names no reason of its own. */
  sendFailureMessage?: string
  /** Stop the in-flight turn; shown in place of Send while `isStreaming`. */
  onCancel?: () => void
  isStreaming?: boolean
  /** Block input + send (e.g. while restoring). Distinct from `isStreaming`,
   *  which keeps the textarea editable so the next turn can be composed. */
  disabled?: boolean
  placeholder?: string

  /** Controlled value. Omit for self-managed internal state (cleared on send). */
  value?: string
  onValueChange?: (value: string) => void
  /** Initial text in uncontrolled mode; ignored when `value` is provided. */
  initialValue?: string

  /** One-shot external prefill: when this becomes a non-null string the
   *  composer adopts it as the draft (replacing any current draft), focuses the
   *  input with the caret at the end, and reports consumption via
   *  `onSeedApplied` so the host can clear its seed state. */
  seed?: string | null
  onSeedApplied?: () => void

  /** Inline controls (e.g. `<ModelPicker/>` + `<EffortPicker/>` or
   *  `<AgentSessionControls/>`). */
  controls?: ReactNode
  /**
   * Where {@link controls} sit. `inline` (default) puts them on the card's own
   * action row, beside attach and Send — the model a turn will use reads as
   * part of the input rather than as a separate widget floating above it.
   * `above` keeps them outside the card, for a host that wants the input to be
   * nothing but the input.
   */
  controlsPlacement?: 'above' | 'inline'

  /** Attachments are opt-in: pass `onAttach` to show the attach button, accept
   *  drag-and-drop onto the input, and render `pendingFiles` chips. */
  onAttach?: (files: FileList) => void
  onAttachFolder?: (files: FileList) => void
  pendingFiles?: ComposerFile[]
  onRemoveFile?: (id: string) => void
  accept?: string
  dropTitle?: string
  dropDescription?: string

  /** Cmd/Ctrl+L focuses the input and shows the hint. Default true. */
  focusShortcut?: boolean
  /** Send button label. Default "Send". */
  sendLabel?: string
  className?: string
}

const MAX_HEIGHT = 168

const DEFAULT_SEND_FAILURE = "Message not sent. Your draft is still here — try again."

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

export function ChatComposer({
  onSend,
  onSendParts,
  onSendFailed,
  sendFailureMessage = DEFAULT_SEND_FAILURE,
  onCancel,
  isStreaming = false,
  disabled = false,
  placeholder = 'Message the agent…',
  value,
  onValueChange,
  initialValue,
  seed,
  onSeedApplied,
  controls,
  controlsPlacement = 'inline',
  onAttach,
  onAttachFolder,
  pendingFiles = [],
  onRemoveFile,
  accept,
  dropTitle = 'Drop files to add context',
  dropDescription = 'They attach to your next message.',
  focusShortcut = true,
  sendLabel = 'Send',
  className,
}: ChatComposerProps) {
  const isControlled = value !== undefined
  const [internal, setInternal] = useState(initialValue ?? '')
  const text = isControlled ? value : internal
  // A send outcome arrives after the render that dispatched it, so the restore
  // decision must read the LIVE draft, not the one captured in that closure.
  const textRef = useRef(text)
  textRef.current = text

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)

  const setText = useCallback(
    (next: string) => {
      if (!isControlled) setInternal(next)
      onValueChange?.(next)
    },
    [isControlled, onValueChange],
  )

  // Keep the textarea height in sync with the content for BOTH typed and
  // external (controlled) value changes — one effect covers both paths.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  // Adopt a one-shot seed. Applies only when the `seed` PROP transitions to a
  // new string (host sets it → consumed here → host clears it via
  // onSeedApplied), so an unstable callback identity re-running this effect
  // can never re-apply a still-set seed over the user's typing. Like
  // `initialValue`, the seed is honored ONLY in uncontrolled mode — a
  // controlled host drives its own `value` (which would shadow `setText`), so
  // it seeds by updating that state itself.
  const prevSeedRef = useRef<string | null>(null)
  const pendingCaretRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevSeedRef.current
    prevSeedRef.current = seed ?? null
    if (seed == null || seed === prev || isControlled) return
    setText(seed)
    onSeedApplied?.()
    const el = textareaRef.current
    if (el && el.value === seed) {
      // The DOM already shows the seed — setText was a no-op (the user had
      // typed the exact string), so no re-render is coming and the [text]
      // effect below won't fire. Position the caret now instead of leaving a
      // stranded pendingCaretRef.
      el.focus()
      el.setSelectionRange(seed.length, seed.length)
    } else {
      // Defer caret positioning until the seeded value renders (see below).
      pendingCaretRef.current = seed
    }
  }, [seed, setText, onSeedApplied, isControlled])

  // Focus + caret-to-end AFTER the seeded value has rendered into the DOM —
  // setSelectionRange in the applying effect would run against the pre-render
  // value and clamp the caret to the old text's length.
  useEffect(() => {
    if (pendingCaretRef.current == null || pendingCaretRef.current !== text)
      return
    pendingCaretRef.current = null
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(text.length, text.length)
  }, [text])

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

  // Cmd/Ctrl+L focuses the composer from anywhere — the shortcut the hint
  // advertises. Scoped to when the shortcut is enabled and not disabled.
  useEffect(() => {
    if (!focusShortcut || disabled) return
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        textareaRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [focusShortcut, disabled])

  // A ready file counts as sendable content even without a `part`: store-backed
  // attachments (`useComposerAttachments`) carry no prompt part — their
  // references ride the turn body's `attachments` field — but a file-only
  // message must still be sendable.
  const readyFileCount = pendingFiles.filter((f) => f.status === 'ready').length
  const hasSendable = text.trim().length > 0 || readyFileCount > 0
  const canSend = hasSendable && !isStreaming && !disabled

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
    if (isStreaming || disabled) return
    const readyFiles = pendingFiles.filter((f) => f.status === 'ready')
    if (!trimmed && readyFiles.length === 0) return
    // Only a parts-aware send carries parts; `onSend`'s files travel through the
    // host's own `pendingFiles`, so its failure payload names none.
    const parts = onSendParts
      ? readyFiles.filter((f) => f.part).map((f) => f.part as ComposerFilePart)
      : []
    const el = textareaRef.current
    const caret = { start: el?.selectionStart ?? text.length, end: el?.selectionEnd ?? text.length }
    setFailedSend(null)
    setText('')
    textRef.current = ''
    dispatchSend(text, trimmed, parts, caret)
  }, [text, isStreaming, disabled, onSendParts, pendingFiles, setText, dispatchSend])

  // Re-send the message the notice is holding. Reached only when the draft was
  // NOT restored (the restored path leaves the text in the box, where Send is
  // the affordance), so it never competes with the primary control.
  const retryFailedSend = useCallback(() => {
    const failure = failedSend
    if (!failure || isStreaming || disabled) return
    setFailedSend(null)
    const caret = { start: failure.text.length, end: failure.text.length }
    dispatchSend(failure.text, failure.trimmed, failure.parts, caret)
  }, [failedSend, isStreaming, disabled, dispatchSend])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Respect IME composition — Enter commits the candidate, it doesn't send.
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) onAttach?.(e.target.files)
    e.target.value = ''
  }

  const handleFolderChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) (onAttachFolder ?? onAttach)?.(e.target.files)
    e.target.value = ''
  }

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current++
    if (e.dataTransfer?.types.includes('Files')) setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current--
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragDepth.current = 0
      setDragOver(false)
      const files = e.dataTransfer?.files
      if (files?.length) onAttach?.(files)
    },
    [onAttach],
  )

  const folderChips = pendingFiles.filter((f) => f.kind === 'folder')
  const fileChips = pendingFiles.filter((f) => f.kind !== 'folder')
  // `above` is the only placement that takes controls OUT of the card, so it is
  // the only one matched exactly; everything else falls to inline. That keeps a
  // retired value (this prop used to accept `footer` for the same placement) or a
  // typo rendering the controls somewhere rather than nowhere — dropping them
  // silently is the one outcome with no recovery for the reader.
  const showAbove = controls != null && controlsPlacement === 'above'
  const showInline = controls != null && !showAbove

  return (
    <div
      className={`relative ${className ?? ''}`}
      onDragEnter={onAttach ? handleDragEnter : undefined}
      onDragLeave={onAttach ? handleDragLeave : undefined}
      onDragOver={onAttach ? handleDragOver : undefined}
      onDrop={onAttach ? handleDrop : undefined}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-card/95">
          <div className="text-center">
            <span className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <UploadGlyph className="h-5 w-5" />
            </span>
            <p className="text-sm font-semibold text-foreground">{dropTitle}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{dropDescription}</p>
          </div>
        </div>
      )}

      {showAbove && <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1">{controls}</div>}

      {failedSend && (
        <div
          role="alert"
          data-testid="composer-send-error"
          className="mb-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1">{failedSend.message}</span>
            <button
              type="button"
              aria-label="Dismiss send error"
              onClick={() => setFailedSend(null)}
              className="shrink-0 font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
            >
              Dismiss
            </button>
          </div>
          {/* The draft is only held here when it could NOT go back in the box —
              the user typed a replacement. Showing the bytes is what makes the
              message recoverable by hand even if Retry keeps failing. */}
          {!failedSend.restored && (
            <div className="mt-1.5">
              <p
                data-testid="composer-unsent-draft"
                className="max-h-20 overflow-y-auto whitespace-pre-wrap rounded-lg border border-destructive/30 bg-card px-2 py-1 text-foreground"
              >
                {failedSend.text}
              </p>
              <button
                type="button"
                aria-label="Retry sending the unsent message"
                onClick={retryFailedSend}
                disabled={isStreaming || disabled}
                className="mt-1.5 font-medium underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {[...folderChips, ...fileChips].map((f) => (
            <span
              key={f.id}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                f.status === 'error'
                  ? 'border-destructive/40 text-destructive'
                  : 'border-border bg-muted/50 text-foreground'
              }`}
            >
              {f.kind === 'folder' ? <FolderGlyph className="h-3 w-3 shrink-0" /> : <PaperclipGlyph className="h-3 w-3 shrink-0" />}
              <span className="max-w-[150px] truncate">{f.name}</span>
              {f.fileCount !== undefined && <span className="text-muted-foreground">({f.fileCount})</span>}
              {f.status === 'uploading' && (
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              )}
              {onRemoveFile && (
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => onRemoveFile(f.id)}
                  className="rounded p-0.5 text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CloseGlyph className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Two rows inside one card: the message gets the full width, and every
          affordance that acts on it — attach, the controls slot, send — sits on
          its own row beneath. A single row would make the textarea share its
          line with the buttons, which is what squeezed the input and pushed the
          controls out of the card in the first place. */}
      <div
        data-testid="composer-card"
        className="flex flex-col gap-1.5 rounded-2xl border border-border bg-card px-3 py-2.5 transition focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15"
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          // Two lines before it grows. `rows` is what actually holds the floor:
          // the autosize measures `scrollHeight` against `height: auto`, which a
          // textarea resolves through `rows`, so the measurement cannot come back
          // shorter. The paired `min-h-[56px]` is those same two lines in CSS
          // (2 x 24px `leading-6` + 8px `py-1`, and `box-sizing: border-box` puts
          // the padding inside the 56). It sits exactly AT the natural height on
          // purpose: a floor is meant to be inert until something tries to go
          // under it, which here means an inline height arriving from anywhere
          // but the autosize. Setting it higher would buy no protection and cost
          // permanent dead space under the caret.
          rows={2}
          aria-label="Message input"
          className="max-h-[168px] min-h-[56px] w-full resize-none bg-transparent px-1.5 py-1 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />

        <div className="flex items-end gap-2">
          {onAttach && (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                aria-label="Attach files"
                title="Attach files"
                className="shrink-0 rounded-lg p-2 text-muted-foreground transition hover:bg-accent/40 hover:text-foreground disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PaperclipGlyph className="h-4 w-4" />
              </button>
              <input ref={fileInputRef} type="file" multiple className="hidden" accept={accept} onChange={handleFileChange} />
            </>
          )}
          {onAttachFolder && (
            <>
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                disabled={disabled}
                aria-label="Attach folder"
                title="Attach folder"
                className="shrink-0 rounded-lg p-2 text-muted-foreground transition hover:bg-accent/40 hover:text-foreground disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <FolderGlyph className="h-4 w-4" />
              </button>
              {/* webkitdirectory is non-standard but widely supported for folder picks. */}
              <input
                ref={folderInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFolderChange}
                {...({ webkitdirectory: '' } as Record<string, string>)}
              />
            </>
          )}

          {/* The controls take the row's slack and wrap onto a second line when
              a long picker set outgrows it. This slot must never establish an
              overflow box: a control owns its popover (ModelPicker, EffortPicker)
              and anchors it absolutely to itself, so a scroll/clip box here traps
              a 400px-tall list inside a ~34px row — the list renders and is never
              visible — and the scroll offset that comes with it cuts the trigger's
              own left edge. Growing a second line is the cost of controls that
              stay operable. Rendered even when empty so Send stays right-aligned. */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {showInline && controls}
          </div>

          {isStreaming ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Stop response"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/15 px-3.5 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
            >
              <StopGlyph className="h-3.5 w-3.5" />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              aria-label={sendLabel}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
            >
              <SendGlyph className="h-3.5 w-3.5" />
              <span>{sendLabel}</span>
            </button>
          )}
        </div>
      </div>

      {focusShortcut && (
        <div className="mt-1.5 flex justify-end px-1">
          <span className="text-xs text-muted-foreground">
            <kbd className="rounded border border-border bg-background px-1 py-0.5 text-[10px]">Cmd</kbd>
            <kbd className="ml-0.5 rounded border border-border bg-background px-1 py-0.5 text-[10px]">L</kbd>
            <span className="ml-1">to focus</span>
          </span>
        </div>
      )}
    </div>
  )
}
