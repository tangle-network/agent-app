import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { ActionDialog, ActionDialogButton } from '../../web-react/action-dialog'
import { Section, StatusPill } from '../../web-react/agent-profile-form-kit'
import { AsyncView, type AsyncResourceState } from '../../web-react/async'
import { RecordGrid, type RecordGridRow } from '../../web-react/record-grid'
import { ApiAccessPanel } from '../../web-react/api-access-panel'
import { ChatMessages } from '../../web-react'
import { doneShellToolCall } from '../chat/fixtures'
import { useInteractionEvidence } from './interaction-evidence'

function SharedPrimitives() {
  const evidenceRoot = useInteractionEvidence()
  const [dialog, setDialog] = useState(false)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('Research assistant')
  const [saved, setSaved] = useState(name)
  const [state, setState] = useState<AsyncResourceState<string>>({ status: 'empty', value: '', retry: () => {} })
  const [rows, setRows] = useState<RecordGridRow[]>([{ id: 'draft', values: { name: 'Review sources', count: 3 } }])
  return <main ref={evidenceRoot} data-design-evidence-root="shared-primitives" className="mx-auto max-w-4xl space-y-6 p-4 text-foreground sm:p-8">
    <output data-design-calibration aria-live="off" />
    <h1 className="text-2xl font-semibold">Shared application controls</h1>
    <Section title="Profile" description="Edit and check your assistant." summary={<StatusPill tone="success">Ready</StatusPill>}>
      <p data-design-anchor="saved-profile">Saved profile: {saved}</p>
      <ActionDialogButton onClick={() => setDialog(true)}>Rename profile</ActionDialogButton>
    </Section>
    <Section title="Advanced settings" collapsible><label>Advanced note<input defaultValue="Keep this draft" className="w-full border border-input bg-background p-2" /></label></Section>
    <AsyncView state={state} empty={{ title: 'No reports yet', description: 'Create your first report.', action: { label: 'Create report', onClick: () => setState({ status: 'ready', value: 'Report created', retry: () => {} }) } }}>
      {value => <p role="status">{value}</p>}
    </AsyncView>
    <RecordGrid caption="Review tasks" columns={[{ id: 'name', kind: 'text', header: 'Task' }, { id: 'count', kind: 'number', header: 'Sources' }]} state={{ status: 'ready', value: rows, retry: () => {} }} empty={{ title: 'No tasks yet' }}
      onUpdate={async change => { setRows(current => current.map(row => row.id === change.row.id ? { ...row, values: change.values } : row)); return { succeeded: true } }} />
    <ChatMessages messages={[{ id: 'shell', role: 'assistant', content: '', toolCalls: [doneShellToolCall] }]} models={[]} />
    <ApiAccessPanel keys={[]} access={[{ scope: 'records:read', label: 'Read records', description: 'Read records and run status.' }]} defaultScopes={['records:read']} baseUrl="https://example.test" onCreate={async () => ({ id: 'fixture', key: 'synthetic-story-key-not-a-credential' })} onRevoke={async () => {}} onChanged={() => {}} />
    {dialog && <ActionDialog title="Rename profile" busy={busy} error={null} onClose={() => setDialog(false)} footer={<><ActionDialogButton variant="ghost" disabled={busy} onClick={() => setDialog(false)}>Cancel</ActionDialogButton><ActionDialogButton disabled={busy} onClick={() => { setSaved(name); setDialog(false) }}>Save</ActionDialogButton></>}>
      <label>Profile name<input autoFocus value={name} onChange={event => setName(event.target.value)} className="w-full border border-input bg-background p-2" /></label>
      <label><input type="checkbox" checked={busy} onChange={event => setBusy(event.target.checked)} /> Write in flight</label>
    </ActionDialog>}
  </main>
}
const meta: Meta<typeof SharedPrimitives> = { title: 'App Shell/Shared primitives', component: SharedPrimitives, parameters: { layout: 'fullscreen' } }
export default meta
export const Interactive: StoryObj<typeof SharedPrimitives> = {}
