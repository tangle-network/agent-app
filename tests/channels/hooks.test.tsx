// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelsProvider, useChannel, useChannelConversation, useChannelConversations, useChannels, useConnectChannel, useLinePayment, useNumberChannel } from '../../src/channels'
import { channelLine, channelMessage, channelTest, createChannelsFixture, numberOrder } from '../../src/stories/fixtures/channels'
import type { ChannelsClient, Line } from '../../src/channels'

function setup() {
  const fake = createChannelsFixture()
  const wrapper = ({ children }: PropsWithChildren) => <ChannelsProvider client={fake.client} pollInterval={false}>{children}</ChannelsProvider>
  return { ...fake, wrapper }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(() => { vi.useRealTimers() })

describe('channel hooks through the injected Sandbox lines client', () => {
  it('connects iMessage with the actual fromConnection signature', async () => {
    const fake = setup()
    const create = vi.spyOn(fake.client.lines, 'fromConnection')
    const activate = vi.spyOn(fake.client.setup, 'activate')
    const { result } = renderHook(() => useConnectChannel(), { wrapper: fake.wrapper })
    await act(async () => { await result.current.run({ kind: 'connection', input: { transport: 'imessage', connectionId: 'conn_demo' } }) })
    expect(create).toHaveBeenCalledWith({ transport: 'imessage', connectionId: 'conn_demo' })
    expect(result.current.state.status).toBe('succeeded')
    expect(activate).not.toHaveBeenCalled()
  })

  it('pins an owned WhatsApp number when connecting', async () => {
    const fake = setup()
    const create = vi.spyOn(fake.client.lines, 'fromConnection')
    const { result } = renderHook(() => useConnectChannel(), { wrapper: fake.wrapper })
    await act(async () => { await result.current.run({ kind: 'connection', input: { transport: 'whatsapp', connectionId: 'conn_demo', phoneNumberId: 'number_demo' } }) })
    expect(create).toHaveBeenCalledWith({ transport: 'whatsapp', connectionId: 'conn_demo', phoneNumberId: 'number_demo' })
    expect(fake.state.line.transport).toBe('whatsapp')
  })

  it('normalizes email through the host Hub seam, not a fictional SDK method', async () => {
    const fake = setup()
    const create = vi.spyOn(fake.client.setup, 'fromEmail')
    const { result } = renderHook(() => useConnectChannel(), { wrapper: fake.wrapper })
    await act(async () => { await result.current.run({ kind: 'email', connectionId: 'conn_demo', address: ' HELLO@EXAMPLE.COM ' }) })
    expect(create).toHaveBeenCalledWith({ connectionId: 'conn_demo', address: 'hello@example.com' })
    expect(fake.state.line.address).toBe('hello@example.com')
  })

  it('binds purchased SMS through the host order seam', async () => {
    const fake = setup()
    const create = vi.spyOn(fake.client.setup, 'fromOrder')
    const { result } = renderHook(() => useConnectChannel(), { wrapper: fake.wrapper })
    await act(async () => { await result.current.run({ kind: 'order', orderId: numberOrder().id }) })
    expect(create).toHaveBeenCalledWith(numberOrder().id)
    expect(fake.state.line.transport).toBe('sms')
  })

  it('reports a failed connection instead of claiming success', async () => {
    const fake = setup()
    vi.spyOn(fake.client.lines, 'fromConnection').mockRejectedValue(new Error('Connection permission denied'))
    const { result } = renderHook(() => useConnectChannel(), { wrapper: fake.wrapper })
    await act(async () => { const outcome = await result.current.run({ kind: 'connection', input: { transport: 'imessage', connectionId: 'conn_demo' } }); expect(outcome.succeeded).toBe(false) })
    expect(result.current.state).toMatchObject({ status: 'failed', message: 'Connection permission denied' })
  })

  it('does not submit duplicate synchronous connects', async () => {
    const fake = setup()
    const pending = deferred<Line>()
    const create = vi.spyOn(fake.client.lines, 'fromConnection').mockReturnValue(pending.promise)
    const { result } = renderHook(() => useConnectChannel(), { wrapper: fake.wrapper })
    await act(async () => {
      const input = { kind: 'connection' as const, input: { transport: 'imessage' as const, connectionId: 'conn_demo' } }
      const first = result.current.run(input)
      expect((await result.current.run(input)).succeeded).toBe(false)
      pending.resolve(channelLine())
      await first
    })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('refuses activation until both directions are verified', async () => {
    const fake = setup()
    fake.state.test = channelTest('received')
    const activate = vi.spyOn(fake.client.setup, 'activate')
    const { result } = renderHook(() => useChannel('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { expect((await result.current.run({ action: 'activate' })).succeeded).toBe(false) })
    expect(activate).not.toHaveBeenCalled()
  })

  it('advances start, inbound, reply, confirmation, then activation using server evidence', async () => {
    const fake = setup()
    const { result } = renderHook(() => useChannel('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { await result.current.run({ action: 'start' }) })
    await waitFor(() => expect(result.current.resource).toMatchObject({ status: 'ready', value: { verification: { status: 'waiting' } } }))
    fake.state.test = channelTest('received')
    act(() => result.current.resource.retry())
    await waitFor(() => expect(result.current.resource).toMatchObject({ value: { verification: { status: 'received' } } }))
    await act(async () => { await result.current.run({ action: 'send' }) })
    await waitFor(() => expect(result.current.resource).toMatchObject({ value: { verification: { status: 'sent' } } }))
    fake.state.test = channelTest('verified')
    act(() => result.current.resource.retry())
    await waitFor(() => expect(result.current.resource).toMatchObject({ value: { verification: { status: 'verified' } } }))
    await act(async () => { expect((await result.current.run({ action: 'activate' })).succeeded).toBe(true) })
    await waitFor(() => expect(result.current.resource).toMatchObject({ value: { line: { attachment: { status: 'active' } } } }))
  })

  it('refuses replies before an inbound test and activation of expired evidence', async () => {
    const fake = setup()
    fake.state.test = channelTest('waiting')
    const send = vi.spyOn(fake.client.setup, 'send')
    const { result } = renderHook(() => useChannel('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { expect((await result.current.run({ action: 'send' })).succeeded).toBe(false) })
    expect(send).not.toHaveBeenCalled()
    fake.state.test = { ...channelTest('verified'), expired: true }
    act(() => result.current.resource.retry())
    await waitFor(() => expect(result.current.resource).toMatchObject({ value: { verification: { expired: true } } }))
    await act(async () => { expect((await result.current.run({ action: 'activate' })).succeeded).toBe(false) })
  })

  it('requires explicit confirmation to reset a test', async () => {
    const fake = setup()
    fake.state.test = channelTest()
    const reset = vi.spyOn(fake.client.setup, 'reset')
    const { result } = renderHook(() => useChannel('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { expect((await result.current.run({ action: 'reset' })).succeeded).toBe(false) })
    expect(reset).not.toHaveBeenCalled()
    await act(async () => { expect((await result.current.run({ action: 'reset', confirm: true })).succeeded).toBe(true) })
    expect(reset).toHaveBeenCalledWith('ln_demo', 'test_demo')
  })

  it('does not treat an unconfirmed activation response as success', async () => {
    const fake = setup()
    fake.state.test = channelTest('verified')
    vi.spyOn(fake.client.setup, 'activate').mockResolvedValue(channelLine())
    const { result } = renderHook(() => useChannel('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { await result.current.run({ action: 'activate' }) })
    expect(result.current.state).toMatchObject({ status: 'failed', message: 'Messaging activation was not confirmed.' })
  })

  it('distinguishes a failed line list from an empty one and retries', async () => {
    const fake = setup()
    vi.spyOn(fake.client.lines, 'list').mockRejectedValueOnce(new Error('Service unavailable')).mockResolvedValue([])
    const { result } = renderHook(() => useChannels(), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current).toMatchObject({ status: 'error', message: 'Service unavailable' }))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current).toMatchObject({ status: 'empty', value: [] }))
  })

  it('rejects verification from a different line', async () => {
    const fake = setup()
    fake.state.test = { ...channelTest(), lineId: 'ln_other' }
    const { result } = renderHook(() => useChannel('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource).toMatchObject({ status: 'error', message: 'Channel binding changed. Reload channel setup.' }))
  })

  it('discards a late read when the agent client changes', async () => {
    const first = setup()
    const pending = deferred<Line[]>()
    vi.spyOn(first.client.lines, 'list').mockReturnValue(pending.promise)
    const second = setup()
    second.client.scope = 'agent:other'
    second.state.line = channelLine({ id: 'ln_other' })
    let client: ChannelsClient = first.client
    const wrapper = ({ children }: PropsWithChildren) => <ChannelsProvider client={client} pollInterval={false}>{children}</ChannelsProvider>
    const { result, rerender } = renderHook(() => useChannels(), { wrapper })
    client = second.client
    rerender()
    await waitFor(() => expect(result.current).toMatchObject({ value: [{ id: 'ln_other' }] }))
    await act(async () => { pending.resolve([channelLine()]) })
    expect(result.current).toMatchObject({ value: [{ id: 'ln_other' }] })
  })

  it('reads SDK threads without merging member conversations', async () => {
    const fake = setup()
    const threads = vi.spyOn(fake.client.lines, 'threads')
    const { result } = renderHook(() => useChannelConversations('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', value: [{ id: 'thread_demo' }] }))
    expect(threads).toHaveBeenCalledWith('ln_demo')
  })

  it('renders new inbound messages after refresh, in chronological deduplicated order', async () => {
    const fake = setup()
    fake.state.messages = [channelMessage('later', { createdAt: '2026-09-24T12:02:00Z', direction: 'out' }), channelMessage('first'), channelMessage('first')]
    const { result } = renderHook(() => useChannelConversation('ln_demo', 'thread_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.status === 'ready' && result.current.value.map(item => item.id)).toEqual(['first', 'later'])
    fake.state.messages.unshift(channelMessage('new-inbound', { createdAt: '2026-09-24T12:03:00Z' }))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status === 'ready' && result.current.value.map(item => item.id)).toEqual(['first', 'later', 'new-inbound']))
  })

  it('fails closed for cross-thread messages', async () => {
    const fake = setup()
    fake.state.messages = [channelMessage('wrong', { threadId: 'thread_other' })]
    const { result } = renderHook(() => useChannelConversation('ln_demo', 'thread_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.status).toBe('error'))
  })

  it('polls inbound messages and stops polling on unmount', async () => {
    vi.useFakeTimers()
    const fake = setup()
    const messages = vi.fn(async () => fake.state.messages)
    fake.client.lines.threads = () => ({ list: async () => [fake.thread], messages })
    const wrapper = ({ children }: PropsWithChildren) => <ChannelsProvider client={fake.client} pollInterval={3000}>{children}</ChannelsProvider>
    const { result, unmount } = renderHook(() => useChannelConversation('ln_demo', 'thread_demo'), { wrapper })
    await act(async () => {})
    expect(result.current.status).toBe('empty')
    fake.state.messages = [channelMessage()]
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(result.current).toMatchObject({ status: 'ready', value: [{ id: 'message_in' }] })
    unmount()
    const count = messages.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(messages).toHaveBeenCalledTimes(count)
  })

  it('does not overlap slow polling reads', async () => {
    vi.useFakeTimers()
    const fake = setup()
    const pending = deferred<Line[]>()
    const list = vi.spyOn(fake.client.lines, 'list').mockReturnValue(pending.promise)
    const wrapper = ({ children }: PropsWithChildren) => <ChannelsProvider client={fake.client} pollInterval={100}>{children}</ChannelsProvider>
    const { result } = renderHook(() => useChannels(), { wrapper })
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(list).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('loading')
    await act(async () => { pending.resolve([]) })
    expect(result.current.status).toBe('empty')
  })
})

describe('managed number hooks use Hub quote and order contracts', () => {
  it('requires consent and keeps the signed quote unchanged on purchase', async () => {
    const fake = setup()
    const create = vi.spyOn(fake.client.ordering!.numbers, 'create')
    const { result } = renderHook(() => useNumberChannel('sms'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { await result.current.run({ action: 'quote' }) })
    await act(async () => { expect((await result.current.run({ action: 'purchase', consent: false })).succeeded).toBe(false) })
    expect(create).not.toHaveBeenCalled()
    await act(async () => { await result.current.run({ action: 'purchase', consent: true }) })
    expect(create).toHaveBeenCalledWith({ quoteToken: 'opaque-signed-quote', consent: true, clientReference: 'agent:demo:sms', transport: 'sms' })
    expect(result.current.orders[0]?.deliveryVerified).toBe(false)
  })

  it('retries a lost purchase response with the exact quote and blocks requoting', async () => {
    const fake = setup()
    const create = vi.spyOn(fake.client.ordering!.numbers, 'create').mockRejectedValueOnce(new Error('Response lost'))
    const quote = vi.spyOn(fake.client.ordering!.numbers, 'quote')
    const { result } = renderHook(() => useNumberChannel('sms'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { await result.current.run({ action: 'quote' }) })
    await act(async () => { await result.current.run({ action: 'purchase', consent: true }) })
    expect(result.current.uncertain).toBe(true)
    await act(async () => { expect((await result.current.run({ action: 'quote' })).succeeded).toBe(false) })
    expect(quote).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.run({ action: 'purchase', consent: true }) })
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0])
  })

  it('retains the acknowledged order if the follow-up list fails', async () => {
    const fake = setup()
    const list = vi.spyOn(fake.client.ordering!.numbers, 'list')
    const { result } = renderHook(() => useNumberChannel('sms'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { await result.current.run({ action: 'quote' }) })
    list.mockRejectedValue(new Error('Read unavailable'))
    await act(async () => { await result.current.run({ action: 'purchase', consent: true }) })
    await waitFor(() => expect(result.current.resource.status).toBe('error'))
    expect(result.current.orders.map(order => order.id)).toEqual([numberOrder().id])
    expect(result.current.held?.id).toBe(numberOrder().id)
  })

  it('blocks purchasing while an order is held', async () => {
    const fake = setup()
    fake.state.orders = [numberOrder()]
    const quote = vi.spyOn(fake.client.ordering!.numbers, 'quote')
    const { result } = renderHook(() => useNumberChannel('sms'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.held?.id).toBe(numberOrder().id))
    await act(async () => { expect((await result.current.run({ action: 'quote' })).succeeded).toBe(false) })
    expect(quote).not.toHaveBeenCalled()
  })

  it('does not infer absence of orders from an older incomplete page', async () => {
    const fake = setup()
    vi.spyOn(fake.client.ordering!.numbers, 'list').mockResolvedValue({ orders: [] })
    const { result } = renderHook(() => useNumberChannel('sms'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource).toMatchObject({ value: { complete: false } }))
    await act(async () => { expect((await result.current.run({ action: 'quote' })).succeeded).toBe(false) })
  })

  it('follows order pages and discovers a held order on a later page', async () => {
    const fake = setup()
    const list = vi.spyOn(fake.client.ordering!.numbers, 'list').mockResolvedValueOnce({ orders: [], nextCursor: 'page2' }).mockResolvedValueOnce({ orders: [numberOrder()], nextCursor: null })
    const { result } = renderHook(() => useNumberChannel('sms'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.held?.id).toBe(numberOrder().id))
    expect(list).toHaveBeenNthCalledWith(2, { clientReference: 'agent:demo:sms', cursor: 'page2', limit: 100 })
  })

  it('rejects repeated pagination cursors', async () => {
    const fake = setup()
    vi.spyOn(fake.client.ordering!.numbers, 'list').mockResolvedValue({ orders: [], nextCursor: 'loop' })
    const { result } = renderHook(() => useNumberChannel('sms'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('error'))
  })

  it('requires explicit confirmation for cancellation', async () => {
    const fake = setup()
    fake.state.orders = [numberOrder()]
    const cancel = vi.spyOn(fake.client.ordering!.numbers, 'cancel')
    const { result } = renderHook(() => useNumberChannel('sms'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.orders).toHaveLength(1))
    await act(async () => { expect((await result.current.run({ action: 'cancel', orderId: numberOrder().id, confirm: false })).succeeded).toBe(false) })
    expect(cancel).not.toHaveBeenCalled()
    await act(async () => { await result.current.run({ action: 'cancel', orderId: numberOrder().id, confirm: true }) })
    expect(cancel).toHaveBeenCalledWith(numberOrder().id)
  })
})

describe('line payment', () => {
  it('creates checkout without granting paid status', async () => {
    const fake = setup()
    const checkout = vi.spyOn(fake.client.payment!, 'checkout')
    const { result } = renderHook(() => useLinePayment('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { await result.current.run({ consent: true }) })
    expect(checkout).toHaveBeenCalledWith('ln_demo')
    expect(result.current.state).toMatchObject({ status: 'succeeded', value: 'https://checkout.example.com/session' })
    expect(result.current.resource).toMatchObject({ value: { allowance: { tier: 'free' } } })
  })

  it('refuses checkout when paying cannot lift the limit', async () => {
    const fake = setup()
    fake.state.payment.allowance = { ...fake.state.payment.allowance, decision: 'allowance_reached', paywall: false }
    const checkout = vi.spyOn(fake.client.payment!, 'checkout')
    const { result } = renderHook(() => useLinePayment('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { expect((await result.current.run({ consent: true })).succeeded).toBe(false) })
    expect(checkout).not.toHaveBeenCalled()
  })

  it('rejects unsafe checkout redirects', async () => {
    const fake = setup()
    fake.client.payment!.checkout = async () => ({ url: 'javascript:alert(1)' })
    const { result } = renderHook(() => useLinePayment('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { expect((await result.current.run({ consent: true })).succeeded).toBe(false) })
    expect(result.current.state.status).toBe('failed')
  })
})
