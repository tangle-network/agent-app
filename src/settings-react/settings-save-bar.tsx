/**
 * The one save bar a group of settings may have, for values that only make
 * sense saved together (a set of spend caps). Save is the primary action only
 * while there are changes; a refusal shows its sentence here and the edits
 * stay. "Saved" shows for two seconds after `state` becomes `saved`, as a
 * row's does.
 *
 * The bar stays in reach while it has something to report: unsaved changes, a
 * refusal, "Saved", or a `summary` the product shows after a save.
 *
 * - `placement="footer"` (the default): pass it as a `SettingsSection` footer.
 *   On a narrow card the footer sticks to the bottom of the screen while the
 *   bar reports, so Save stays in reach while the person scrolls the fields
 *   above it.
 * - `placement="group"`: one save covers several cards. Render the bar after
 *   the last of them, in the same column. It is its own card on the muted
 *   plane and, while it reports, stays at the bottom of the screen at every
 *   width, over every card above it, until the person scrolls past it.
 */

import { Button, Card } from '@tangle-network/ui/primitives'
import { CircleAlert, Lock } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { SAVED_VISIBLE_MS, SavedStatus } from './save-status'

// These style the footer the bar sits in (`:has(> bar)`): the bar is that
// footer's only child, so only the footer can stick within the card.
const STICKY_FOOTER = '@max-[34rem]/settings-section:[:has(>&)]:sticky @max-[34rem]/settings-section:[:has(>&)]:bottom-0 @max-[34rem]/settings-section:[:has(>&)]:z-10'
// A group bar's containing block is the column of cards, so it sticks over all of them.
const STICKY_GROUP = 'sticky bottom-3 z-10 shadow-[var(--shadow-dropdown)]'

export interface SettingsSaveBarProps {
  /** How many values differ from the saved ones. */
  changes: number
  /** Replaces the "2 unsaved changes" count. */
  summary?: ReactNode
  onDiscard: () => void
  onSave: () => void
  state: 'idle' | 'saving' | 'saved' | 'failed'
  /** The refusal to show while `state` is `failed`. */
  error?: ReactNode
  /** The verb on the save button. */
  saveLabel?: string
  /** Why the person cannot save, naming who can. Replaces the buttons' availability. */
  disabledReason?: ReactNode
  /** `footer` in one card's footer; `group` after the several cards one save covers. */
  placement?: 'footer' | 'group'
}

export function SettingsSaveBar({
  changes,
  summary,
  onDiscard,
  onSave,
  state,
  error,
  saveLabel = 'Save changes',
  disabledReason,
  placement = 'footer',
}: SettingsSaveBarProps) {
  const saving = state === 'saving'
  const dirty = changes > 0
  const [showSaved, setShowSaved] = useState(state === 'saved')
  useEffect(() => {
    setShowSaved(state === 'saved')
    if (state !== 'saved') return
    const timer = setTimeout(() => setShowSaved(false), SAVED_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [state])
  const refused = state === 'failed' && error != null
  const message = disabledReason != null
    ? <span className="flex items-start gap-1.5 text-muted-foreground"><Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span className="min-w-0">{disabledReason}</span></span>
    : refused
      ? <span role="alert" className="flex items-start gap-1.5 text-[var(--surface-danger-text)]"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">{error}</span></span>
      : summary ?? (dirty
        ? <span className="text-muted-foreground">{changes === 1 ? '1 unsaved change' : `${changes} unsaved changes`}</span>
        : showSaved ? <SavedStatus /> : <span className="text-muted-foreground">No unsaved changes</span>)
  const reporting = dirty || refused || showSaved || (state === 'saved' && summary != null)
  const sticky = reporting && disabledReason == null
  const group = placement === 'group'
  const bar = (
    <div
      className={`flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-2${sticky && !group ? ` ${STICKY_FOOTER}` : ''}`}
      data-settings-save-bar
      data-dirty={dirty || undefined}
      data-sticky={sticky || undefined}
    >
      <div aria-live="polite" className="min-w-0 text-sm">{message}</div>
      {disabledReason == null && (
        <div className="ml-auto flex shrink-0 gap-2">
          {dirty && <Button type="button" variant="ghost" disabled={saving} onClick={onDiscard}>Discard</Button>}
          <Button type="button" variant={dirty ? 'default' : 'outline'} disabled={!dirty || saving} loading={saving} onClick={onSave}>
            {saveLabel}
          </Button>
        </div>
      )}
    </div>
  )
  if (!group) return bar
  // The card is the width container, as a section's is, so the bar's gutters match the cards above it.
  return (
    <Card className={`@container/settings-section min-w-0 bg-muted${sticky ? ` ${STICKY_GROUP}` : ''}`} data-settings-save-group>
      <div className="flex px-5 py-3 text-sm leading-5 @max-[34rem]/settings-section:px-4">{bar}</div>
    </Card>
  )
}
