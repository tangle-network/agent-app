import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import type { AgentProfile } from '@tangle-network/agent-interface/profile'
import { ComposerProfilePill, type ComposerProfilePillProps } from '../../web-react/composer-profile-pill'
import { AgentProfileEditor, type AgentProfileEditorSaveState } from '../../web-react/agent-profile-editor'
import { productProfile } from '../fixtures/profile-editor'

/** A product opens the existing full editor instead of implementing a second form. */
export function HostEditorPreview({ placement = 'composer' }: Pick<ComposerProfilePillProps, 'placement'>) {
  const [saved, setSaved] = useState<AgentProfile>(productProfile)
  const [draft, setDraft] = useState<AgentProfile | null>(null)
  const [editorState, setEditorState] = useState<AgentProfileEditorSaveState>({ pending: false, invalid: false })
  const [message, setMessage] = useState('')
  const openEditor = (profile: AgentProfile) => {
    setEditorState({ pending: false, invalid: false })
    setMessage('')
    setDraft(profile)
  }
  return <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="max-w-sm overflow-hidden rounded-xl border border-border p-3">
        <ComposerProfilePill
          placement={placement}
          selection={{ value: 'workspace', onChange: () => {}, disabled: draft !== null, profiles: [{ id: 'workspace', name: saved.name ?? 'Workspace agent', builtin: true }] }}
          onEdit={() => openEditor(saved)}
          onNew={() => openEditor({ name: 'New agent' })}
          side="bottom"
        />
      </div>
      {draft && <section aria-label="Edit agent profile" className="space-y-4">
        <AgentProfileEditor value={draft} onChange={setDraft} onSaveStateChange={setEditorState} />
        <div className="flex gap-2">
          <button type="button" className="rounded-lg border border-border bg-card px-4 py-2 text-sm disabled:opacity-50"
            disabled={editorState.pending || editorState.invalid}
            onClick={() => { setSaved(draft); setDraft(null); setMessage('Saved in this preview.') }}>Save profile</button>
          <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm" onClick={() => setDraft(null)}>Cancel</button>
        </div>
        {editorState.pending && <p role="status">Apply or discard unfinished edits before saving.</p>}
      </section>}
      {message && <p role="status">{message}</p>}
    </div>
  </main>
}

const meta: Meta<typeof ComposerProfilePill> = {
  title: 'App Shell/Composer profile pill',
  component: ComposerProfilePill,
  excludeStories: ['HostEditorPreview'],
  parameters: { layout: 'fullscreen' },
  render: args => <HostEditorPreview placement={args.placement} />,
}
export default meta
type Story = StoryObj<typeof ComposerProfilePill>
export const HostEditor: Story = {}
export const MenuRow: Story = { args: { placement: 'menu-row' } }
export const ModeStrip: Story = { args: { placement: 'mode-strip' } }
