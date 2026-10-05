/**
 * The assistant panel's open/close control. It mirrors the left sidebar's
 * collapse control in the shared dashboard shell: the same panel glyph (here
 * the right-hand one), the same 32px target and 18px glyph, quiet until hover.
 * The dock renders it floating at the top right while the panel is closed and
 * in the panel header's inner edge while it is open; a host with its own top
 * bar (a phone header) renders it there instead.
 */

import { focusRing } from "@tangle-network/ui/utils";
import { PanelRight } from "lucide-react";
import type { CSSProperties, Ref } from "react";
import { useOptionalAssistantLauncher } from "./launcher";

/** DOM id of the open panel, for the toggle's `aria-controls`. */
export const ASSISTANT_PANEL_ID = "assistant-panel";

function isApplePlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "")
  );
}

/** The shortcut as the user's keyboard labels it. */
export function assistantShortcutLabel(): string {
  return isApplePlatform() ? "⌘E" : "Ctrl+E";
}

export interface AssistantPanelToggleProps {
  /** Override the launcher's open state (the panel header passes `true`). */
  open?: boolean;
  /** Override the launcher's toggle (the panel header passes its `onClose`). */
  onToggle?: () => void;
  className?: string;
  style?: CSSProperties;
  buttonRef?: Ref<HTMLButtonElement>;
}

export function AssistantPanelToggle({
  open: openOverride,
  onToggle,
  className,
  style,
  buttonRef,
}: AssistantPanelToggleProps) {
  const launcher = useOptionalAssistantLauncher();
  const open = openOverride ?? launcher?.open ?? false;
  const toggleAssistant = onToggle ?? launcher?.toggleAssistant;
  const label = open ? "Close assistant" : "Open assistant";
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => toggleAssistant?.()}
      aria-label={label}
      aria-expanded={open}
      // Only while the panel exists: an id reference to nothing fails a11y checks.
      aria-controls={open && launcher ? ASSISTANT_PANEL_ID : undefined}
      aria-keyshortcuts="Meta+E Control+E"
      title={`${label} (${assistantShortcutLabel()})`}
      style={style}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--accent-surface-soft)] hover:text-foreground ${focusRing} ${className ?? ""}`}
    >
      <PanelRight aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
    </button>
  );
}
