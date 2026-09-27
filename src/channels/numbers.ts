import { useEffect, useRef, useState } from 'react'
import type { HubNumberOrder, HubNumberQuote } from '@tangle-network/hub-sdk'
import { useChannelsContext } from './context'
import { useChannelMutation, useChannelResource } from './hooks'

export const NUMBER_CHARGE_NOTICE = 'This is a one-time activation charge. Tangle does not bill recurring carrier rental for this number. Your provider’s message rates are separate.'
export const NUMBER_RETRY_NOTICE = 'Retry uses the same approved quote, not a new purchase. Do not order again while the result is unknown.'

export function holdsNumber(order: HubNumberOrder): boolean {
  return order.cancellation !== 'released' && order.cancellation !== 'abandoned'
}

export function numberStage(order: HubNumberOrder): string {
  if (order.cancellation === 'released' || order.cancellation === 'abandoned') return 'Released'
  if (order.cancellation === 'needs_review') return 'Release needs review'
  if (order.cancellation === 'requested' || order.status === 'cancelled') return 'Cancelling'
  if (order.status === 'needs_review') return 'Needs operator review'
  if (order.status === 'ready_for_setup') return 'Number acquired — channel setup next'
  if (order.errorCode === 'funding_required') return 'Add funds to continue'
  if (order.errorCode === 'sms_not_ready') return 'Waiting for SMS activation'
  return 'Provisioning'
}

/** Hub owns prices, terms, idempotency, funding, and cancellation. */
export function useNumberChannel(transport: 'sms' | 'imessage') {
  const { client } = useChannelsContext()
  const ordering = client.ordering
  const reference = ordering?.references[transport]
  const [quote, setQuote] = useState<HubNumberQuote | null>(null)
  const [receipts, setReceipts] = useState<HubNumberOrder[]>([])
  const [uncertain, setUncertain] = useState(false)
  // Set synchronously at dispatch, before React renders another click.
  const attempted = useRef(false)
  const resource = useChannelResource(async ({ signal }) => {
    if (!ordering || !reference) throw new Error('Number ordering is unavailable.')
    const readiness = await ordering.numbers.readiness()
    const orders: HubNumberOrder[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    let complete = false
    do {
      if (signal.aborted) throw new Error('Number read was superseded.')
      const page = await ordering.numbers.list({ clientReference: reference, cursor, limit: 100 })
      if (page.orders.some(order => order.clientReference !== reference || order.transport !== transport)) throw new Error('The number list belongs to another binding.')
      orders.push(...page.orders)
      if (page.nextCursor == null) {
        // Older Hub responses omit cursor metadata. An incomplete page cannot
        // establish that this agent has no order, even when the page is empty.
        complete = page.nextCursor === null
        break
      }
      if (seen.has(page.nextCursor) || seen.size >= 100) throw new Error('The number list could not be read completely.')
      seen.add(page.nextCursor)
      cursor = page.nextCursor
    } while (cursor)
    return { readiness, orders, complete }
  }, [ordering, reference, transport], !!ordering)
  const loaded = resource.status === 'ready' ? resource.value : null
  const orders = [...new Map([...(loaded?.orders ?? []), ...receipts].map(order => [order.id, order])).values()]
  const held = orders.find(holdsNumber) ?? null

  const mutation = useChannelMutation<
    | { action: 'quote' }
    | { action: 'purchase'; consent: boolean }
    | { action: 'advance'; orderId: string }
    | { action: 'cancel'; orderId: string; confirm: boolean }, void
  >(async (input, { signal }) => {
    if (!ordering || !reference) throw new Error('Number ordering is unavailable.')
    if (input.action === 'quote') {
      if (attempted.current) throw new Error('The previous purchase is unresolved. Retry its approved quote or check progress.')
      if (!loaded?.complete || !loaded.readiness.configured || !loaded.readiness.transports.includes(transport)) throw new Error('Number availability and existing orders must be confirmed first.')
      if (held) throw new Error('This agent already holds a number order for this transport.')
      const { quote: next } = await ordering.numbers.quote({ transport, clientReference: reference })
      if (next.transport !== transport || (next.clientReference !== undefined && next.clientReference !== reference)) throw new Error('The quote belongs to another binding.')
      if (!signal.aborted) setQuote(next)
      return
    }
    if (input.action === 'purchase') {
      if (!quote || !input.consent) throw new Error('Approve the quoted activation charge before ordering.')
      if (!quote.terms.trim() || !Number.isSafeInteger(quote.activationCents) || quote.activationCents < 0 || !quote.token) throw new Error('A valid price and published activation terms are required.')
      if (held) throw new Error('This agent already holds a number order for this transport.')
      if (!attempted.current && (!loaded?.complete || !loaded.readiness.configured || quote.expiresAt <= Date.now())) throw new Error('The quote or order information expired. Read the current state first.')
      attempted.current = true
      try {
        const { order } = await ordering.numbers.create({ quoteToken: quote.token, consent: true, clientReference: reference, transport })
        if (order.clientReference !== reference || order.transport !== transport) throw new Error('The purchase response belongs to another binding. Check progress before ordering again.')
        if (!signal.aborted) {
          // Preserve the acknowledged order before a follow-up read can fail.
          setReceipts(current => [order, ...current.filter(item => item.id !== order.id)])
          setQuote(null)
          setUncertain(false)
        }
      } catch (error) {
        if (!signal.aborted) setUncertain(true)
        throw error
      } finally {
        if (!signal.aborted) resource.retry()
      }
      return
    }
    if (!orders.some(order => order.id === input.orderId)) throw new Error('Read this number order before changing it.')
    if (input.action === 'cancel' && !input.confirm) throw new Error('Confirm cancelling this number.')
    const { order } = await ordering.numbers[input.action](input.orderId)
    if (order.id !== input.orderId || order.clientReference !== reference || order.transport !== transport) throw new Error('The number response belongs to another binding.')
    if (!signal.aborted) {
      setReceipts(current => [order, ...current.filter(item => item.id !== order.id)])
      resource.retry()
    }
  })
  useEffect(() => {
    setQuote(null); setReceipts([]); setUncertain(false); attempted.current = false
    mutation.reset()
  }, [client, client.scope, transport, reference, mutation.reset])
  useEffect(() => {
    if (loaded) setReceipts(current => current.filter(receipt => !loaded.orders.some(order => order.id === receipt.id)))
    if (loaded?.orders.some(holdsNumber)) {
      setQuote(null); setUncertain(false); attempted.current = false
    } else if (!uncertain && !quote && loaded?.complete && orders.length > 0 && orders.every(order => !holdsNumber(order))) {
      attempted.current = false
    }
  }, [loaded])
  return { resource, orders, held, quote, uncertain, ...mutation }
}
