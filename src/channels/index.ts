/** Browser-safe channel UI. Supply one authenticated ChannelsClient; no server wiring is bundled. */
export type {
  ChannelsClient, ChannelConnection, ChannelNumber, ChannelReadContext, ChannelVerification,
  ConnectChannelInput, LinePayment, Line, LineAttachment, LineFromConnectionInput, LineMessage,
  LineThread, LineTransport, HubNumberOrder, HubNumberQuote, HubNumberReadiness,
} from './types'
export { ChannelsProvider, useChannelsClient } from './context'
export {
  useChannels, useChannelConnections, useWhatsAppNumbers, useConnectChannel, useChannel,
  useChannelConversations, useChannelConversation, verificationExpired,
  type VerificationAction,
} from './hooks'
export {
  ChannelConnect, ChannelVerificationPanel, IMessageChannel, WhatsAppChannel, SMSChannel,
  EmailChannel, NumberChannel, ChannelConversation, ChannelConversations,
  channelMessageLink, type ChannelConnectProps,
} from './components'
export { useNumberChannel, holdsNumber, numberStage, NUMBER_CHARGE_NOTICE, NUMBER_RETRY_NOTICE } from './numbers'
export { useLinePayment, LinePayPage, safeCheckoutUrl } from './payment'
