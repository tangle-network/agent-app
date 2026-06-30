/**
 * ChatComposer — the shared message input, now a thin wrapper over the canonical
 * `AgentComposer` from `@tangle-network/sandbox-ui`. The bespoke implementation
 * is gone; this preserves ChatComposer's API (controlled/uncontrolled value,
 * `onSend`, attachments, streaming Stop, a `controls` slot, Cmd/Ctrl+L focus) and
 * maps it onto the one shared composer, so every agent-app surface and sandbox-ui
 * render the same input box.
 *
 * Theming: AgentComposer is authored against the brand MD3 surface tokens; the
 * agent-app theme (`@tangle-network/agent-app/styles` + `/tailwind-preset`)
 * bridges those onto its shadcn palette, so this renders on-palette in any
 * agent-app shell. Consumers must also have their Tailwind scan sandbox-ui's
 * dist so the composer's classes are generated.
 */

import { useCallback, useState, type ReactNode } from "react";
import {
  AgentComposer,
  type ComposerFile as SandboxComposerFile,
} from "@tangle-network/sandbox-ui/chat";

/** Re-exported from sandbox-ui — the staged-attachment chip shape. */
export type ComposerFile = SandboxComposerFile;

export interface ChatComposerProps {
  /** Send the trimmed, non-empty message. Attached files travel separately via
   *  `onAttach` + `pendingFiles` (the host consumes and clears them on send). */
  onSend: (message: string) => void;
  /** Stop the in-flight turn; shown in place of Send while `isStreaming`. */
  onCancel?: () => void;
  isStreaming?: boolean;
  /** Block input + send (e.g. while restoring). */
  disabled?: boolean;
  placeholder?: string;

  /** Controlled value. Omit for self-managed internal state (cleared on send). */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Initial text in uncontrolled mode; ignored when `value` is provided. */
  initialValue?: string;

  /** Inline controls (e.g. `<AgentSessionControls/>`), rendered in the control row. */
  controls?: ReactNode;
  /**
   * @deprecated The composer renders a single control row; this no longer moves
   * the controls above the input. Retained for API compatibility.
   */
  controlsPlacement?: "above" | "footer";

  /** Attachments are opt-in: pass `onAttach` to show the attach button, accept
   *  drag-and-drop onto the input, and render `pendingFiles` chips. */
  onAttach?: (files: FileList) => void;
  onAttachFolder?: (files: FileList) => void;
  pendingFiles?: ComposerFile[];
  onRemoveFile?: (id: string) => void;
  accept?: string;
  dropTitle?: string;
  dropDescription?: string;

  /** Cmd/Ctrl+L focuses the input and shows the hint. Default true. */
  focusShortcut?: boolean;
  /** Send button label (aria/title; the button is an icon). Default "Send". */
  sendLabel?: string;
  className?: string;
}

export function ChatComposer({
  onSend,
  onCancel,
  isStreaming = false,
  disabled = false,
  placeholder = "Message the agent…",
  value,
  onValueChange,
  initialValue,
  controls,
  onAttach,
  onAttachFolder,
  pendingFiles,
  onRemoveFile,
  accept,
  dropTitle,
  dropDescription,
  focusShortcut = true,
  sendLabel = "Send",
  className,
}: ChatComposerProps) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = useState(initialValue ?? "");
  const text = isControlled ? value : internal;

  const setText = useCallback(
    (next: string) => {
      if (!isControlled) setInternal(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming || disabled) return;
    onSend(trimmed);
    // Always signal a clear: uncontrolled resets internal state; controlled
    // notifies the host via onValueChange (the input stays until it re-renders).
    setText("");
  }, [text, isStreaming, disabled, onSend, setText]);

  return (
    <AgentComposer
      value={text}
      onChange={setText}
      onSubmit={handleSubmit}
      placeholder={placeholder}
      disabled={disabled}
      busy={isStreaming}
      onCancel={onCancel}
      controls={controls}
      onAttach={onAttach}
      onAttachFolder={onAttachFolder}
      attachments={pendingFiles}
      onRemoveFile={onRemoveFile}
      accept={accept}
      dropTitle={dropTitle}
      dropDescription={dropDescription}
      focusShortcut={focusShortcut}
      sendLabel={sendLabel}
      className={className}
    />
  );
}
