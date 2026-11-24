import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { ModelPlansSection, type ModelPlansDocument } from '../../settings-react/model-plans'
import { AgentProfilePicker } from '@tangle-network/sandbox-ui/chat'
import { InferenceConnectionPicker, type InferenceSelection } from '../../settings-react/inference-connection-picker'
import { confirmWrite } from '../../web-react/async'

function Subscriptions({ empty = false, needsSandbox = false, apiKeys = false, partial = false }: { empty?: boolean; needsSandbox?: boolean; apiKeys?: boolean; partial?: boolean }) {
  const [data, setData] = useState<ModelPlansDocument>({
    providers: [{ id: 'example', label: 'Example subscription' }, ...(apiKeys ? [{ id:'provider-api', label:'Provider API key', kind:'api-key' as const }] : [])],
    selectedPlanId: empty ? null : 'research',
    ...(needsSandbox && { personalSandbox: { connected: false, connectHref: '/auth/tangle/personal-sandbox' } }),
    ...(partial && { warning: 'Router could not load the models for some connections.' }),
    plans: partial ? [
      { id: 'research', provider: 'provider-api', displayName: 'Research key', kind: 'api-key', scope: 'personal', canRevoke: true,
        model: 'Research model', createdAt: '2026-03-01T09:40:00Z', lastUsedAt: null },
      { id: 'paused', provider: 'provider-api', displayName: 'Archived key', kind: 'api-key', scope: 'personal', canRevoke: true,
        unavailableReason: 'No models available', createdAt: '2026-03-01T09:40:00Z', lastUsedAt: null },
    ] : empty ? [] : [
      { id: 'research', provider: 'example', displayName: 'Research account', scope: 'personal', canRevoke: true,
        model: 'Research model', createdAt: '2026-03-01T09:40:00Z', lastUsedAt: '2026-03-05T13:22:00Z', usage: [{ label: 'Completed turns', value: '12' }] },
      { id: 'workspace', provider: 'example', displayName: 'Engineering team', scope: 'workspace', canRevoke: false,
        model: 'Engineering model', createdAt: '2026-03-03T09:40:00Z', lastUsedAt: null },
    ],
  })
  return <div className="mx-auto max-w-2xl p-4"><ModelPlansSection plans={{
    state: { status: 'ready', value: data, retry() {} }, data, selected: data.plans.find(plan => plan.id === data.selectedPlanId),
    pending: null, error: '',
    async select(id) { setData(current => ({ ...current, selectedPlanId: id })); return confirmWrite(null) },
    async connect(provider, displayName) {
      setData(current => ({ ...current, plans: [...current.plans, { id: crypto.randomUUID(), provider, displayName,
        scope: 'personal', canRevoke: true, createdAt: new Date().toISOString(), lastUsedAt: null }] }))
      return confirmWrite(null)
    },
    async revoke(id) {
      setData(current => ({ ...current, plans: current.plans.filter(plan => plan.id !== id) }))
      return confirmWrite(null)
    },
  }} /></div>
}
const meta: Meta<typeof Subscriptions> = {
  title: 'Settings/Model subscriptions', component: Subscriptions, parameters: { layout: 'fullscreen' },
}
export default meta
export const WithPersonalAndWorkspacePlans: StoryObj<typeof Subscriptions> = {}
export const ApiKeyConnections: StoryObj<typeof Subscriptions> = { args: { apiKeys: true } }
export const SavedKeysWithoutCompute: StoryObj<typeof Subscriptions> = { args: { apiKeys: true, needsSandbox: true, partial: true } }
export const FirstConnection: StoryObj<typeof Subscriptions> = { args: { empty: true } }
export const SandboxConsent: StoryObj<typeof Subscriptions> = { args: { empty: true, needsSandbox: true } }

/** Draft-only selection beside a saved profile. Selecting another credential keeps the profile. */
export const ProfileRun: StoryObj = {
  render: function ProfileRunStory() {
    const [profile, setProfile] = useState('researcher')
    const [choice, setChoice] = useState<InferenceSelection | null>(null)
    return <div className="grid w-full min-w-0 max-w-md gap-5">
      <AgentProfilePicker value={profile} onChange={setProfile}
        profiles={[{id:'researcher', name:'Researcher'}, {id:'reviewer', name:'Reviewer'}]}/>
      <InferenceConnectionPicker label="Inference for this run" defaultLabel="Profile default" value={choice} onChange={setChoice}
        connections={[{id:'personal-plan', label:'Personal coding plan', model:'model-a', models:['model-a','model-b']},
          {id:'workspace-api', label:'Workspace API key', model:'model-c'}]}/>
    </div>
  },
}
