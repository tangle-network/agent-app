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
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import {
  filterAcceptedFiles,
  renamePastedImages,
  type ComposerFileRejection,
} from './composer-file-accept'
import { filterCommandPaletteItems, type CommandPaletteItem } from '../session-shell/index'
import { OVERLAY_SHADOW, POPOVER_OPTION_FOCUS, PopoverSurface } from './controls'
import { formatDictationElapsed, useDictation, type DictationAudio } from './use-dictation'
import type { ComposerMentionProp } from './use-file-mentions'

/**
 * The TipTap editor is a lazy chunk: only consumers that pass `mention` pull
 * the editor stack into their bundle, and only when the mention path renders.
 * The `@tiptap/*` packages behind it are OPTIONAL peers reached only
 * through `loadMentionEditor`'s dynamic imports — a bundler replaces a missing
 * one with a runtime-throwing stub, so a consumer without them still builds
 * and fails loudly only if the editor actually loads (see mention-editor.tsx,
 * whose loader error names the complete install set).
 *
 * Built per retry rather than once at module scope: `lazy` caches a rejected
 * load forever, so recovering from a transient chunk-fetch failure needs a
 * fresh `lazy` identity (see `MentionEditorBoundary`).
 */
function createLazyMentionEditor() {
  return lazy(() => import('./mention-editor').then((m) => m.loadMentionEditor()))
}

/**
 * Contains a mention-editor failure to the input area. A rejected lazy chunk
 * (most likely the named missing-`@tiptap/*` error from `loadTiptapModules`)
 * would otherwise unwind past the composer and unmount the host's whole
 * region. This is containment, not a silent fallback: the error renders as a
 * visible alert naming the cause where the input would be — a misconfigured
 * consumer cannot mistake it for a working composer. Retry re-imports through
 * a fresh `lazy` identity — it recovers a transient fetch failure (a deploy
 * that invalidated chunk hashes, a network blip), while a missing peer just
 * fails loudly again.
 */
class MentionEditorBoundary extends Component<
  {
    onRetry: () => void
    /** Reported once per failure so the composer can gate Send — a draft the
     *  user can no longer see or edit must not stay dispatchable. */
    onFailed: () => void
    /** The current draft, shown read-only in the error state so its content
     *  is never invisible while it exists. */
    draft: string
    children: ReactNode
  },
  { error: unknown | null }
> {
  state: { error: unknown | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch() {
    this.props.onFailed()
  }

  render() {
    if (this.state.error === null) return this.props.children
    const message =
      this.state.error instanceof Error ? this.state.error.message : String(this.state.error)
    return (
      <div
        role="alert"
        data-testid="composer-mention-editor-error"
        className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1">The mention input failed to load: {message}</span>
          <button
            type="button"
            aria-label="Retry loading the mention input"
            onClick={this.props.onRetry}
            className="shrink-0 font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
          >
            Retry
          </button>
        </div>
        {this.props.draft.trim() !== '' && (
          <p
            data-testid="composer-error-held-draft"
            className="mt-1.5 max-h-20 overflow-y-auto whitespace-pre-wrap rounded-lg border border-destructive/30 bg-card px-2 py-1 text-foreground"
          >
            {this.props.draft}
          </p>
        )}
      </div>
    )
  }
}

// ── glyphs (no icon-library dependency) ───────────────────────────────────

/** The focus-shortcut hint names the platform's modifier: Cmd on Apple,
 *  Ctrl everywhere else (the handler itself listens for both). SSR-safe —
 *  defaults to Ctrl when there's no navigator to ask. */
const IS_APPLE_PLATFORM =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)

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

function ArrowUpGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 19V5M5 12l7-7 7 7" />
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

function RetryGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
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

function MicGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" />
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
  /** Object URL for an image thumbnail on the chip. The host owns the URL's
   *  whole life — `URL.createObjectURL` when the file is staged,
   *  `URL.revokeObjectURL` when it leaves — and the composer only reads it.
   *  `useComposerAttachments` already does both. */
  previewUrl?: string
  /** Why this file failed, shown on the chip while `status: 'error'`. Without
   *  it an error chip is red and mute, which tells the user nothing. */
  errorMessage?: string
}

