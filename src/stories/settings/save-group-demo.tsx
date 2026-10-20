/**
 * One save that covers several cards, as an agent profile's does: its
 * instructions, model and knowledge are one versioned record. The group save
 * bar follows the last card it saves and, while it has something to report,
 * stays at the bottom of the screen over every card above it. The story
 * renders it and `scripts/prove-settings-pages.mjs` drives it.
 */

import { Input, SettingsList, SettingsListItem, SettingsRow, SettingsSection, Textarea } from '@tangle-network/ui/primitives'
import { Bot, Plug } from 'lucide-react'
import { useState } from 'react'
import { SettingsLayout, SettingsSaveBar, type SettingsNavSection } from '../../settings-react'

interface Profile {
  instructions: string
  model: string
  knowledge: string
}

const SAVED: Profile = {
  instructions: 'Answer guests in one or two sentences. Offer late checkout before suggesting a fee.',
  model: 'gpt-5',
  knowledge: [
    'The hot tub closes for cleaning every Tuesday from 2 to 4pm.',
    'Late checkout until 1pm costs 30 dollars.',
    'Parking is free in the lot behind the building; the gate code changes monthly.',
    'Breakfast is served from 7 to 10am in the lobby.',
    'Quiet hours run from 10pm to 7am.',
  ].join('\n'),
}

const SECTIONS: SettingsNavSection[] = [
  { id: 'profile', label: 'Agent profile', href: '?view=save-group', icon: Bot },
  { id: 'connections', label: 'Connections', href: '?view=save-group&section=connections', icon: Plug },
]

const VERSIONS = [
  { id: 'v3', at: 'Oct 16, 2026, 4:12 PM', by: 'Priya' },
  { id: 'v2', at: 'Oct 12, 2026, 9:40 AM', by: 'Priya' },
  { id: 'v1', at: 'Oct 2, 2026, 11:05 AM', by: 'Initial profile' },
]

export function SaveGroupDemo({ saveDelayMs = 300 }: { saveDelayMs?: number }) {
  const [saved, setSaved] = useState(SAVED)
  const [draft, setDraft] = useState(SAVED)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const changes = (Object.keys(draft) as Array<keyof Profile>).filter((key) => draft[key] !== saved[key]).length
  const edit = (key: keyof Profile, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }))
    if (state !== 'saving') setState('idle')
  }
  const save = () => {
    setState('saving')
    const sent = draft
    setTimeout(() => {
      setSaved(sent)
      setState('saved')
    }, saveDelayMs)
  }
  return (
    <SettingsLayout title="Agent settings" description="Front desk" sections={SECTIONS} activeId="profile">
      <SettingsSection id="instructions" title="Instructions">
        <SettingsRow label="Additional instructions" htmlFor="profile-instructions" layout="stacked" description="Added to the built-in prompt from the next message.">
          <Textarea id="profile-instructions" rows={8} value={draft.instructions} onChange={(event) => edit('instructions', event.target.value)} />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection id="model" title="Model and runtime">
        <SettingsRow label="Model" htmlFor="profile-model">
          <Input id="profile-model" value={draft.model} onChange={(event) => edit('model', event.target.value)} />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection id="knowledge" title="Business knowledge">
        <SettingsRow label="Facts and instructions" htmlFor="profile-knowledge" layout="stacked">
          <Textarea id="profile-knowledge" rows={12} value={draft.knowledge} onChange={(event) => edit('knowledge', event.target.value)} />
        </SettingsRow>
      </SettingsSection>
      <SettingsSaveBar
        placement="group"
        changes={changes}
        state={state}
        saveLabel="Save profile"
        onDiscard={() => {
          setDraft(saved)
          setState('idle')
        }}
        onSave={save}
      />
      <SettingsSection id="history" title="Version history">
        <SettingsList columns={{ main: 'minmax(0,1fr)', action: '7rem' }} aria-label="Saved profile versions">
          {VERSIONS.map((version) => (
            <SettingsListItem key={version.id} title={version.at} meta={version.by} action={{ label: 'Compare', onSelect: () => undefined }} />
          ))}
        </SettingsList>
      </SettingsSection>
    </SettingsLayout>
  )
}
