/**
 * The role picker both team panels and the settings sections share: the ui
 * `Select`, with each role named by what it lets a person do and, in the open
 * list, one line on what it adds, so choosing one never needs a help page.
 * The trigger shows the name alone and fills its container; give the
 * container the width.
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tangle-network/ui/primitives'
import { ASSIGNABLE_WORKSPACE_ROLES, type AssignableWorkspaceRole, type WorkspaceRole } from '../../teams/roles'

/** Each workspace role in the words a person decides by. */
export const ROLE_CAPABILITY: Record<WorkspaceRole, string> = {
  viewer: 'Can view',
  editor: 'Can edit',
  admin: 'Can manage settings and people',
  owner: 'Owner',
}

// What each assignable role adds, under its name in the open list; chatting
// with the agent is what a viewer cannot do. Each line fits a phone-width
// trigger, so the open list is never wider than the screen.
const ROLE_DESCRIPTION: Record<AssignableWorkspaceRole, string> = {
  viewer: 'Reads everything; can’t chat or edit',
  editor: 'Also chats with the agent and edits',
  admin: 'Also invites people and sets roles',
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
        <SelectValue>{ROLE_CAPABILITY[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ASSIGNABLE_WORKSPACE_ROLES.map((role) => (
          <SelectItem key={role} value={role} textValue={ROLE_CAPABILITY[role]}>
            <span className="block">{ROLE_CAPABILITY[role]}</span>
            <span className="block font-normal text-muted-foreground" data-role-description>{ROLE_DESCRIPTION[role]}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