/** A piece of context the agent will see beside the next message — an open
 *  file, a selected record, a pinned document. Rendered as its own chip row,
 *  separate from staged attachments: context is what the turn already carries,
 *  an attachment is what the user is adding to it. */
export interface ComposerContextItem {
  id: string
  label: string
  icon?: ReactNode
  /** Omit for a chip the user cannot dismiss. */
  onRemove?: () => void
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

/**
 * One `/` command the composer offers. Typing `/` at position 0 opens the
 * command menu; the rest of the token filters it (the same prefix > substring
 * > token-order ranking as the command palette). Picking a command CLEARS the
 * token from the draft and calls `run` — what the command does (a route, a
 * dialog, a draft transformation) is the product's business.
 */
export interface SlashCommand {
  /** Command name without the leading slash: `model`, `clear`. */
  name: string
  /** One line of what it does, rendered beside the name. */
  description: string
  run: () => void
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
   *  drag-and-drop and clipboard paste onto the input, and render
   *  `pendingFiles` chips. */
  onAttach?: (files: FileList) => void
  onAttachFolder?: (files: FileList) => void
  pendingFiles?: ComposerFile[]
  onRemoveFile?: (id: string) => void
  /** Pass it and a chip with `status: 'error'` gains a retry button. */
  onRetryFile?: (id: string) => void
  /**
   * File types the composer takes, in the native `<input accept>` grammar.
   * Enforced on every ingress route — the picker dialog (which the user can
   * override with "All Files"), drag-and-drop, and clipboard paste — so a type
   * the picker will not offer cannot arrive by another route. A non-matching
   * file goes to `onRejectFiles` and never reaches `onAttach`. Folder attach is
   * exempt: directory selection has no native accept semantics.
   */
  accept?: string
  /** Called with the files `accept` removed from a pick, drop, or paste, each
   *  with a reason. Without it a refusal is silent — the same feedback the
   *  native picker gives for a type it will not offer. */
  onRejectFiles?: (rejections: ComposerFileRejection[]) => void
  dropTitle?: string
  dropDescription?: string

  /** Context the agent will see beside the next message, as its own chip row
   *  above the input. */
  contextItems?: ReadonlyArray<ComposerContextItem>

  /**
   * Let a staged file stand in for message text, so the send control stays live
   * while an upload is in flight instead of going dead with nothing to explain
   * it. Default false, where an empty message needs a `ready` file.
   *
   * It does NOT make an unfinished file sendable. A turn whose only content is a
   * file that is still uploading or has failed never reaches the send handler —
   * it would arrive empty and the attachment would be lost. The composer
   * refuses it and names the reason in its notice
   * ({@link attachmentsNotReadyMessage}). So the flag decides whether the
   * control is live, and the composer keeps the integrity gate rather than
   * leaving each host to re-derive it.
   */
  canSubmitAttachmentsOnly?: boolean
  /** Notice copy when a send is refused because no staged file is ready yet.
   *  Defaults to wording chosen from whether a file failed or is still
   *  uploading. */
  attachmentsNotReadyMessage?: string
  /**
   * Let Enter and Send keep firing while `isStreaming`, for a surface that
   * queues the next turn rather than blocking on the current one. Default
   * false. The button still flips to Stop while a turn streams, so this opens
   * the keyboard path, not a second button.
   */
  canSubmitWhileBusy?: boolean

