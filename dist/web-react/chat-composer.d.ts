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
import { type ReactNode } from 'react';
import { type ComposerFileRejection } from './composer-file-accept';
import { type DictationAudio } from './use-dictation';
import type { ComposerMentionProp } from './use-file-mentions';
/** Prompt-part descriptor an uploaded file carries (the upload route's
 *  `UploadedChatFile.part`), echoed back in the turn body on send. Mirrors
 *  `/chat-routes`' wire shape structurally — no server import here. */
export interface ComposerFilePart {
    type: 'image' | 'file';
    filename?: string;
    mediaType?: string;
    url?: string;
    path?: string;
    content?: string;
}
export interface ComposerFile {
    id: string;
    name: string;
    size?: number;
    kind: 'file' | 'folder';
    /** Number of files inside, for a folder chip. */
    fileCount?: number;
    status: 'pending' | 'uploading' | 'ready' | 'error';
    /** Uploaded part descriptor; set once the upload route returns. Only
     *  `status: 'ready'` files with a part travel on a parts-aware send. */
    part?: ComposerFilePart;
    /** Object URL for an image thumbnail on the chip. The host owns the URL's
     *  whole life — `URL.createObjectURL` when the file is staged,
     *  `URL.revokeObjectURL` when it leaves — and the composer only reads it.
     *  `useComposerAttachments` already does both. */
    previewUrl?: string;
    /** Why this file failed, shown on the chip while `status: 'error'`. Without
     *  it an error chip is red and mute, which tells the user nothing. */
    errorMessage?: string;
}
/** A piece of context the agent will see beside the next message — an open
 *  file, a selected record, a pinned document. Rendered as its own chip row,
 *  separate from staged attachments: context is what the turn already carries,
 *  an attachment is what the user is adding to it. */
export interface ComposerContextItem {
    id: string;
    label: string;
    icon?: ReactNode;
    /** Omit for a chip the user cannot dismiss. */
    onRemove?: () => void;
}
/** A send the host refused. `error` is shown verbatim in the composer's notice;
 *  omit it for the generic copy. */
export interface ComposerSendRejected {
    ok: false;
    error?: string;
}
/**
 * What a send handler reports back. `void` — what every handler returned before
 * this existed — reads as accepted, so wiring stays unchanged; a thrown error, a
 * rejected promise, or `{ ok: false }` is the rejection that restores the draft.
 * A handler that resolves only when the whole turn finishes still reports
 * correctly: the input already cleared on dispatch, so the answer only decides
 * whether the draft comes back.
 */
export type ComposerSendOutcome = void | {
    ok: true;
} | ComposerSendRejected;
export type ComposerSendResult = ComposerSendOutcome | Promise<ComposerSendOutcome>;
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
export type ComposerSendHandler = ((message: string) => void) | ((message: string) => ComposerSendResult);
/** @see ComposerSendHandler — the parts-aware arity, same union for the same reason. */
export type ComposerSendPartsHandler = ((message: string, parts: ComposerFilePart[]) => void) | ((message: string, parts: ComposerFilePart[]) => ComposerSendResult);
/** The rejected send, handed to `onSendFailed` so the host can undo whatever it
 *  cleared optimistically — most importantly the staged attachments, which the
 *  composer does not own (`pendingFiles` is a prop). */
