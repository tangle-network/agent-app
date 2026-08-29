import { useState, type ReactNode } from 'react'
import { ChatComposer } from './chat-composer'
import { ATTACHMENT_ACCEPT, useComposerAttachments } from './use-composer-attachments'
import type { ComposerFileRejection } from './composer-file-accept'
import type { UseFileMentionsResult } from './use-file-mentions'
import type { ChatAttachmentInput, FileMention } from '../chat-routes/wire'
import {
  AgentSessionControls,
  type AgentSessionControlsProps,
} from './agent-session-controls'
import { ComposerModeControls, type ComposerPlanModeSelection } from './composer-mode-controls'

export interface EntryComposerProps {
  /** The one line above the input. Domain copy — always a product parameter. */
  heading?: ReactNode
  /** Optional supporting line under the heading. */
  subheading?: ReactNode
  placeholder?: string
  initialValue?: string
  sendLabel?: string
  disabled?: boolean
  /**
   * Agent identity (backend/model/effort). Pass it and the control row renders;
   * omit it and the composer ships without one. Omitting is a real choice for a
   * surface with nothing to choose — it should never be an oversight, which is
   * why this is one prop rather than a free-form slot a caller can forget.
   *
   * This is the CANONICAL picker cluster: `AgentSessionControls` from
   * `/web-react` (its model menu IS the canonical `ModelPicker`). The legacy
   * sandbox-ui adapter that used to back this prop was removed; the props
   * mapping for migrating a stored selection lives in
   * `docs/ui-picker-canon.md`.
   */
  agent?: AgentSessionControlsProps
  /**
   * Product-specific behavioral controls docked on the LEFT. A mode is an
   * on/off switch, not a value picker, so it sits apart from agent identity.
   * For the standard plan-approval control, prefer `planMode`.
   */
  modes?: ReactNode
  /**
   * Standard plan-approval mode. Pass only when the selected backend supports
   * it; omitted means the control is not rendered.
   */
  planMode?: ComposerPlanModeSelection
  /**
   * Upload endpoint for staged attachments. Omit and the attach affordance is
   * hidden — a composer with no place to put a file must not offer one.
   */
  uploadUrl?: string
  accept?: string
  onAttachmentError?: (reason: string) => void
  /** Files rejected by this composer's attachment policy. */
  onRejectFiles?: (rejections: ComposerFileRejection[]) => void
  /**
   * `@`-file mentions. The hook itself is shared (`useFileMentions`), but the
   * cold-box policy around it — whether pressing `@` is worth starting a
   * sandbox — is a per-surface product call, so the result is injected rather
   * than created here.
   */
  mentions?: UseFileMentionsResult
  mentionPopoverClassName?: string
  /** Rendered under the composer: suggestion pills, an onboarding nudge, a
   *  disclaimer. All domain copy. */
  footer?: ReactNode
  /** Block submit until a persisted selection has resolved against the catalog,
   *  so the first turn cannot go out under the wrong model. Defaults to true. */
  ready?: boolean
  onSubmit: (
    prompt: string,
    attachments: ChatAttachmentInput[],
    mentions: FileMention[],
  ) => void
  className?: string
  composerClassName?: string
  /** Max width of the centered column. Defaults to the fleet's 820px. */
  maxWidth?: number
}

/**
 * `EntryComposer` — the centered "what do you want to work on?" surface a
 * product shows before a conversation exists (a new thread, an empty session,
 * a workspace overview).
 *
 * It exists because three products each grew their own, and they drifted into
 * three different capability sets rather than three different looks: one lost
 * the attach button, one lost the model and effort pickers entirely, one
 * hand-rolled a `<textarea>` and wired pickers from three separate packages
 * into one row. The composer, the pickers, the attachment queue and the mention
 * index were all ALREADY shared — what was not shared was the assembly, so
 * every product re-derived which controls an entry surface gets, and each
 * re-derivation dropped a different one.
 *
 * Mechanism lives here: layout, the attachment queue, the mention wiring, the
 * submit gate (nothing sends while an upload is pending or failed, or before
 * the model selection has resolved). Domain stays a parameter: `heading`,
 * `placeholder`, `footer` (suggestion pills, disclaimers) and the selections
 * themselves.
 *
 * The input is `ChatComposer` — the same component a docked in-thread
 * composer renders directly; this assembly adds only the hero layout around
 * it.
 */
