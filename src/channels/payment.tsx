import { useEffect, useState } from 'react'
import { useChannelsContext } from './context'
import { useChannelMutation, useChannelResource } from './hooks'
import { ChannelState, ChannelFailure, buttonClass, primaryButtonClass, panelClass } from './ui'

/** Only same-origin relative paths or credential-free HTTPS checkout URLs. */
export function safeCheckoutUrl(value: string): string {
  if (/^\/(?!\/)/.test(value) && !/[\\\s]/.test(value)) return value
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Checkout returned an unsafe URL.')
  return url.href
}

export function useLinePayment(lineId: string) {
  const { client } = useChannelsContext()
  const resource = useChannelResource(context => {
    if (!client.payment) throw new Error('Payments are unavailable for this line.')
    return client.payment.read(lineId, context)
  }, [lineId], !!lineId && !!client.payment)
  const mutation = useChannelMutation<{ consent: boolean }, string>(async ({ consent }) => {
    if (!client.payment || resource.status !== 'ready') throw new Error('Read the current allowance before checkout.')
    const { plan, allowance, terms } = resource.value
    if (!consent || !terms.trim()) throw new Error('Accept the published terms before checkout.')
    if (!plan.configured || !plan.paid || !Number.isFinite(plan.paid.priceUsdMonthly) || plan.paid.priceUsdMonthly <= 0 || allowance.decision !== 'paywall' || !allowance.paywall || allowance.tier !== 'free') throw new Error('Checkout is not available for this allowance.')
    return safeCheckoutUrl((await client.payment.checkout(lineId)).url)
  })
  useEffect(() => mutation.reset(), [lineId, mutation.reset])
  return { resource, ...mutation, available: !!client.payment }
}

/** End-user allowance/checkout page, not number acquisition or creator payouts. */
export function LinePayPage({ lineId, className = '' }: { lineId: string; className?: string }) {
  const payment = useLinePayment(lineId)
  const [consentedTerms, setConsentedTerms] = useState<string | null>(null)
  const currentTerms = payment.resource.status === 'ready'
    ? JSON.stringify([lineId, payment.resource.value.terms, payment.resource.value.plan.paid])
    : null
  const consent = currentTerms !== null && consentedTerms === currentTerms
  return <section className={`${panelClass} ${className}`} aria-label="Line subscription">
    <h2 className="text-lg font-semibold">Your line plan</h2>
    {!payment.available ? <p>Payments are unavailable for this line.</p> : <ChannelState resource={payment.resource} empty="No plan is available.">{value => <>
      <h3 className="font-medium">{value.label}</h3>
      <p>{value.allowance.turns.used} of {value.allowance.turns.limit} turns used today.</p>
      {value.allowance.tier === 'paid' ? <p role="status">Your paid allowance is active.{value.allowance.decision === 'allowance_reached' ? ' Its current limit is exhausted; another checkout cannot lift it.' : ''}</p> : value.allowance.decision === 'paywall' && value.plan.paid ? <>
        <p>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value.plan.paid.priceUsdMonthly)} per month · {value.plan.paid.turnsPerDay} turns per day.</p>
        <p className="whitespace-pre-wrap">{value.terms || 'Plan terms are unavailable. Checkout is disabled.'}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={consent} onChange={event => setConsentedTerms(event.target.checked ? currentTerms : null)} />I accept these subscription terms.</label>
        <button type="button" className={primaryButtonClass} disabled={!consent || !value.terms.trim() || payment.state.status === 'pending'} onClick={() => void payment.run({ consent })}>Continue to checkout</button>
        <p className="text-sm text-muted-foreground">Payment is confirmed by the server after settlement, not by returning to this page.</p>
      </> : <p>{value.allowance.decision === 'allowance_reached' ? 'Your allowance is exhausted. Paying does not lift this limit today.' : 'Your current allowance is available.'} Resets at {value.allowance.resetsAt}.</p>}
      <button type="button" className={buttonClass} onClick={payment.resource.retry}>Check payment status</button>
    </>}</ChannelState>}
    {payment.state.status === 'succeeded' && consent && <a className="underline" href={payment.state.value} rel="noopener noreferrer">Open secure checkout</a>}
    <ChannelFailure state={payment.state} />
  </section>
}
