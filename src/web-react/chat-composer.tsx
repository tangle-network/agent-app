/**
 * ChatComposer — the shared message input every agent app used to hand-roll:
 * an auto-resizing textarea (Enter sends, Shift+Enter inserts a newline), an
 * opt-in attach + drag-and-drop + clipboard-paste surface with pending-file
 * chips, an opt-in `@`-mention mode (`mention`) that swaps the textarea for a
 * lazily loaded rich input with atomic mention pills, a streaming Stop/Send
 * toggle, a slot for inline controls (model picker, reasoning effort), and a
 * Cmd/Ctrl+L focus shortcut.
 *
 * Files arrive by three routes — the picker dialog, a drop, and a paste — and
 * all three funnel through `accept` (`./composer-file-accept`) before they
 * reach `onAttach`, so a type the picker will not offer cannot get in by
 * another route. What `accept` refuses goes to `onRejectFiles` with a reason;
 * without that prop a refusal is silent, which is what the native picker also
 * does. Size and count limits stay the host's job — `useComposerAttachments`
 * owns them, because they depend on what is already staged.
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
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'

import { focusFieldWithin } from '@tangle-network/ui/utils'

import { OVERLAY_SHADOW, POPOVER_OPTION_FOCUS, PopoverSurface } from './controls'
import { formatDictationElapsed, useDictation, type DictationAudio } from './use-dictation'
import { LazyLoadBoundary } from './lazy-load-boundary'
import { useWorkspacePrewarmHandle } from './workspace-prewarm'
import { useComposerCommands } from './use-composer-commands'
import { useComposerFileIntake } from './use-composer-file-intake'
import { useComposerSend } from './use-composer-send'
import { SendGlyph, StopGlyph, ArrowUpGlyph, PaperclipGlyph, FolderGlyph, CloseGlyph, RetryGlyph, UploadGlyph, MicGlyph } from './composer-glyphs'
import type { ChatComposerProps } from './chat-composer-types'


/**
 * The TipTap editor is a lazy chunk: only consumers that pass `mention` pull
 * the editor stack into their bundle, and only when the mention path renders.
 * The `@tiptap/*` packages behind it are OPTIONAL peers reached only
 * through `loadMentionEditor`'s dynamic imports — a bundler replaces a missing
 * one with a runtime-throwing stub, so a consumer without them still builds.
 */
function createLazyMentionEditor() {
  return lazy(() => import('./mention-editor').then((m) => m.loadMentionEditor()))
}

/** The focus-shortcut hint names the platform's modifier: Cmd on Apple,
 *  Ctrl everywhere else (the handler itself listens for both). SSR-safe —
 *  defaults to Ctrl when there's no navigator to ask. */
const IS_APPLE_PLATFORM =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)


export * from './chat-composer-types'

const DEFAULT_MAX_HEIGHT = 168

/** The input's own `leading-6` line box and its `py-1` padding, in pixels. The
 *  `minRows` floor is computed from them so the CSS floor and the `rows`
 *  attribute cannot drift apart at a row count other than the default. */
const LINE_HEIGHT = 24
const TEXTAREA_PADDING_Y = 8

const DEFAULT_SEND_FAILURE = "Message not sent. Your draft is still here — try again."