  /** Focus the input on mount — for a surface whose whole job is the input
   *  (an entry/hero composer), never for one docked under a transcript. */
  autoFocus?: boolean
  /** Rows the input shows before it grows. Default 2. */
  minRows?: number
  /** Pixel height the input grows to before it scrolls. Default 168. */
  maxHeight?: number
  /** Content between the controls slot and Send — a token meter, a cost, a
   *  status line. It sits outside the controls slot and never shrinks, so a
   *  wrapping picker set cannot push it away. */
  trailing?: ReactNode
  /**
   * Opt-in `@`-mentions. Present ⇒ the textarea is swapped for a lazily
   * loaded TipTap rich input that renders mentions as atomic pills and
   * serializes them to `@<id>` in the value; absent ⇒ exactly the plain
   * textarea, with no TipTap in the bundle. Wire `useFileMentions().mention`
   * straight in. The six `@tiptap/*` packages (core, extension-mention, pm,
   * react, starter-kit, suggestion) are OPTIONAL peers — a consumer installs
   * them to use this prop.
   *
   * The rich input owns its own keyboard surface, so `slashCommands` is
   * disabled while `mention` is set rather than left half-armed with a menu
   * no key can reach; no shipped surface combines the two. Seed and
   * failed-send drafts still apply in mention mode, but caret placement (a
   * textarea affordance) degrades to content-only.
   */
  mention?: ComposerMentionProp
  /** `/` commands offered when the draft is exactly a leading slash token.
   *  Omit (or pass []) and `/` types as ordinary text. Inert while `mention`
   *  is set — see {@link mention}. */
  slashCommands?: SlashCommand[]
  /** Dictation is opt-in: pass `onDictate` and the action row gains a mic
   *  button (browsers without `MediaRecorder`/`getUserMedia` render none).
   *  Click starts the capture; the button flips to a stop control with the
   *  running elapsed seconds; stop hands the recorded audio blob here. The
   *  composer owns capture only — turning the audio into text (e.g. the
   *  Whisper provider from `sequences-react`) is the host's. */
  onDictate?: (audio: DictationAudio) => void
  /** Capture failures (a denied mic prompt, no device), after the composer has
   *  shown its own dismissible notice. For hosts that log or track. */
  onDictateError?: (message: string) => void

  /** Cmd/Ctrl+L focuses the input and shows the hint. Default true. */
  focusShortcut?: boolean
  /** Float the card on a soft two-layer foreground-tinted shadow (opt-in).
   *  Elevation only — radius, ring, and control layout are unchanged. */
  floating?: boolean
  /** Send button label. Default "Send". */
  sendLabel?: string
  /** Send control shape. `pill` (default) is the labeled button; `icon` is the
   *  34px circular inverted arrow (streaming: circular outlined stop) — the
   *  grammar sandbox-ui's legacy AgentComposer used and the current agent-app
   *  canon for new surfaces. */
  sendVariant?: 'pill' | 'icon'
  className?: string
}

const DEFAULT_MAX_HEIGHT = 168

/** The input's own `leading-6` line box and its `py-1` padding, in pixels. The
 *  `minRows` floor is computed from them so the CSS floor and the `rows`
 *  attribute cannot drift apart at a row count other than the default. */
const LINE_HEIGHT = 24
const TEXTAREA_PADDING_Y = 8

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
  onDictate,
  onDictateError,

