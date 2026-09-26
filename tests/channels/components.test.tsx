// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChannelConversation, ChannelVerificationPanel, ChannelsProvider, EmailChannel, LinePayPage, NumberChannel, WhatsAppChannel, channelMessageLink, safeCheckoutUrl } from '../../src/channels'
import { channelAttachment, channelLine, channelMessage, channelTest, createChannelsFixture, numberOrder } from '../../src/stories/fixtures/channels'
import type { ReactNode } from 'react'

function mount(child: ReactNode, configure?: (fake: ReturnType<typeof createChannelsFixture>) => void) {
  const fake = createChannelsFixture()
  configure?.(fake)
  return { ...fake, ...render(<ChannelsProvider client={fake.client} pollInterval={false}>{child}</ChannelsProvider>) }
}

describe('rendered channel surfaces', () => {
  it('shows shared-router instructions without exposing a confirmation secret', async () => {
    mount(<ChannelVerificationPanel lineId="ln_demo" />, fake => { fake.state.test = channelTest() })
    expect(await screen.findByText('connect @helper')).toBeTruthy()
    expect(screen.getByText('TEST example-only')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open Messages' }).getAttribute('href')).toBe('sms:+15550100001?body=connect%20%40helper')
    expect(screen.queryByRole('button', { name: 'Turn on messaging' })).toBeNull()
  })

  it('requires a second explicit click to stop verification', async () => {
    const user = userEvent.setup()
    const fake = mount(<ChannelVerificationPanel lineId="ln_demo" />, value => { value.state.test = channelTest() })
    const reset = vi.spyOn(fake.client.setup, 'reset')
    await user.click(await screen.findByRole('button', { name: 'Stop this test' }))
    expect(reset).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm stop' }))
    await waitFor(() => expect(reset).toHaveBeenCalledWith('ln_demo', 'test_demo'))
  })

  it('renders expired, uncertain, review, and sending states explicitly', async () => {
    const fake = createChannelsFixture()
    fake.state.test = { ...channelTest(), expired: true }
    const view = render(<ChannelsProvider client={fake.client} pollInterval={false}><ChannelVerificationPanel lineId="ln_demo" /></ChannelsProvider>)
    expect(await screen.findByText(/This test expired/)).toBeTruthy()
    for (const [status, text] of [['uncertain', /reply result is uncertain/], ['needs_review', /needs operator review/], ['sending', /reply is being sent/]] as const) {
      fake.state.test = channelTest(status)
      fireEvent.click(screen.getByRole('button', { name: 'Refresh channel status' }))
      expect(await screen.findByText(text)).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Send test reply' })).toBeNull()
    }
    view.unmount()
  })

  it('reports verified and active only when both evidence and attachment are returned', async () => {
    mount(<ChannelVerificationPanel lineId="ln_demo" />, fake => { fake.state.test = channelTest('verified'); fake.state.line = channelLine({ attachment: channelAttachment() }) })
    expect(await screen.findByText(/Both directions verified. Answering iMessage messages/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Turn on messaging' })).toBeNull()
  })

  it('selects a WhatsApp connection and owned number with keyboard and pointer input', async () => {
    const user = userEvent.setup()
    const fake = mount(<WhatsAppChannel />)
    const fromConnection = vi.spyOn(fake.client.lines, 'fromConnection')
    const connection = await screen.findByRole('combobox', { name: 'Connection' })
    await user.selectOptions(connection, 'conn_demo')
    await user.click(screen.getByRole('button', { name: 'Show owned numbers' }))
    await user.selectOptions(await screen.findByRole('combobox', { name: 'WhatsApp number' }), 'number_demo')
    const button = screen.getByRole('button', { name: 'Connect channel' })
    button.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fromConnection).toHaveBeenCalledWith({ transport: 'whatsapp', connectionId: 'conn_demo', phoneNumberId: 'number_demo' }))
    expect(await screen.findByRole('button', { name: 'Start channel test' })).toBeTruthy()
  })

  it('connects a mailbox through the same UI without direct provider calls', async () => {
    const user = userEvent.setup()
    const fake = mount(<EmailChannel />)
    const fromEmail = vi.spyOn(fake.client.setup, 'fromEmail')
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Connection' }), 'conn_demo')
    await user.type(screen.getByRole('textbox', { name: 'Mailbox address' }), 'HELLO@EXAMPLE.COM')
    await user.click(screen.getByRole('button', { name: 'Connect channel' }))
    await waitFor(() => expect(fromEmail).toHaveBeenCalledWith({ connectionId: 'conn_demo', address: 'hello@example.com' }))
    expect(await screen.findByText('Email · hello@example.com')).toBeTruthy()
  })

  it('shows read failures instead of an empty conversation', async () => {
    mount(<ChannelConversation lineId="ln_demo" threadId="thread_demo" />, fake => {
      fake.client.lines.threads = () => ({ list: async () => [], messages: async () => { throw new Error('History permission denied') } })
    })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('History permission denied'))
    expect(screen.queryByText('No messages in this conversation yet.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('renders inbound, outbound, and failed delivery without claiming they were sent', async () => {
    mount(<ChannelConversation lineId="ln_demo" threadId="thread_demo" />, fake => {
      fake.state.messages = [channelMessage('out', { direction: 'out', createdAt: '2026-09-24T12:02:00Z', text: 'A reply', status: 'failed', errorCode: 'delivery_refused' }), channelMessage()]
    })
    const log = await screen.findByRole('log')
    const rows = within(log).getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('Incoming')
    expect(rows[1]?.textContent).toContain('failed · delivery_refused')
  })

  it('does not label an acquired number verified', async () => {
    mount(<NumberChannel transport="sms" />, fake => { fake.state.orders = [numberOrder()] })
    expect(await screen.findByText('Number acquired — channel setup next')).toBeTruthy()
    expect(screen.queryByText('Verified from your phone')).toBeNull()
    expect((screen.getByRole('button', { name: 'See activation price' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('requires activation terms and consent in the number purchase UI', async () => {
    const user = userEvent.setup()
    const fake = mount(<NumberChannel transport="sms" />)
    const create = vi.spyOn(fake.client.ordering!.numbers, 'create')
    await user.click(await screen.findByRole('button', { name: 'See activation price' }))
    const order = await screen.findByRole('button', { name: 'Order for $15.00' })
    expect((order as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/This is a one-time activation charge/)).toBeTruthy()
    await user.click(screen.getByRole('checkbox'))
    await user.click(order)
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  })

  it('shows secure checkout but never treats returning as paid', async () => {
    const user = userEvent.setup()
    mount(<LinePayPage lineId="ln_demo" />)
    await screen.findByText('Helper line')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Continue to checkout' }))
    expect((await screen.findByRole('link', { name: 'Open secure checkout' })).getAttribute('href')).toBe('https://checkout.example.com/session')
    expect(screen.queryByText('Your paid allowance is active.')).toBeNull()
  })

  it('renders absent payment capability without offering checkout', () => {
    mount(<LinePayPage lineId="ln_demo" />, fake => { delete fake.client.payment })
    expect(screen.getByText('Payments are unavailable for this line.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue to checkout' })).toBeNull()
  })

  it('validates public message and checkout links', () => {
    expect(channelMessageLink(channelLine({ transport: 'email', address: 'a@example.com', connect: null, routerAddress: null }), 'TEST x')).toBe('mailto:a%40example.com?subject=Channel%20test&body=TEST%20x')
    expect(channelMessageLink(channelLine({ address: 'javascript:alert(1)', routerAddress: null }), 'x')).toBeNull()
    expect(() => safeCheckoutUrl('https://user:password@example.com')).toThrow()
    expect(() => safeCheckoutUrl('//example.com/evil')).toThrow()
    expect(() => safeCheckoutUrl('/\\example.com')).toThrow()
    expect(safeCheckoutUrl('/checkout/line')).toBe('/checkout/line')
  })
})