export function ChatComposer({
  onSend,
  onSendParts,
  onSendFailed,
  sendFailureMessage = DEFAULT_SEND_FAILURE,
  onCancel,
  isStreaming = false,
  disabled = false,
  sendDisabled = false,
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
  onRetryFile,
  accept,
  onRejectFiles,
  dropTitle = 'Drop files to add context',
  dropDescription = 'They attach to your next message.',
  contextItems = [],
  canSubmitAttachmentsOnly = false,
  attachmentsNotReadyMessage,
  canSubmitWhileBusy = false,
  autoFocus,
  minRows = 2,
  maxHeight = DEFAULT_MAX_HEIGHT,
  trailing,
  mention,
  slashCommands,
  eligibleSkills = [],
  selectedSkillId,
  onSelectedSkillChange,
  onDictate,
  onDictateError,

  focusShortcut = true,
  onFocusWithin,
  floating = false,
  sendLabel = 'Send',
  sendVariant = 'pill',
  sendTone = 'contrast',
  className,
}: ChatComposerProps) {
  const shellPrewarm = useWorkspacePrewarmHandle()
  const focusWithin = onFocusWithin ?? shellPrewarm?.reassert
  const isControlled = value !== undefined
  const [internal, setInternal] = useState(initialValue ?? '')
  const text = isControlled ? value : internal
  const MentionEditor = useMemo(createLazyMentionEditor, [])
  // A send outcome arrives after the render that dispatched it, so the restore
  // decision must read the LIVE draft, not the one captured in that closure.
  const textRef = useRef(text)
  textRef.current = text

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Set by the mention editor so autofocus-independent focus paths (the
  // Cmd/Ctrl+L shortcut) reach it in the rich path, where `textareaRef` stays
  // null. The editor registers `null` on unmount, so the shortcut can never
  // call into a destroyed editor.
  const richFocusRef = useRef<(() => void) | null>(null)
  // Stable identity so the mention editor's registration effect only reruns
  // when the editor instance itself changes, not on every parent render.
  const registerRichFocus = useCallback((focus: (() => void) | null) => {
    richFocusRef.current = focus
  }, [])
  const { fileInputRef, folderInputRef, dragOver, handleFileChange, handleFolderChange, handlePaste, ingestPastedFiles, handleDragEnter, handleDragLeave, handleDragOver, handleDrop } = useComposerFileIntake({ onAttach, onAttachFolder, accept, onRejectFiles, pendingFiles })

  const setText = useCallback(
    (next: string) => {
      if (!isControlled) setInternal(next)
      onValueChange?.(next)
    },
    [isControlled, onValueChange],
  )

  // Dictation: capture only. The hook reports every failure in words; the
  // composer shows them in its own dismissible notice (the same shape as a
  // rejected send) AND forwards them for hosts that log.
  const [dictateError, setDictateError] = useState<string | null>(null)
  const handleDictated = useCallback(
    (audio: DictationAudio) => {
      setDictateError(null)
      onDictate?.(audio)
    },
    [onDictate],
  )
  const handleDictateError = useCallback(
    (message: string) => {
      setDictateError(message)
      onDictateError?.(message)
    },
    [onDictateError],
  )
  const dictation = useDictation({ onDictate: handleDictated, onError: handleDictateError })

  // Keep the textarea height in sync with the content for BOTH typed and
  // external (controlled) value changes — one effect covers both paths. It also
  // reruns when the bounds move: `rows` is what `scrollHeight` resolves the
  // measurement against, so a changed `minRows` that did not re-measure would
  // strand the previous inline height.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [text, maxHeight, minRows])

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

  // A ready file counts as sendable content even without a `part`: store-backed
  // attachments (`useComposerAttachments`) carry no prompt part — their
  // references ride the turn body's `attachments` field — but a file-only
  // message must still be sendable. `canSubmitAttachmentsOnly` widens that to a
  // file of ANY status, so an in-flight upload leaves the control live and the
  // host's handler decides what to do about it.
  const sendableFiles = canSubmitAttachmentsOnly
    ? pendingFiles
    : pendingFiles.filter((f) => f.status === 'ready')
  const hasSendable = text.trim().length > 0 || sendableFiles.length > 0 || Boolean(selectedSkillId)
  // Streaming blocks a send unless the host queues turns. The button still
  // shows Stop while streaming, so `canSubmitWhileBusy` opens Enter, not a
  // second visible control.
  const sendBlockedByStream = isStreaming && !canSubmitWhileBusy
  const canSend = hasSendable && !sendBlockedByStream && !disabled && !sendDisabled

  const { failedSend, setFailedSend, send, retryFailedSend } = useComposerSend({ text, textRef, textareaRef, setText, pendingFiles, sendFailureMessage, sendBlockedByStream, disabled, sendDisabled, canSubmitAttachmentsOnly, onSend, onSendParts, onSendFailed, attachmentsNotReadyMessage, selectedSkillId })

  // Cmd/Ctrl+L focuses the composer from anywhere — the shortcut the hint
  // advertises. Scoped to when the shortcut is enabled and not disabled.
  // Depends on mention PRESENCE, not identity: hosts build the prop object
  // inline per render, and only the mode switch changes which input to focus.
  const mentionEnabled = mention != null
  useEffect(() => {
    if (!focusShortcut || disabled) return
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        if (mentionEnabled) {
          const focus = richFocusRef.current
          e.preventDefault()
          if (focus) focus()
          else textareaRef.current?.focus()
        } else {
          e.preventDefault()
          textareaRef.current?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [focusShortcut, disabled, mentionEnabled])

  const { cardRef, slashPanelRef, slashListId, setMentionSuggestionOpen, slashActiveIndex, slashOpen, slashFiltered, skillQuery, hasSkills, setSlashActive, pickSlash, handleSlashKeyDown } = useComposerCommands({ text, textRef, setText, mention, slashCommands, eligibleSkills, onSelectedSkillChange })

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Respect IME composition — Enter commits the candidate, it doesn't send.
    if (e.nativeEvent.isComposing) return
    if (handleSlashKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const folderChips = pendingFiles.filter((f) => f.kind === 'folder')
  const fileChips = pendingFiles.filter((f) => f.kind !== 'folder')
  // `above` is the only placement that takes controls OUT of the card, so it is
  // the only one matched exactly; everything else falls to inline. That keeps a
  // retired value (this prop used to accept `footer` for the same placement) or a
  // typo rendering the controls somewhere rather than nowhere — dropping them
  // silently is the one outcome with no recovery for the reader.
  const showAbove = controls != null && controlsPlacement === 'above'
  const showInline = controls != null && !showAbove

  // One floor for both input modes, so the mention editor and the textarea
  // cannot disagree about the empty-composer height.
  const inputMinHeight = minRows * LINE_HEIGHT + TEXTAREA_PADDING_Y
  // Keep one basic input for textarea mode and the rich editor's loading
  // state. A slow or hung lazy chunk must not leave a visible dead composer.
  // The controlled draft transfers into the rich editor when it loads.
  // Both render sites stay inside the card's `focusFieldWithin` indicator.
  const textareaInput = (
    <textarea
      ref={textareaRef}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={handleKeyDown}
      onPaste={onAttach ? handlePaste : undefined}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      rows={minRows}
      style={{ minHeight: inputMinHeight, maxHeight }}
      aria-label="Message input"
      data-composer-input
      className="w-full resize-none bg-transparent px-1.5 py-1 text-base leading-6 text-foreground placeholder:text-muted-foreground disabled:opacity-50"
    />
  )

  return (
    <div
      className={`relative ${className ?? ''}`}
      onFocus={focusWithin}
      onDragEnter={onAttach ? handleDragEnter : undefined}
      onDragLeave={onAttach ? handleDragLeave : undefined}
      onDragOver={onAttach ? handleDragOver : undefined}
      onDrop={onAttach ? handleDrop : undefined}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-card">
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

      {dictateError && (
        <div
          role="alert"
          data-testid="composer-dictate-error"
          className="mb-2 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1">{dictateError}</span>
          <button
            type="button"
            aria-label="Dismiss dictation error"
            onClick={() => setDictateError(null)}
            className="shrink-0 font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
          >
            Dismiss
          </button>
        </div>
      )}

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
                disabled={sendBlockedByStream || disabled}
                className="mt-1.5 font-medium underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      {selectedSkillId && (
        <div aria-label="Selected skill" className="mb-2 flex min-w-0 flex-wrap gap-1.5">
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs text-primary">
            <span className="min-w-0 truncate">Skill: {eligibleSkills.find((skill) => skill.id === selectedSkillId)?.name ?? selectedSkillId}</span>
            {onSelectedSkillChange && (
              <button
                type="button"
                aria-label="Remove selected skill"
                onClick={() => onSelectedSkillChange(null)}
                className="shrink-0 rounded p-0.5 text-primary/70 transition hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CloseGlyph className="h-3 w-3" />
              </button>
            )}
          </span>
        </div>
      )}

      {contextItems.length > 0 && (
        <div aria-label="Message context" className="mb-2 flex min-w-0 flex-wrap gap-1.5">
          {contextItems.map((item) => (
            <span
              key={item.id}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs text-primary"
            >
              {item.icon && (
                <span className="shrink-0" aria-hidden>
                  {item.icon}
                </span>
              )}
              <span className="min-w-0 truncate">{item.label}</span>
              {item.onRemove && (
                <button
                  type="button"
                  aria-label={`Remove context ${item.label}`}
                  onClick={item.onRemove}
                  className="shrink-0 rounded p-0.5 text-primary/70 transition hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CloseGlyph className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {[...folderChips, ...fileChips].map((f) => {
            const isError = f.status === 'error'
            return (
              <span
                key={f.id}
                title={isError ? f.errorMessage : undefined}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                  isError
                    ? 'border-destructive/40 text-destructive'
                    : 'border-border bg-secondary text-foreground'
                } ${f.status === 'pending' ? 'opacity-60' : ''}`}
              >
                {/* A thumbnail identifies a pasted screenshot that the
                    auto-generated name cannot. Folders never have one. */}
                {f.kind !== 'folder' && f.previewUrl ? (
                  <img src={f.previewUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                ) : f.kind === 'folder' ? (
                  <FolderGlyph className="h-3 w-3 shrink-0" />
                ) : (
                  <PaperclipGlyph className="h-3 w-3 shrink-0" />
                )}
                <span className="max-w-[150px] truncate">{f.name}</span>
                {f.fileCount !== undefined && <span className="text-muted-foreground">({f.fileCount})</span>}
                {f.status === 'uploading' && (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                )}
                {isError && f.errorMessage && (
                  <span className="max-w-[150px] truncate text-destructive/80">{f.errorMessage}</span>
                )}
                {isError && onRetryFile && (
                  <button
                    type="button"
                    aria-label={`Retry upload ${f.name}`}
                    onClick={() => onRetryFile(f.id)}
                    className="rounded p-0.5 text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <RetryGlyph className="h-3 w-3" />
                  </button>
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
            )
          })}
        </div>
      )}

      {/* Two rows inside one card: the message gets the full width, and every
          affordance that acts on it — attach, the controls slot, send — sits on
          its own row beneath. A single row would make the textarea share its
          line with the buttons, which is what squeezed the input and pushed the
          controls out of the card in the first place. */}
      {/* `focusFieldWithin` makes the card a field: with brand's interaction
          tokens it carries the well fill (`--well`), field border, hover glow
          and focus ring. Under a brand without the ladder, tokens.css sets
          `--well` to the card color. */}
      <div
        ref={cardRef}
        data-testid="composer-card"
        className={`flex flex-col gap-1.5 rounded-2xl border bg-[var(--well,var(--color-card))] px-3 py-2.5 ${focusFieldWithin} ${
          floating ? 'shadow-raised' : ''
        }`}
      >
        {mention ? (
          // The basic textarea stays usable through download, initialization,
          // and failure.
          <LazyLoadBoundary renderFailure={() => (
            <>
              {textareaInput}
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              >
                Mentions are unavailable. You can still send.
              </div>
            </>
          )}>
            <Suspense fallback={textareaInput}>
              <MentionEditor
                value={text}
                onChange={setText}
                onSubmit={send}
                placeholder={placeholder}
                disabled={disabled}
                autoFocus={autoFocus}
                minHeight={inputMinHeight}
                maxHeight={maxHeight}
                mention={mention}
                fallback={textareaInput}
                registerFocus={registerRichFocus}
                onComposerKeyDown={handleSlashKeyDown}
                onMentionMenuOpenChange={setMentionSuggestionOpen}
                slashListId={slashOpen ? slashListId : undefined}
                slashActiveId={slashFiltered[slashActiveIndex] ? `${slashListId}-${slashActiveIndex}` : undefined}
                onPasteFiles={onAttach ? ingestPastedFiles : undefined}
              />
            </Suspense>
          </LazyLoadBoundary>
        ) : (
          // The card is the field (`focusFieldWithin`: well fill, field border,
          // hover glow, focus ring), so tokens.css clears the transparent
          // input's own outline (`[data-composer-input]:focus-visible`).
          textareaInput
        )}

        {/* The row wraps rather than overlaps. The controls slot never shrinks
            below its widest control (`min-w-min`), so when the controls and the
            actions group cannot share one line the actions group moves to its
            own line, right-aligned, instead of being drawn over a squeezed
            control. With `min-w-0` here a single Plan chip was compressed to
            nothing at 390px and painted underneath a trailing model picker. */}
        <div className="flex flex-wrap items-end gap-2">
          {onAttach && (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                aria-label="Attach files"
                title="Attach files"
                className="shrink-0 rounded-lg p-2 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                className="shrink-0 rounded-lg p-2 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          <div
            data-testid="composer-controls"
            className="flex min-w-min flex-1 flex-wrap items-center gap-1.5"
          >
            {showInline && controls}
          </div>

          {/* Trailing content is the controls slot's SIBLING, not its content:
              the slot is where a picker set is allowed to wrap, and a meter or
              a status line put inside it would be pushed onto the second line
              by the very pickers it reports on. Trailing content, dictation
              and Send travel together as one group: when the row wraps they
              move to the next line right-aligned, so Send never lands alone at
              the start of a line. The group wraps inside itself too: when a
              trailing picker and Send cannot share even their own line (a
              320px phone), Send drops below the picker, right-aligned, instead
              of being drawn over it. */}
          <div data-testid="composer-actions" className="ml-auto flex min-w-0 max-w-full flex-wrap items-end justify-end gap-2">
            {trailing && (
              <div data-testid="composer-trailing" className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                {trailing}
              </div>
            )}
            {/* Dictation sits beside Send: it produces input, like typing. The
                button renders only when the host takes audio AND the browser can
                record — a dead mic is worse than no mic. While recording, the
                elapsed seconds (not the pulsing dot, which reduced motion
                collapses) are the signal, and the stop control is never
                disabled: a `disabled` flip mid-capture must not strand the mic. */}
            {onDictate && dictation.supported ? (
              dictation.recording ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
                  <span
                    aria-hidden="true"
                    data-testid="composer-dictate-elapsed"
                    className="text-xs tabular-nums text-muted-foreground"
                  >
                    {formatDictationElapsed(dictation.elapsedSeconds)}
                  </span>
                  <span role="status" className="sr-only">
                    Recording
                  </span>
                  <button
                    type="button"
                    onClick={dictation.stop}
                    aria-label="Stop dictation"
                    title="Stop dictation"
                    className="shrink-0 rounded-lg p-2 text-destructive transition hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <StopGlyph className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={dictation.start}
                  disabled={disabled}
                  aria-label="Dictate message"
                  title="Dictate message"
                  className="shrink-0 rounded-lg p-2 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <MicGlyph className="h-4 w-4" />
                </button>
              )
            ) : null}

            {isStreaming ? (
              sendVariant === 'icon' ? (
                <button
                  type="button"
                  onClick={onCancel}
                  aria-label="Stop response"
                  title="Stop"
                  className="inline-flex size-[var(--control-height-sm,2rem)] shrink-0 items-center justify-center rounded-full border border-border bg-transparent text-foreground transition hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <StopGlyph className="h-3 w-3" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onCancel}
                  aria-label="Stop response"
                  className="inline-flex h-[var(--control-height-sm,2rem)] shrink-0 items-center gap-1.5 rounded-full bg-destructive/15 px-3.5 text-sm font-medium text-destructive transition hover:bg-destructive/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
                >
                  <StopGlyph className="h-3.5 w-3.5" />
                  <span>Stop</span>
                </button>
              )
            ) : sendVariant === 'icon' ? (
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                aria-label={sendLabel}
                title={sendLabel}
                className={`inline-flex size-[var(--control-height-sm,2rem)] shrink-0 items-center justify-center rounded-full ${sendTone === 'primary' ? 'bg-primary text-primary-foreground' : 'bg-foreground text-background'} transition ${sendTone === 'primary' ? 'hover:bg-primary/90' : 'hover:opacity-90'} disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card`}
              >
                <ArrowUpGlyph className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                aria-label={sendLabel}
                className="inline-flex h-[var(--control-height-sm,2rem)] shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
              >
                <SendGlyph className="h-3.5 w-3.5" />
                <span>{sendLabel}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* The slash menu ports through PopoverSurface like every canonical
          popover: the composer docks inside horizontally scrolling rails, and
          an in-place panel there is a panel the host clips away. It anchors
          to the current input card and opens above. Focus never leaves the input —
          rows are mousedown-swallowed so a click can't blur it. */}
      <PopoverSurface
        open={slashOpen}
        id={slashListId}
        role="listbox"
        triggerRef={mention ? cardRef : textareaRef}
        panelRef={slashPanelRef}
        className={`w-80 overflow-y-auto rounded-xl border border-card-edge bg-popover p-1 ${OVERLAY_SHADOW}`}
      >
        <div className="max-h-80 overflow-y-auto overscroll-contain">
          {slashFiltered.length === 0 && (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              {skillQuery !== undefined ? 'No matching skills' : hasSkills ? 'No matching commands or skills' : 'No matching commands'}
            </div>
          )}
          {slashFiltered.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === slashActiveIndex}
              id={`${slashListId}-${index}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setSlashActive(index)}
              onClick={() => pickSlash(item.id)}
              className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm transition ${POPOVER_OPTION_FOCUS} ${
                index === slashActiveIndex ? 'bg-accent' : 'hover:bg-accent'
              }`}
            >
              <span className="shrink-0 font-medium text-foreground">{item.label}</span>
              <span className="truncate text-xs text-muted-foreground">{item.description}</span>
            </button>
          ))}
        </div>
      </PopoverSurface>

      {focusShortcut && (
        // A touch screen has no keyboard to press the shortcut on.
        <div className="mt-1.5 flex justify-end px-1 [@media(pointer:coarse)]:hidden">
          <span className="text-xs text-muted-foreground">
            <kbd className="rounded border border-border bg-background px-1 py-0.5 text-xs">{IS_APPLE_PLATFORM ? 'Cmd' : 'Ctrl'}</kbd>
            <kbd className="ml-0.5 rounded border border-border bg-background px-1 py-0.5 text-xs">L</kbd>
            <span className="ml-1">to focus</span>
          </span>
        </div>
      )}
    </div>
  )
}