  focusShortcut = true,
  floating = false,
  sendLabel = 'Send',
  sendVariant = 'pill',
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
  // Bumped by the boundary's Retry: a new epoch mints a fresh `lazy` identity
  // (a rejected lazy caches its failure forever) and re-keys the boundary so
  // its error state clears.
  const [editorEpoch, setEditorEpoch] = useState(0)
  const MentionEditor = useMemo(createLazyMentionEditor, [editorEpoch])
  // While the mention editor is failed, the draft is visible only in the
  // boundary's read-only block — Send must not dispatch what the user cannot
  // edit.
  const [editorFailed, setEditorFailed] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)
  // Counts every clipboard image this composer has renamed, so two pastes of
  // the same bitmap do not both arrive as `image.png`.
  const pastedImageCount = useRef(0)

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
  // Depends on mention PRESENCE, not identity: hosts build the prop object
  // inline per render, and only the mode switch changes which input to focus.
  const mentionEnabled = mention != null
  useEffect(() => {
    if (!focusShortcut || disabled) return
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        if (mentionEnabled) {
          // No live editor yet (still loading, or failed): leave the
          // browser's own shortcut alone rather than swallowing it for
          // nothing.
          const focus = richFocusRef.current
          if (!focus) return
          e.preventDefault()
          focus()
        } else {
          e.preventDefault()
          textareaRef.current?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [focusShortcut, disabled, mentionEnabled])

  // A ready file counts as sendable content even without a `part`: store-backed
  // attachments (`useComposerAttachments`) carry no prompt part — their
  // references ride the turn body's `attachments` field — but a file-only
  // message must still be sendable. `canSubmitAttachmentsOnly` widens that to a
  // file of ANY status, so an in-flight upload leaves the control live and the
  // host's handler decides what to do about it.
  const sendableFiles = canSubmitAttachmentsOnly
    ? pendingFiles
    : pendingFiles.filter((f) => f.status === 'ready')
  const hasSendable = text.trim().length > 0 || sendableFiles.length > 0
  // Streaming blocks a send unless the host queues turns. The button still
  // shows Stop while streaming, so `canSubmitWhileBusy` opens Enter, not a
  // second visible control.
  const sendBlockedByStream = isStreaming && !canSubmitWhileBusy
  const editorInputLost = mention != null && editorFailed
  const canSend = hasSendable && !sendBlockedByStream && !disabled && !editorInputLost

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
    if (sendBlockedByStream || disabled || editorInputLost) return
    const readyFiles = pendingFiles.filter((f) => f.status === 'ready')
    const sendable = canSubmitAttachmentsOnly ? pendingFiles : readyFiles
    if (!trimmed && sendable.length === 0) return
    // `canSubmitAttachmentsOnly` keeps the control live while a file is staged,
    // but a turn carrying no text and no file the host can deliver must not go
    // out: it would arrive empty and the attachment would be lost. Refuse it
    // here and say why, rather than dispatching and trusting every host to
    // re-derive the same check.
    if (!trimmed && readyFiles.length === 0) {
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
    editorInputLost,
    canSubmitAttachmentsOnly,
    attachmentsNotReadyMessage,
    onSendParts,
    pendingFiles,
    setText,
    dispatchSend,
  ])

  // Re-send the message the notice is holding. Reached only when the draft was
  // NOT restored (the restored path leaves the text in the box, where Send is
  // the affordance), so it never competes with the primary control.
  const retryFailedSend = useCallback(() => {
    const failure = failedSend
    if (!failure || sendBlockedByStream || disabled) return
    setFailedSend(null)
    const caret = { start: failure.text.length, end: failure.text.length }
    dispatchSend(failure.text, failure.trimmed, failure.parts, caret)
  }, [failedSend, sendBlockedByStream, disabled, dispatchSend])

  // ── '/' commands ─────────────────────────────────────────────────────────
  // The menu exists only while the WHOLE draft is one leading slash token
  // (`/`, `/mod`). The first space ends it — arguments are ordinary text. Esc
  // or an outside click dismisses for the CURRENT token only, so continued
  // typing reopens the menu instead of leaving it permanently suppressed.
  const slashPanelRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const slashListId = useId()
  const [slashActive, setSlashActive] = useState(0)
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null)
  // `mention` disables the slash menu outright: its keydown/anchor wiring is
  // the textarea's, so a token match in the rich path would arm a menu no key
  // or click can reach. See the `mention` prop doc.
  const slashToken =
    !mention && slashCommands && slashCommands.length > 0 ? /^\/(\S*)$/.exec(text)?.[1] : undefined
  const slashOpen = slashToken !== undefined && text !== slashDismissedFor
  const slashItems = useMemo<CommandPaletteItem[]>(
    () =>
      (slashCommands ?? []).map((command) => ({
        id: command.name,
        group: 'Commands',
        label: `/${command.name}`,
        description: command.description,
        keywords: [command.name, command.description],
      })),
    [slashCommands],
  )
  const slashFiltered = useMemo(
    () => (slashToken === undefined ? [] : filterCommandPaletteItems(slashItems, slashToken)),
    [slashItems, slashToken],
  )
  const slashActiveIndex = slashFiltered.length === 0 ? 0 : Math.min(slashActive, slashFiltered.length - 1)

  useEffect(() => {
    setSlashActive(0)
  }, [slashToken])

  useEffect(() => {
    if (!slashOpen) return
    document
      .getElementById(`${slashListId}-${slashActiveIndex}`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [slashOpen, slashActiveIndex, slashListId])

  useEffect(() => {
    if (!slashOpen) return
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (cardRef.current?.contains(target)) return
      if (slashPanelRef.current?.contains(target)) return
      setSlashDismissedFor(textRef.current)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [slashOpen])

  const pickSlash = useCallback(
    (name: string) => {
      const command = slashCommands?.find((c) => c.name === name)
      // The draft IS the slash token (the menu only opens while it is), so the
      // pick consumes it: clear the box, then run.
      setText('')
      setSlashDismissedFor(null)
      command?.run()
    },
    [slashCommands, setText],
  )

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Respect IME composition — Enter commits the candidate, it doesn't send.
    if (e.nativeEvent.isComposing) return
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (slashFiltered.length > 0) setSlashActive((slashActiveIndex + 1) % slashFiltered.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (slashFiltered.length > 0)
          setSlashActive((slashActiveIndex - 1 + slashFiltered.length) % slashFiltered.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        const item = slashFiltered[slashActiveIndex]
        if (item) {
          e.preventDefault()
          pickSlash(item.id)
          return
        }
        // No command matched — fall through and let Enter send the raw text.
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissedFor(text)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // Every route a file can arrive by ends here: apply `accept`, report what it
  // removed, and hand `onAttach` only what passed. A batch the filter left
  // untouched is forwarded as the browser's own `FileList`; one it changed is
  // rebuilt, since `onAttach` takes a `FileList` and only a `DataTransfer` can
  // produce one.
  const deliverFiles = useCallback(
    (files: File[], original: FileList) => {
      if (!onAttach || files.length === 0) return
      const { accepted, rejected } = filterAcceptedFiles(files, accept)
      if (rejected.length > 0) onRejectFiles?.(rejected)
      if (accepted.length === 0) return
      const unchanged =
        accepted.length === original.length && accepted.every((file, i) => file === original[i])
      if (unchanged) {
        onAttach(original)
        return
      }
      const transfer = new DataTransfer()
      for (const file of accepted) transfer.items.add(file)
      onAttach(transfer.files)
    },
    [onAttach, onRejectFiles, accept],
  )

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    // Re-filter: a picker dialog lets the user override `accept` with
    // "All Files", so the attribute alone does not hold the gate.
    if (e.target.files?.length) deliverFiles(Array.from(e.target.files), e.target.files)
    e.target.value = ''
  }

  // One paste core for both input modes. Returns true when files were the
  // payload — the caller then suppresses the default text paste even when
  // every file is refused, so a rejection never half-pastes stray text.
  // The staged names go in alongside the count: the queue is the host's and
  // can outlive this mount, so the count alone could hand the next paste a
  // name the queue already holds.
  const ingestPastedFiles = (clipboardFiles: FileList): boolean => {
    if (!onAttach || clipboardFiles.length === 0) return false
    const { files, nextIndex } = renamePastedImages(
      Array.from(clipboardFiles),
      pastedImageCount.current,
      pendingFiles.map((f) => f.name),
    )
    pastedImageCount.current = nextIndex
    deliverFiles(files, clipboardFiles)
    return true
  }

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardFiles = e.clipboardData?.files
    if (!clipboardFiles || clipboardFiles.length === 0) return
    if (ingestPastedFiles(clipboardFiles)) e.preventDefault()
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
      if (files?.length) deliverFiles(Array.from(files), files)
    },
    [deliverFiles],
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

  // One floor for both input modes, so the mention editor and the textarea
  // cannot disagree about the empty-composer height.
  const inputMinHeight = minRows * LINE_HEIGHT + TEXTAREA_PADDING_Y

  return (
    <div
      className={`relative ${className ?? ''}`}
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
      <div
        ref={cardRef}
        data-testid="composer-card"
        className={`flex flex-col gap-1.5 rounded-2xl border border-card-edge bg-card px-3 py-2.5 transition focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15 ${
          floating ? 'shadow-raised' : ''
        }`}
      >
        {mention ? (
          // The editor arrives as a lazy chunk; until it lands, a read-only
          // textarea with the same metrics holds the layout so the card
          // doesn't jump. The boundary contains a failed load (e.g. the
          // missing-peer error) to the input area instead of unmounting the
          // host's region.
          <MentionEditorBoundary
            key={editorEpoch}
            onRetry={() => {
              setEditorFailed(false)
              setEditorEpoch((epoch) => epoch + 1)
            }}
            onFailed={() => setEditorFailed(true)}
            draft={text}
          >
            <Suspense
              fallback={
                <textarea
                  rows={minRows}
                  value={text}
                  readOnly
                  disabled
                  placeholder={placeholder}
                  aria-label="Message input"
                  style={{ minHeight: inputMinHeight, maxHeight }}
                  className="w-full resize-none bg-transparent px-1.5 py-1 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
                />
              }
            >
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
                registerFocus={registerRichFocus}
                onPasteFiles={onAttach ? ingestPastedFiles : undefined}
              />
            </Suspense>
          </MentionEditorBoundary>
        ) : (
          // Focus: `outline-none` is safe because the card above draws the
          // keyboard indicator through `focus-within:` — one ring for
          // whichever input mode is mounted.
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={onAttach ? handlePaste : undefined}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            // `minRows` lines before it grows. `rows` is what actually holds the
            // floor: the autosize measures `scrollHeight` against `height: auto`,
            // which a textarea resolves through `rows`, so the measurement cannot
            // come back shorter. The paired `minHeight` is those same lines in CSS
            // (`box-sizing: border-box` puts the padding inside it), computed from
            // the same row count so the two cannot disagree. It sits exactly AT
            // the natural height on purpose: a floor is meant to be inert until
            // something tries to go under it, which here means an inline height
            // arriving from anywhere but the autosize. Setting it higher would buy
            // no protection and cost permanent dead space under the caret.
            rows={minRows}
            style={{ minHeight: inputMinHeight, maxHeight }}
            aria-label="Message input"
            className="w-full resize-none bg-transparent px-1.5 py-1 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
        )}

        <div className="flex items-end gap-2">
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
            className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
          >
            {showInline && controls}
          </div>

          {/* Trailing content is the controls slot's SIBLING, not its content:
              the slot is where a picker set is allowed to wrap and shrink, and
              a meter or a status line put inside it would be pushed onto the
              second line by the very pickers it reports on. */}
          {trailing && (
            <div data-testid="composer-trailing" className="flex shrink-0 items-center gap-1.5">
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
                className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-border bg-transparent text-foreground transition hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <StopGlyph className="h-3 w-3" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onCancel}
                aria-label="Stop response"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/15 px-3.5 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
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
              className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-foreground text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
            >
              <ArrowUpGlyph className="h-4 w-4" />
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

      {/* The slash menu ports through PopoverSurface like every canonical
          popover: the composer docks inside horizontally scrolling rails, and
          an in-place panel there is a panel the host clips away. It anchors
          to the textarea and opens above. Focus never leaves the input —
          rows are mousedown-swallowed so a click can't blur it. */}
      <PopoverSurface
        open={slashOpen}
        id={slashListId}
        role="listbox"
        triggerRef={textareaRef}
        panelRef={slashPanelRef}
        className={`w-80 overflow-y-auto rounded-xl border border-card-edge bg-popover p-1 ${OVERLAY_SHADOW}`}
      >
        {slashFiltered.length === 0 && (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">No matching commands</div>
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
      </PopoverSurface>

      {focusShortcut && (
        <div className="mt-1.5 flex justify-end px-1">
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
