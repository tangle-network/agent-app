import { AgentProfilePicker } from '@tangle-network/sandbox-ui/chat'
import type { AgentProfilePickerProps } from '@tangle-network/sandbox-ui/chat'

/** The selection half of a thread's profile: the picker's own field names, so a rename upstream cannot drift past this. */
export type ComposerProfileSelection = Pick<AgentProfilePickerProps, 'value' | 'onChange' | 'profiles' | 'disabled'>

export interface ComposerProfilePillProps extends Pick<AgentProfilePickerProps, 'locked' | 'lockReason' | 'onNewChat' | 'side'> {
  /** The catalog and the current choice; products pass their server-resolvable profiles only. */
  selection: ComposerProfileSelection
  /**
   * Where the pill sits.
   * - `composer` (default): in {@link ChatComposer}'s `controls` row, beside the
   *   model and effort pickers, at their height and with a capped width.
   * - `menu-row`: the top row of a stacked agent menu panel, spanning it at the
   *   36px row height of the model and backend rows below it.
   */
  placement?: 'composer' | 'menu-row'
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
}

/**
 * The thread's agent profile as a composer control. Selection only: no create,
 * edit or delete handlers are wired, so it offers exactly the catalog the
 * server resolves. A thread's profile is fixed once its first message exists;
 * pass `locked` then, and `onNewChat` to offer a fresh thread from the lock.
 */
export function ComposerProfilePill({
  selection,
  locked,
  lockReason = 'The profile is fixed after the first message.',
  onNewChat,
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
      side={side}
      // The picker root shrink-wraps, which makes a trigger's own `w-full` a
      // no-op, so a full-width row widens the root as well.
      className={placement === 'menu-row' ? `w-full ${className ?? ''}`.trim() : className}
      triggerClassName={TRIGGER[placement]}
    />
  )
}
