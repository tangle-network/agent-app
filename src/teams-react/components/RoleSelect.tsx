/**
 * The role picker both team panels and the settings sections share: the ui
 * `Select`, with each role named by what it lets a person do, so choosing one
 * never needs a help page. The trigger fills its container; give the
 * container the width.
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tangle-network/ui/primitives'
import { ASSIGNABLE_WORKSPACE_ROLES, type WorkspaceRole } from '../../teams/roles'

/** Each workspace role in the words a person decides by. */
export const ROLE_CAPABILITY: Record<WorkspaceRole, string> = {
  viewer: 'Can view',
  editor: 'Can edit',
  admin: 'Can manage settings and people',
  owner: 'Owner',
}

export interface RoleSelectProps {
  value: WorkspaceRole
  onChange(role: WorkspaceRole): void
  /** Accessible name (no visible label — the panels label the row). */
  ariaLabel: string
  id?: string
  disabled?: boolean
}

export function RoleSelect({ value, onChange, ariaLabel, id, disabled }: RoleSelectProps) {
  return (
    <Select value={value} onValueChange={(role) => onChange(role as WorkspaceRole)} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ASSIGNABLE_WORKSPACE_ROLES.map((role) => (
          <SelectItem key={role} value={role}>{ROLE_CAPABILITY[role]}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