export interface ComposerSendFailure {
    /** The reason as the composer renders it. */
    message: string;
    /** The user's exact draft, untrimmed. */
    text: string;
    /** The parts the rejected send carried. */
    parts: ComposerFilePart[];
    /** Whatever the handler threw / rejected with, or the `{ ok: false }` value. */
    error: unknown;
    /** True when the draft was put back in the textarea (the box was empty).
     *  False means the user had typed a replacement, so the unsent text is held in
     *  the notice instead. */
    restored: boolean;
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
    name: string;
    /** One line of what it does, rendered beside the name. */
    description: string;
    run: () => void;
}
export interface ChatComposerProps {
    /** Send the trimmed, non-empty message. Attached files travel separately via
     *  `onAttach` + `pendingFiles` (the host consumes and clears them on send).
     *  Optional when `onSendParts` is wired.
     *
     *  Report a refused send by throwing, rejecting, or returning `{ ok: false }`
     *  — the composer restores the draft rather than losing it. */
    onSend?: ComposerSendHandler;
    /** Parts-aware send: receives the trimmed message plus the `part`
     *  descriptors of every `ready` pending file. Takes precedence over
     *  `onSend`; enables file-only sends (empty text, ≥1 ready part).
     *
     *  Same rejection contract as `onSend`. */
    onSendParts?: ComposerSendPartsHandler;
    /** Notified when a send is rejected, after the composer has restored what it
     *  owns. The host uses it to put back the `pendingFiles` it consumed. */
    onSendFailed?: (failure: ComposerSendFailure) => void;
    /** Notice copy when the handler names no reason of its own. */
    sendFailureMessage?: string;
    /** Stop the in-flight turn; shown in place of Send while `isStreaming`. */
    onCancel?: () => void;
    isStreaming?: boolean;
    /** Block input + send (e.g. while restoring). Distinct from `isStreaming`,
     *  which keeps the textarea editable so the next turn can be composed. */
    disabled?: boolean;
    placeholder?: string;
    /** Controlled value. Omit for self-managed internal state (cleared on send). */
    value?: string;
    onValueChange?: (value: string) => void;
    /** Initial text in uncontrolled mode; ignored when `value` is provided. */
    initialValue?: string;
    /** One-shot external prefill: when this becomes a non-null string the
     *  composer adopts it as the draft (replacing any current draft), focuses the
     *  input with the caret at the end, and reports consumption via
     *  `onSeedApplied` so the host can clear its seed state. */
    seed?: string | null;
    onSeedApplied?: () => void;
    /** Inline controls (e.g. `<ModelPicker/>` + `<EffortPicker/>` or
     *  `<AgentSessionControls/>`). */
    controls?: ReactNode;
    /**
     * Where {@link controls} sit. `inline` (default) puts them on the card's own
     * action row, beside attach and Send — the model a turn will use reads as
     * part of the input rather than as a separate widget floating above it.
     * `above` keeps them outside the card, for a host that wants the input to be
     * nothing but the input.
     */
    controlsPlacement?: 'above' | 'inline';
    /** Attachments are opt-in: pass `onAttach` to show the attach button, accept
     *  drag-and-drop and clipboard paste onto the input, and render
     *  `pendingFiles` chips. */
    onAttach?: (files: FileList) => void;
    onAttachFolder?: (files: FileList) => void;
    pendingFiles?: ComposerFile[];
    onRemoveFile?: (id: string) => void;
    /** Pass it and a chip with `status: 'error'` gains a retry button. */
    onRetryFile?: (id: string) => void;
    /**
     * File types the composer takes, in the native `<input accept>` grammar.
     * Enforced on every ingress route — the picker dialog (which the user can
     * override with "All Files"), drag-and-drop, and clipboard paste — so a type
     * the picker will not offer cannot arrive by another route. A non-matching
     * file goes to `onRejectFiles` and never reaches `onAttach`. Folder attach is
     * exempt: directory selection has no native accept semantics.
     */
    accept?: string;
    /** Called with the files `accept` removed from a pick, drop, or paste, each
     *  with a reason. Without it a refusal is silent — the same feedback the
     *  native picker gives for a type it will not offer. */
    onRejectFiles?: (rejections: ComposerFileRejection[]) => void;
    dropTitle?: string;
    dropDescription?: string;
    /** Context the agent will see beside the next message, as its own chip row
     *  above the input. */
    contextItems?: ReadonlyArray<ComposerContextItem>;
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
    canSubmitAttachmentsOnly?: boolean;
    /** Notice copy when a send is refused because no staged file is ready yet.
     *  Defaults to wording chosen from whether a file failed or is still
     *  uploading. */
    attachmentsNotReadyMessage?: string;
    /**
     * Let Enter and Send keep firing while `isStreaming`, for a surface that
     * queues the next turn rather than blocking on the current one. Default
     * false. The button still flips to Stop while a turn streams, so this opens
     * the keyboard path, not a second button.
     */
    canSubmitWhileBusy?: boolean;
    /** Focus the input on mount — for a surface whose whole job is the input
     *  (an entry/hero composer), never for one docked under a transcript. */
    autoFocus?: boolean;
    /** Rows the input shows before it grows. Default 2. */
    minRows?: number;
    /** Pixel height the input grows to before it scrolls. Default 168. */
    maxHeight?: number;
    /** Content between the controls slot and Send — a token meter, a cost, a
     *  status line. It sits outside the controls slot and never shrinks, so a
     *  wrapping picker set cannot push it away. */
    trailing?: ReactNode;
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
    mention?: ComposerMentionProp;
    /** `/` commands offered when the draft is exactly a leading slash token.
     *  Omit (or pass []) and `/` types as ordinary text. Inert while `mention`
     *  is set — see {@link mention}. */
    slashCommands?: SlashCommand[];
    /** Dictation is opt-in: pass `onDictate` and the action row gains a mic
     *  button (browsers without `MediaRecorder`/`getUserMedia` render none).
     *  Click starts the capture; the button flips to a stop control with the
     *  running elapsed seconds; stop hands the recorded audio blob here. The
     *  composer owns capture only — turning the audio into text (e.g. the
     *  Whisper provider from `sequences-react`) is the host's. */
    onDictate?: (audio: DictationAudio) => void;
    /** Capture failures (a denied mic prompt, no device), after the composer has
     *  shown its own dismissible notice. For hosts that log or track. */
    onDictateError?: (message: string) => void;
    /** Cmd/Ctrl+L focuses the input and shows the hint. Default true. */
    focusShortcut?: boolean;
    /** Float the card on a soft two-layer foreground-tinted shadow (opt-in).
     *  Elevation only — radius, ring, and control layout are unchanged. */
    floating?: boolean;
    /** Send button label. Default "Send". */
    sendLabel?: string;
    /** Send control shape. `pill` (default) is the labeled button; `icon` is the
     *  34px circular inverted arrow (streaming: circular outlined stop) — the
     *  grammar sandbox-ui's legacy AgentComposer used and the current agent-app
     *  canon for new surfaces. */
    sendVariant?: 'pill' | 'icon';
    /** Circular icon send colour. `contrast` (default) preserves the inverted
     *  foreground/background canon; `primary` opts into the host brand tokens.
     *  The labeled pill already uses primary and is unchanged. */
    sendTone?: 'contrast' | 'primary';
    className?: string;
}
export declare function ChatComposer({ onSend, onSendParts, onSendFailed, sendFailureMessage, onCancel, isStreaming, disabled, placeholder, value, onValueChange, initialValue, seed, onSeedApplied, controls, controlsPlacement, onAttach, onAttachFolder, pendingFiles, onRemoveFile, onRetryFile, accept, onRejectFiles, dropTitle, dropDescription, contextItems, canSubmitAttachmentsOnly, attachmentsNotReadyMessage, canSubmitWhileBusy, autoFocus, minRows, maxHeight, trailing, mention, slashCommands, onDictate, onDictateError, focusShortcut, floating, sendLabel, sendVariant, sendTone, className, }: ChatComposerProps): import("react").JSX.Element;
