import { useId, type ReactNode } from 'react'
import { Label } from '@tangle-network/ui/primitives'
import { ChoicePicker } from '../web-react/agent-session-controls'

export interface InferenceConnectionOption {
  id: string
  label: string
  description?: string
  model?: string
  models?: readonly string[]
}

/** Public choice for a draft, conversation or account default. Credential resolution
 * happens on the server when the agent's execution materializes. */
export interface InferenceSelection {
  connectionId: string
  model?: string
}

/** Controlled independently from the profile picker. Hosts choose what to persist. */
export function InferenceConnectionPicker({ value, connections, onChange, label, defaultLabel, manage, disabled }: {
  value: InferenceSelection | null
  connections: readonly InferenceConnectionOption[]
  onChange: (value: InferenceSelection | null) => void
  label: string
  defaultLabel: string
  manage?: ReactNode
  disabled?: boolean
}) {
  const id = useId()
  const selected = connections.find(connection => connection.id === value?.connectionId)
  const models = selected?.models ?? []
  return <div className="grid min-w-0 gap-2">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <Label htmlFor={id}>{label}</Label>{manage}
    </div>
    <ChoicePicker id={id} aria-label={label} variant="field" fullWidth disabled={disabled}
      value={value?.connectionId ?? ''} placeholder="Selected connection unavailable"
      options={[{value:'',label:defaultLabel}, ...connections.map(c => ({ value:c.id, label:c.label, description:c.description }))]}
      onChange={id => {
        const choice = connections.find(c => c.id === id)
        onChange(choice ? { connectionId: choice.id, ...(choice.model ? { model: choice.model } : {}) } : null)
      }}/>
    {selected && models.length > 1 && <div className="grid min-w-0 gap-2">
      <Label htmlFor={id + '-model'}>Model</Label>
      <ChoicePicker id={id + '-model'} aria-label="Connection model" variant="field" fullWidth disabled={disabled}
        value={value?.model ?? selected.model ?? ''} placeholder="Choose model" options={models.map(model => ({value:model,label:model}))}
        onChange={model => onChange({ connectionId: selected.id, model })}/>
    </div>}
  </div>
}
