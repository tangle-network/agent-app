/**
 * The danger card at the bottom of a settings page. At rest it is an outline
 * destructive button, never the loudest control on the page; the filled
 * destructive button is inside the dialog, which counts what goes, asks for
 * the name and navigates only after a confirmed delete.
 */

import { Button, SettingsRow, SettingsSection } from '@tangle-network/ui/primitives'
import type { ReactNode } from 'react'
import type { MutationOutcome } from '../web-react/async'
import { ConfirmAction } from './confirm-action'

/** One thing the delete removes or stops, such as `{ count: 12, label: 'chats' }`. */
export interface DeleteCount {
  count: number
  label: string
}

export interface DeleteWorkspaceSectionProps {
  /** The card's anchor. */
  id?: string
  /** The workspace's name; the person types it to confirm. */
  name: string
  /** What the delete removes or stops, counted. Zero counts are left out. */
  counts?: DeleteCount[]
  /** The product's word for a workspace, as in "Delete project". */
  noun?: string
  /** Why the viewer cannot delete, naming who can. */
  disabledReason?: ReactNode
  /** A sentence pointing to an export, shown in the dialog. */
  notice?: ReactNode
  onDelete: () => Promise<MutationOutcome<unknown>>
  /** Runs only after a confirmed delete: navigate away here. */
  onDeleted: () => void
}

function listCounts(counts: DeleteCount[]): string | null {
  const shown = counts.filter((entry) => entry.count > 0).map((entry) => `${entry.count.toLocaleString()} ${entry.label}`)
  if (shown.length === 0) return null
  return shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

export function DeleteWorkspaceSection({
  id = 'delete',
  name,
  counts = [],
  noun = 'project',
  disabledReason,
  notice,
  onDelete,
  onDeleted,
}: DeleteWorkspaceSectionProps) {
  const title = `Delete ${noun}`
  const removed = listCounts(counts)
  const trigger = (
    <Button type="button" variant="destructive-outline" disabled={disabledReason != null}>
      {title}…
    </Button>
  )
  return (
    <SettingsSection id={id} title={title} tone="danger">
      <SettingsRow
        label={`Delete this ${noun} for everyone`}
        description="This can’t be undone."
        disabledReason={disabledReason}
        layout="compact"
      >
        {disabledReason != null ? trigger : (
          <ConfirmAction
            trigger={trigger}
            title={`Delete ${name}?`}
            consequence={removed
              ? `This permanently deletes ${name} for everyone: ${removed}. It can’t be undone.`
              : `This permanently deletes ${name} for everyone. It can’t be undone.`}
            notice={notice}
            confirmLabel={title}
            tone="danger"
            requireText={name}
            onConfirm={onDelete}
            onConfirmed={onDeleted}
          />
        )}
      </SettingsRow>
    </SettingsSection>
  )
}
