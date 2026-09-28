// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ChannelsProvider, ChannelVerificationPanel, LinePayPage, useChannel, useChannelConversations, useConnectChannel, useNumberChannel, type Line } from '../../src/channels'
import { channelAttachment, channelLine, channelTest, createChannelsFixture, numberOrder } from '../../src/stories/fixtures/channels'

function setup() {
  const fake = createChannelsFixture()
  const wrapper = ({ children }: PropsWithChildren) => <ChannelsProvider client={fake.client} pollInterval={false}>{children}</ChannelsProvider>
  return { ...fake, wrapper }
}

describe('channel boundary regressions', () => {
  it('clears checkout consent when the published terms or price change', async () => {
    const user = userEvent.setup()
    const fake = setup()
    render(<LinePayPage lineId="ln_demo" />, { wrapper: fake.wrapper })
    await user.click(await screen.findByRole('checkbox'))
    expect((screen.getByRole('button', { name: 'Continue to checkout' }) as HTMLButtonElement).disabled).toBe(false)
    fake.state.payment = { ...fake.state.payment, terms: 'Updated subscription terms.', plan: { ...fake.state.payment.plan, paid: { ...fake.state.payment.plan.paid!, priceUsdMonthly: 30 } } }
    fireEvent.click(screen.getByRole('button', { name: 'Check payment status' }))
    await screen.findByText('Updated subscription terms.')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: 'Continue to checkout' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not claim active delivery proof when the host expires a verified test', async () => {
    const fake = setup()
    fake.state.line = channelLine({ attachment: channelAttachment() })
    fake.state.test = { ...channelTest('verified'), expired: true }
    render(<ChannelVerificationPanel lineId="ln_demo" />, { wrapper: fake.wrapper })
    expect(await screen.findByText(/This test expired/)).toBeTruthy()
    expect(screen.queryByText(/Both directions verified. Answering/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop this test' })).toBeTruthy()
  })

  it('keeps the shared-router instructions available after activation', async () => {
    const fake = setup()
    fake.state.line = channelLine({ attachment: channelAttachment() })
    fake.state.test = channelTest('verified')
    render(<ChannelVerificationPanel lineId="ln_demo" />, { wrapper: fake.wrapper })
    expect(await screen.findByText('Share this: send connect @helper to +15550100001.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy connect @helper' })).toBeTruthy()
  })

  it('refuses an expired inbound test even before the server expiry flag updates', async () => {
    const fake = setup()
    fake.state.test = { ...channelTest('received'), expiresAt: Date.now() - 1000 }
    const send = vi.spyOn(fake.client.setup, 'send')
    const { result } = renderHook(() => useChannel('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { expect((await result.current.run({ action: 'send' })).succeeded).toBe(false) })
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects a thread list from another line', async () => {
    const fake = setup()
    fake.client.lines.threads = () => ({ list: async () => [{ ...fake.thread, lineId: 'ln_other' }], messages: async () => [] })
    const { result } = renderHook(() => useChannelConversations('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current).toMatchObject({ status: 'error', message: 'The thread response belongs to another line.' }))
  })

  it('rejects a line whose attachment belongs to another line', async () => {
    const fake = setup()
    fake.state.line = channelLine({ attachment: { ...channelAttachment(), lineId: 'ln_other' } })
    fake.state.test = channelTest('verified')
    const { result } = renderHook(() => useChannel('ln_demo'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('error'))
  })

  it('does not invoke the connection callback after unmount', async () => {
    const fake = setup()
    let resolve!: (value: Line) => void
    fake.client.lines.fromConnection = () => new Promise<Line>(done => { resolve = done })
    const connected = vi.fn()
    const { result, unmount } = renderHook(() => useConnectChannel(connected), { wrapper: fake.wrapper })
    let running!: ReturnType<typeof result.current.run>
    act(() => { running = result.current.run({ kind: 'connection', input: { transport: 'imessage', connectionId: 'conn_demo' } }) })
    unmount()
    await act(async () => { resolve(channelLine()); await running })
    expect(connected).not.toHaveBeenCalled()
  })

  it('refuses a purchase when published terms are absent', async () => {
    const fake = setup()
    const quote = fake.client.ordering!.numbers.quote
    fake.client.ordering!.numbers.quote = async input => { const response = await quote(input); return { quote: { ...response.quote, terms: '' } } }
    const create = vi.spyOn(fake.client.ordering!.numbers, 'create')
    const { result } = renderHook(() => useNumberChannel('sms'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { await result.current.run({ action: 'quote' }) })
    await act(async () => { expect((await result.current.run({ action: 'purchase', consent: true })).succeeded).toBe(false) })
    expect(create).not.toHaveBeenCalled()
  })
  it('keeps an unresolved quote locked even when older released orders are listed', async () => {
    const fake = setup()
    fake.state.orders = [numberOrder({ cancellation: 'released', status: 'cancelled' })]
    vi.spyOn(fake.client.ordering!.numbers, 'create').mockRejectedValue(new Error('Response lost'))
    const quote = vi.spyOn(fake.client.ordering!.numbers, 'quote')
    const { result } = renderHook(() => useNumberChannel('sms'), { wrapper: fake.wrapper })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    await act(async () => { await result.current.run({ action: 'quote' }) })
    await act(async () => { await result.current.run({ action: 'purchase', consent: true }) })
    await waitFor(() => expect(result.current.resource.status).toBe('ready'))
    expect(result.current.uncertain).toBe(true)
    await act(async () => { expect((await result.current.run({ action: 'quote' })).succeeded).toBe(false) })
    expect(quote).toHaveBeenCalledTimes(1)
    expect(result.current.quote?.token).toBe('opaque-signed-quote')
  })

})
