import { Fragment, useEffect, useId, useState, type FormEvent } from 'react'
import { Button, Input, Label, SettingsNote, SettingsSection } from '@tangle-network/ui/primitives'
import { ChoicePicker } from '../web-react/agent-session-controls'
import { useAsyncResource } from '../web-react/async/use-async-resource'
import { confirmSettingResponse } from './setting-outcome'
import { ConfirmAction } from './confirm-action'
import { InferenceConnectionPicker } from './inference-connection-picker'

/** Public account metadata only. The connection secret is a write-only form field. */
export interface ModelPlan {
  id: string
  provider: string
  displayName: string
  kind?: 'subscription' | 'api-key'
  scope: 'personal' | 'workspace'
  createdAt: string
  lastUsedAt: string | null
  canRevoke: boolean
  unavailableReason?: string
  model?: string
  models?: string[]
  usage?: { label: string; value: string }[]
}
export interface ModelPlansDocument {
  plans: ModelPlan[]
  warning?: string
  inheritedPlanId?: string | null
  inheritedModel?: string | null
  selectedModel?: string | null
  selectedPlanId: string | null
  personalSandbox?: { connected: boolean; connectHref?: string }
  providers: { id: string; label: string; kind?: 'subscription' | 'api-key' }[]
}
type ModelPlanMutation = 'connect' | 'select' | 'revoke'