export function EntryComposer({
  heading,
  subheading,
  placeholder,
  initialValue = '',
  sendLabel,
  disabled,
  agent,
  modes,
  planMode,
  uploadUrl,
  accept = ATTACHMENT_ACCEPT,
  onAttachmentError,
  onRejectFiles,
  mentions,
  mentionPopoverClassName,
  footer,
  ready = true,
  onSubmit,
  className,
  composerClassName,
  maxWidth = 820,
}: EntryComposerProps) {
  const [value, setValue] = useState(initialValue)
  const attachments = useComposerAttachments({
    uploadUrl,
    enabled: !!uploadUrl,
    onReject: onAttachmentError,
    onError: onAttachmentError,
  })

  function submit(prompt: string) {
    if (!ready || disabled) return
    const next = prompt.trim()
    // A pending or failed upload must not send: the turn would reference an
    // attachment the store does not have. Surface why rather than no-op'ing.
    if (attachments.hasPending || attachments.hasError) {
      if (attachments.blockReason) onAttachmentError?.(attachments.blockReason)
      return
    }
    if (!next && attachments.references.length === 0) return
    onSubmit(next, attachments.references, mentions?.mentions ?? [])
    setValue('')
    attachments.clear()
    mentions?.clearMentions()
  }

  return (
    <div
      className={
        className ??
        'relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-background px-5'
      }
    >
      <div className="w-full" style={{ maxWidth }}>
        {heading ? (
          <h2 className="mb-4 text-center text-[1.75rem] font-medium tracking-tight text-foreground">
            {heading}
          </h2>
        ) : null}
        {subheading ? (
          <p className="mx-auto mb-9 max-w-md text-center text-sm leading-relaxed text-muted-foreground">
            {subheading}
          </p>
        ) : (
          heading ? <div className="mb-7" /> : null
        )}
        <ChatComposer
          className={composerClassName ?? 'vt-composer'}
          value={value}
          onValueChange={setValue}
          onSend={(message) => submit(message)}
          placeholder={placeholder}
          sendLabel={sendLabel}
          // The circular arrow AgentComposer shipped and the agent-app canon
          // for new surfaces.
          sendVariant="icon"
          disabled={disabled}
          autoFocus
          // A hero composer autofocuses on mount, so the Cmd/Ctrl+L hint
          // would advertise a shortcut to the input the user is already in.
          focusShortcut={false}
          canSubmitAttachmentsOnly
          accept={accept}
          pendingFiles={attachments.composerFiles}
          onAttach={uploadUrl ? (files) => void attachments.addFiles(files) : undefined}
          onRejectFiles={onRejectFiles}
          onRemoveFile={attachments.removeAttachment}
          onRetryFile={attachments.retry}
          mention={
            mentions
              ? {
                  ...mentions.mention,
                  // Sidebar tone + hairline so the popover reads as app chrome
                  // (the same treatment the picker menus get) instead of the
                  // brighter overlay tone the component defaults to.
                  popoverClassName:
                    mentionPopoverClassName ??
                    'bg-surface-container-low border-[var(--md3-outline-variant)]',
                }
              : undefined
          }
          controls={modes ?? <ComposerModeControls planMode={planMode} />}
          trailing={
            agent ? <AgentSessionControls {...agent} /> : undefined
          }
        />
        {footer ? <div className="mt-7">{footer}</div> : null}
      </div>
    </div>
  )
}
