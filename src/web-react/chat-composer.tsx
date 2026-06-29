/**
 * ChatComposer — the shared message input every agent app used to hand-roll:
 * an auto-resizing textarea (Enter sends, Shift+Enter inserts a newline), an
 * opt-in attach + drag-and-drop surface with pending-file chips, a streaming
 * Stop/Send toggle, a slot for inline controls (model picker, reasoning
 * effort), and a Cmd/Ctrl+L focus shortcut.
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

export interface ComposerFile {
  id: string
  name: string
  size?: number
  kind: 'file' | 'folder'
  /** Number of files inside, for a folder chip. */
  fileCount?: number
  status: 'pending' | 'uploading' | 'ready' | 'error'
}

export interface ChatComposerProps {
  /** Send the trimmed, non-empty message. Attached files travel separately via
   *  `onAttach` + `pendingFiles` (the host consumes and clears them on send). */
  onSend: (message: string) => void
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

  /** Inline controls (e.g. `<ModelPicker/>` + `<EffortPicker/>` or
   *  `<AgentSessionControls/>`). Rendered in a row above the input by default. */
  controls?: ReactNode
  controlsPlacement?: 'above' | 'footer'

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

export function ChatComposer({
  onSend,
  onCancel,
  isStreaming = false,
  disabled = false,
  placeholder = 'Message the agent…',
  value,
  onValueChange,
  initialValue,
  controls,
  controlsPlacement = 'above',
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

  const canSend = text.trim().length > 0 && !isStreaming && !disabled

  const send = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming || disabled) return
    onSend(trimmed)
    setText('')
  }, [text, isStreaming, disabled, onSend, setText])

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
  const showFooter = controls != null && controlsPlacement === 'footer'
  const showAbove = controls != null && controlsPlacement === 'above'

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

      <div className="flex items-end gap-2 rounded-2xl border border-border bg-card px-2.5 py-2 transition focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15">
        {onAttach && (
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              aria-label="Attach files"
              title="Attach files"
              className="mb-0.5 shrink-0 rounded-lg p-2 text-muted-foreground transition hover:bg-accent/40 hover:text-foreground disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              className="mb-0.5 shrink-0 rounded-lg p-2 text-muted-foreground transition hover:bg-accent/40 hover:text-foreground disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          aria-label="Message input"
          className="max-h-[168px] min-h-[40px] flex-1 resize-none bg-transparent px-1.5 py-2 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />

        {showFooter && <div className="mb-0.5 flex shrink-0 items-center gap-1.5">{controls}</div>}

        {isStreaming ? (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Stop response"
            className="mb-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/15 px-3.5 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
          >
            <StopGlyph className="h-3.5 w-3.5" />
            <span>Stop</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            aria-label="Send message"
            className="mb-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
          >
            <SendGlyph className="h-3.5 w-3.5" />
            <span>{sendLabel}</span>
          </button>
        )}
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
