import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { ChannelConversation, ChannelVerificationPanel, ChannelsProvider, EmailChannel, IMessageChannel, LinePayPage, NumberChannel, WhatsAppChannel } from '../channels'
import { channelAttachment, channelMessage, channelTest, createChannelsFixture, numberOrder } from './fixtures/channels'
import type { ChannelVerification } from '../channels'

function Surface({ surface = 'imessage', status, expired = false, failure = false, active = false }: {
  surface?: 'imessage' | 'whatsapp' | 'email' | 'number' | 'history' | 'payment' | 'verification'
  status?: ChannelVerification['status']
  expired?: boolean
  failure?: boolean
  active?: boolean
}) {
  const [fixture] = useState(() => {
    const fake = createChannelsFixture()
    if (status) fake.state.test = { ...channelTest(status), expired }
    if (active) fake.state.line.attachment = channelAttachment()
    if (surface === 'number') fake.state.orders = [numberOrder()]
    if (surface === 'history') fake.state.messages = [channelMessage('out', { direction: 'out', text: 'Your agent replied in the same channel.', createdAt: '2026-09-24T12:02:00Z', status: 'delivered' }), channelMessage()]
    if (failure) fake.client.lines.get = async () => { throw new Error('The channel could not be read. Existing connections are unchanged.') }
    return fake
  })
  return <div className="w-full max-w-2xl"><ChannelsProvider client={fixture.client} pollInterval={false}>
    {surface === 'imessage' ? <IMessageChannel /> : surface === 'whatsapp' ? <WhatsAppChannel /> : surface === 'email' ? <EmailChannel /> : surface === 'number' ? <NumberChannel transport="sms" /> : surface === 'history' ? <ChannelConversation lineId="ln_demo" threadId="thread_demo" /> : surface === 'payment' ? <LinePayPage lineId="ln_demo" /> : <ChannelVerificationPanel lineId="ln_demo" />}
  </ChannelsProvider></div>
}

const meta = { title: 'Channels/Connect and verify', component: Surface, parameters: { layout: 'padded' } } satisfies Meta<typeof Surface>
export default meta
type Story = StoryObj<typeof meta>
export const SharedIMessage: Story = { args: { surface: 'imessage' } }
export const WhatsApp: Story = { args: { surface: 'whatsapp' } }
export const Mailbox: Story = { args: { surface: 'email' } }
export const WaitingForInbound: Story = { args: { surface: 'verification', status: 'waiting' } }
export const InboundReceived: Story = { args: { surface: 'verification', status: 'received' } }
export const AwaitingConfirmation: Story = { args: { surface: 'verification', status: 'sent' } }
export const ExpiredTest: Story = { args: { surface: 'verification', status: 'waiting', expired: true } }
export const UncertainReply: Story = { args: { surface: 'verification', status: 'uncertain' } }
export const NeedsReview: Story = { args: { surface: 'verification', status: 'needs_review' } }
export const ReadFailure: Story = { args: { surface: 'verification', failure: true } }
export const ReadyToActivate: Story = { args: { surface: 'verification', status: 'verified' } }
export const AnsweringMessages: Story = { args: { surface: 'verification', status: 'verified', active: true } }
export const NumberAcquiredNotVerified: Story = { args: { surface: 'number' } }
export const ConversationHistory: Story = { args: { surface: 'history' } }
export const LinePayPageState: Story = { args: { surface: 'payment' } }
