import { AgentProfilePicker } from '@tangle-network/sandbox-ui/chat'
import type { AgentProfilePickerProps } from '@tangle-network/sandbox-ui/chat'

/** The selection half of a thread's profile: the picker's own field names, so a rename upstream cannot drift past this. */
export type ComposerProfileSelection = Pick<AgentProfilePickerProps, 'value' | 'onChange' | 'profiles' | 'disabled'>

export interface ComposerProfilePillProps extends Pick<AgentProfilePickerProps, 'locked' | 'lockReason' | 'onNewChat' | 'side' | 'capabilities' | 'onCreate' | 'onUpdate' | 'onDelete'> {
  /** The catalog and the current choice; products pass their server-resolvable profiles only. */
  selection: ComposerProfileSelection
  /**
   * Where the pill sits.
   * - `composer` (default): in {@link ChatComposer}'s `controls` row, beside the
   *   model and effort pickers, at their height and with a capped width.
   * - `menu-row`: the top row of a stacked agent menu panel, spanning it at the
   *   36px row height of the model and backend rows below it.
   * - `mode-strip`: a quiet transparent pill inside a horizontally scrolling
   *   mode strip (chat-react's `ComposerModeControls` `modes` slot), with an
   *   inset focus ring the strip's edges cannot clip.
   */
  placement?: 'composer' | 'menu-row' | 'mode-strip'
  className?: string
}

// sandbox-ui's `cn` is tailwind-merge, so these replace the picker's default
// trigger classes rather than stacking with them.
const TRIGGER: Record<NonNullable<ComposerProfilePillProps['placement']>, string> = {
  composer: 'max-w-[180px]',
  // A menu panel repoints surface-container to its own tone, which would leave
  // the picker's default fill invisible there, so the row brings bg-card.
  'menu-row':
    'h-9 w-full justify-between gap-1.5 rounded-full border-border bg-card px-3 text-sm font-medium ' +
    'text-foreground shadow-none hover:border-border hover:bg-accent ' +
    'data-[state=open]:border-border data-[state=open]:bg-accent',
  // The strip scrolls horizontally and clips an outward ring at its edges, so
  // the ring is drawn inside the trigger's own box.
  'mode-strip':
    'h-7 gap-1 rounded-full border-border bg-transparent font-normal text-muted-foreground shadow-none ' +
    'hover:border-border hover:bg-transparent hover:text-foreground ' +
    'data-[state=open]:border-border data-[state=open]:bg-transparent data-[state=open]:text-foreground ' +
    'focus-visible:ring-inset',
}

/**
 * The thread's agent profile as a composer control. The server owns catalog
 * writes and selection; pass its callbacks to enable authoring and switching
 * within the current conversation. `locked` is reserved for a product-specific
 * admission constraint, not a conversation that already has messages.
 */
export function ComposerProfilePill({
  selection,
  locked,
  lockReason,
  onNewChat,
  capabilities,
  onCreate,
  onUpdate,
  onDelete,
  side,
  placement = 'composer',
  className,
}: ComposerProfilePillProps) {
  return (
    <AgentProfilePicker
      value={selection.value}
      onChange={selection.onChange}
      profiles={selection.profiles}
      disabled={selection.disabled}
      locked={locked}
      lockReason={lockReason}
      onNewChat={onNewChat}
      capabilities={capabilities}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onDelete={onDelete}
      side={side}
      // The picker root shrink-wraps, which makes a trigger's own `w-full` a
      // no-op, so a full-width row widens the root as well.
      className={placement === 'menu-row' ? `w-full ${className ?? ''}`.trim() : className}
      triggerClassName={TRIGGER[placement]}
    />
  )
}
