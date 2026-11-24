import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { ModelPlansSection, type ModelPlansDocument } from '../../settings-react/model-plans'
import { confirmWrite } from '../../web-react/async'

function Subscriptions({ empty = false }: { empty?: boolean }) {
  const [data, setData] = useState<ModelPlansDocument>({
    providers: [{ id: 'example', label: 'Example provider' }],
    selectedPlanId: empty ? null : 'research',
    plans: empty ? [] : [
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
const meta: Meta<typeof Subscriptions> = { title: 'Settings/Model subscriptions', component: Subscriptions }
export default meta
export const WithPersonalAndWorkspacePlans: StoryObj<typeof Subscriptions> = {}
export const FirstConnection: StoryObj<typeof Subscriptions> = { args: { empty: true } }
