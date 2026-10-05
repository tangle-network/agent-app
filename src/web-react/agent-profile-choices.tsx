import { useId } from 'react'
import type { AgentProfilePickerProps } from '@tangle-network/sandbox-ui/chat'

export interface AgentProfileChoicesProps extends Pick<AgentProfilePickerProps, 'value' | 'profiles' | 'onChange' | 'disabled' | 'locked' | 'lockReason' | 'onNewChat'> {
  label?: string
}

/** Selection-only profile rows for an existing settings surface, with no nested portal or authoring policy. */
export function AgentProfileChoices({ value, profiles, onChange, disabled, locked, lockReason, onNewChat, label = 'Agent profile' }: AgentProfileChoicesProps) {
  const name = useId()
  const selected = profiles.find((profile) => profile.id === value)
  if (locked) {
    return <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
      <p className="font-medium text-foreground">{selected?.name ?? value}</p>
      <p className="text-muted-foreground">{lockReason ?? 'This conversation stays on its current profile.'}</p>
      {onNewChat && !disabled && <button type="button" onClick={onNewChat} className="text-sm font-medium text-primary underline underline-offset-4">New chat to switch profile</button>}
    </div>
  }
  return <fieldset disabled={disabled} className="min-w-0 space-y-1">
    <legend className="sr-only">{label}</legend>
    <div className="max-h-48 space-y-1 overflow-y-auto">
      {profiles.map((profile) => <label key={profile.id} className="flex min-h-10 cursor-pointer items-start gap-2 rounded-lg border border-transparent p-2 text-sm hover:bg-muted has-[:checked]:border-border has-[:checked]:bg-muted has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
        <input type="radio" name={name} value={profile.id} checked={profile.id === value} disabled={disabled} onChange={() => { if (!disabled) onChange(profile.id) }} className="mt-1 shrink-0 accent-primary" />
        <span className="min-w-0"><span className="block font-medium text-foreground">{profile.name}</span>{profile.description && <span className="mt-0.5 block text-xs text-muted-foreground">{profile.description}</span>}</span>
      </label>)}
      {profiles.length === 0 && <p role="status" className="p-2 text-sm text-muted-foreground">No profiles available.</p>}
    </div>
  </fieldset>
}