/** A model plan selection belongs to the signed-in account. Reads after every write confirm its persisted value. */
export function useModelPlans({ endpoint = '/api/model-plans', enabled = true, refreshOnFocus = false }: {
  endpoint?: string; enabled?: boolean; refreshOnFocus?: boolean
} = {}) {
  const [pending, setPending] = useState<ModelPlanMutation | null>(null)
  const [error, setError] = useState('')
  const state = useAsyncResource<ModelPlansDocument>({
    enabled, deps: [endpoint], isEmpty: () => false,
    load: async ({ signal }) => {
      const response = await fetch(endpoint, { signal, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error('Your model subscriptions could not be loaded.')
      const data = await response.json() as ModelPlansDocument
      if (!Array.isArray(data.plans) || !Array.isArray(data.providers)) throw new Error('Your model subscriptions could not be read.')
      return data
    },
  })
  useEffect(() => {
    if (!enabled || !refreshOnFocus) return
    window.addEventListener('focus', state.retry)
    return () => window.removeEventListener('focus', state.retry)
  }, [enabled, refreshOnFocus, state.retry])
  const mutate = async (action: ModelPlanMutation, method: string, path: string, body?: Record<string, unknown>) => {
    setPending(action)
    setError('')
    try {
      // A credential must never follow a redirect or leave the application's origin.
      const result = await confirmSettingResponse(fetch(endpoint + path, {
        method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
        ...(body && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      }))
      if (result.succeeded) state.retry()
      else setError(result.message)
      return result
    } finally { setPending(null) }
  }
  const data = state.status === 'ready' ? state.value : null
  return {
    state, data, selected: data?.plans.find(plan => plan.id === data.selectedPlanId), pending, error,
    connect: (provider: string, displayName: string, key: string, model?: string) => mutate('connect', 'POST', '', { provider, displayName, key, ...(model ? {model} : {}) }),
    select: (planId: string | null, model?: string) => mutate('select', 'PUT', '/selection', { planId, ...(model ? { model } : {}) }),
    revoke: (id: string) => mutate('revoke', 'DELETE', '/' + encodeURIComponent(id)),
  }
}

type Plans = ReturnType<typeof useModelPlans>
const scopeLabel = (plan: ModelPlan) => plan.scope === 'workspace' ? 'Workspace' : 'Personal'
const providerLabel = (plan: ModelPlan, data: ModelPlansDocument) => data.providers.find(item => item.id === plan.provider)?.label ?? plan.provider

export function ModelPlanPicker({ plans, manageHref, computeNotice }: { plans: Plans; manageHref?: string; computeNotice?: string }) {
  const mixed = plans.data?.providers.some(provider => provider.kind === 'api-key')
  const labelText = manageHref ? (mixed ? 'Inference connection' : 'Model subscription') : 'Use for conversations'
  const { state, data } = plans
  if (!data) return state.status === 'error'
    ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">{state.message}<Button type="button" variant="ghost" size="sm" onClick={state.retry}>Try again</Button></div>
    : <p role="status" className="text-sm text-muted-foreground">Loading subscriptions…</p>
  const inherited = data.plans.find(plan => plan.id === data.inheritedPlanId)
  const defaultLabel = data.inheritedPlanId === undefined ? 'App default'
    : inherited ? 'Account default · ' + inherited.displayName + (data.inheritedModel ? ' · ' + data.inheritedModel : '') : 'Account default'
  return <div className="grid min-w-0 gap-2">
    <InferenceConnectionPicker label={labelText} defaultLabel={defaultLabel} disabled={!!plans.pending}
      value={data.selectedPlanId ? { connectionId: data.selectedPlanId, model: data.selectedModel ?? undefined } : null}
      manage={manageHref && <a className="text-sm underline" href={manageHref} target="_blank" rel="noreferrer">{mixed ? 'Manage connections' : 'Manage subscriptions'}</a>}
      connections={data.plans.map(plan => ({ id: plan.id, label: plan.displayName, model: plan.model, models: plan.models, unavailableReason: plan.unavailableReason,
        description: [scopeLabel(plan), providerLabel(plan, data), plan.model].filter(Boolean).join(' · ') }))}
      onChange={choice => void plans.select(choice?.connectionId ?? null, choice?.model)}/>
    {data.warning && <SettingsNote tone="warning" role="status">{data.warning}</SettingsNote>}
    {computeNotice && <p className="text-sm text-muted-foreground">{computeNotice}</p>}
    {plans.error && <p role="alert" className="text-sm text-destructive">{plans.error}</p>}
  </div>
}

function ConnectPlan({ plans, data }: { plans: Plans; data: ModelPlansDocument }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState(data.providers[0]?.id ?? '')
  const mixed = data.providers.some(item => item.kind === 'api-key')
  const apiKey = data.providers.find(item => item.id === provider)?.kind === 'api-key'
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    const keyInput = form.elements.namedItem('key') as HTMLInputElement
    keyInput.value = ''
    const result = await plans.connect(provider, String(fields.get('name')).trim(), String(fields.get('key')).trim(), apiKey ? String(fields.get('model')).trim() : undefined)
    if (result.succeeded) setOpen(false)
  }
  if (data.personalSandbox?.connected === false) {
    const url = data.personalSandbox.connectHref && new URL(data.personalSandbox.connectHref, window.location.origin)
    return <div className="grid justify-items-start gap-2">
      <p className="text-sm text-muted-foreground">Connect your Sandbox to add a personal model subscription.</p>
      {url && url.origin === window.location.origin &&
        <Button asChild variant="outline"><a href={url.pathname + url.search}>Connect your Sandbox</a></Button>}
    </div>
  }
  if (!data.providers.length) return null
  if (!open) return <Button type="button" variant="outline" onClick={() => setOpen(true)}>{mixed ? 'Add connection' : 'Connect a subscription'}</Button>
  return <form aria-label={mixed ? 'Add inference connection' : 'Connect a personal subscription'} className="grid max-w-md gap-3" onSubmit={submit}>
    <div className="grid gap-1.5"><Label htmlFor={id + '-provider'}>Provider</Label>
      <ChoicePicker id={id + '-provider'} variant="field" fullWidth aria-label="Subscription provider" value={provider}
        onChange={setProvider} options={data.providers.map(item => ({ value: item.id, label: item.label }))} /></div>
    <div className="grid gap-1.5"><Label htmlFor={id + '-name'}>{mixed ? 'Connection name' : 'Subscription name'}</Label>
      <Input id={id + '-name'} name="name" autoComplete="off" required /></div>
     {apiKey && <div className="grid gap-1.5"><Label htmlFor={id + '-model'}>Model ID</Label>
      <Input id={id + '-model'} name="model" required autoComplete="off" spellCheck={false}/></div>}
    <div className="grid gap-1.5"><Label htmlFor={id + '-key'}>{apiKey ? 'Provider API key' : 'Subscription API key'}</Label>
      <Input id={id + '-key'} name="key" type="password" autoComplete="off" spellCheck={false} required /></div>
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={!!plans.pending}>{plans.pending === 'connect' ? 'Connecting…' : 'Connect'}</Button>
      <Button type="button" variant="ghost" disabled={!!plans.pending} onClick={() => setOpen(false)}>Cancel</Button>
    </div>
  </form>
}

function timestamp(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
}

export function ModelPlansSection({ plans, computeNotice }: { plans: Plans; computeNotice?: string }) {
  const data = plans.data
  const mixed = data?.providers.some(provider => provider.kind === 'api-key')
  return <SettingsSection id="subscriptions" title={mixed ? 'Inference connections' : 'Model subscriptions'}>
    <div className="grid min-w-0 gap-5 p-4">
      <ModelPlanPicker plans={plans} computeNotice={computeNotice} />
      {data && <>
        {data.plans.length > 0 && <ul aria-label={mixed ? 'Saved connections' : 'Saved subscriptions'} className="grid min-w-0 divide-y">
          {data.plans.map(plan => <li key={plan.id} className="min-w-0 py-3">
            <details>
              <summary className="cursor-pointer break-words font-medium">
                {plan.displayName} <span className="text-sm font-normal text-muted-foreground">· {scopeLabel(plan)} · {providerLabel(plan, data)}</span>
              </summary>
              <dl className="my-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                {plan.unavailableReason && <><dt className="text-muted-foreground">Status</dt><dd>{plan.unavailableReason}</dd></>}
                {plan.model && <><dt className="text-muted-foreground">Model</dt><dd className="break-all">{plan.model}</dd></>}
                <dt className="text-muted-foreground">Connected</dt><dd>{timestamp(plan.createdAt)}</dd>
                <dt className="text-muted-foreground">Last used</dt><dd>{plan.lastUsedAt ? timestamp(plan.lastUsedAt) : 'No use recorded'}</dd>
                {plan.usage?.map(metric => <Fragment key={metric.label}>
                  <dt className="text-muted-foreground">{metric.label}</dt><dd>{metric.value}</dd>
                </Fragment>)}
              </dl>
              {plan.canRevoke && <ConfirmAction title={'Disconnect ' + plan.displayName + '?'} consequence={plan.kind === 'api-key' ? 'Future turns will lose access to this API key.' : 'Future turns will lose access to this subscription.'}
                confirmLabel="Disconnect" trigger={<Button type="button" variant="outline" size="sm">{plan.kind === 'api-key' ? 'Disconnect API key' : 'Disconnect subscription'}</Button>}
                onConfirm={() => plans.revoke(plan.id)} />}
            </details>
          </li>)}
        </ul>}
        {!data.plans.length && !data.warning && <SettingsNote tone="muted">{mixed ? 'You have no saved connections.' : 'You have no saved subscriptions.'}</SettingsNote>}
        <div><ConnectPlan plans={plans} data={data} /></div>
      </>}
    </div>
  </SettingsSection>
}
