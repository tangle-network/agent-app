/**
 * The one save bar a group of settings may have, for values that only make
 * sense saved together (a set of spend caps). Pass it as a `SettingsSection`
 * footer. Save is the primary action only while there are changes; a refusal
 * shows its sentence here and the edits stay.
 */

import { Button } from '@tangle-network/ui/primitives'
import { CircleAlert, Lock } from 'lucide-react'
import type { ReactNode } from 'react'
import { SavedStatus } from './save-status'

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
}: SettingsSaveBarProps) {
  const saving = state === 'saving'
  const dirty = changes > 0
  const message = disabledReason != null
    ? <span className="flex items-start gap-1.5 text-muted-foreground"><Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span className="min-w-0">{disabledReason}</span></span>
    : state === 'failed' && error != null
      ? <span role="alert" className="flex items-start gap-1.5 text-[var(--surface-danger-text)]"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">{error}</span></span>
      : summary ?? (dirty
        ? <span className="text-muted-foreground">{changes === 1 ? '1 unsaved change' : `${changes} unsaved changes`}</span>
        : state === 'saved' ? <SavedStatus /> : <span className="text-muted-foreground">No unsaved changes</span>)
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-2" data-settings-save-bar>
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
}
