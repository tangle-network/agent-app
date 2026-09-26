import type { ChannelsClient, ChannelVerification, Line, LineAttachment, LineMessage, LineThread, HubNumberOrder, LinePayment } from '../../channels/types'

export function channelLine(overrides: Partial<Line> = {}): Line {
  const value = {
    id: 'ln_demo', transport: 'imessage' as const, address: '@helper', connect: 'connect @helper', routerAddress: '+15550100001',
    connectionId: 'conn_demo', providerNumberId: null, label: 'Helper', clientReference: 'agent:demo',
    status: 'active' as const, voice: null, attachment: null,
    createdAt: '2026-09-24T12:00:00Z', updatedAt: '2026-09-24T12:00:00Z',
  }
  return { ...value, ...overrides }
}

export function channelAttachment(): LineAttachment {
  return {
    id: 'att_demo', lineId: 'ln_demo', sandboxId: 'box_demo', mode: 'personal', unknownSenders: 'reject',
    roles: { owner: { context: 'own', tools: 'chat' } }, respond: { kind: 'agent' },
    limits: { turnsPerMemberPerDay: 20, noticesPerSenderPerDay: 2, noticesPerLinePerDay: 20 },
    status: 'active', clientReference: 'agent:demo', createdAt: '2026-09-24T12:00:00Z', updatedAt: '2026-09-24T12:00:00Z',
  }
}

export function channelTest(status: ChannelVerification['status'] = 'waiting'): ChannelVerification {
  return { id: 'test_demo', lineId: 'ln_demo', status, instruction: 'TEST example-only', expiresAt: Date.now() + 900000, expired: false, error: null }
}

export function channelMessage(id = 'message_in', overrides: Partial<LineMessage> = {}): LineMessage {
  const value = {
    id, threadId: 'thread_demo', memberId: 'member_demo', direction: 'in' as const, kind: 'agent' as const,
    deliveryKey: id, replyToId: null, turnId: null, text: 'Hello from the channel', status: 'received', errorCode: null,
    timeline: null, createdAt: '2026-09-24T12:01:00Z',
  }
  return { ...value, ...overrides }
}

export function numberOrder(overrides: Partial<HubNumberOrder> = {}): HubNumberOrder {
  return {
    id: `num_${'a'.repeat(36)}`, clientReference: 'agent:demo:sms', transport: 'sms', status: 'ready_for_setup', phase: 'complete',
    address: '+15550100002', connectionId: 'conn_demo', identityId: 'identity_demo', providerNumberId: 'number_demo',
    billingStatus: 'settled', cancellation: 'none', errorCode: null, nextAttemptAt: null, resolution: null,
    deliveryVerified: false, activationCents: 1500, currency: 'usd', terms: 'One-time activation. Message usage is separate.', ...overrides,
  }
}

/** Deterministic, in-memory SDK-shaped fixture. Never connects to a provider. */
export function createChannelsFixture() {
  const state: {
    line: Line; test: ChannelVerification | null; messages: LineMessage[]; orders: HubNumberOrder[]; payment: LinePayment
  } = {
    line: channelLine(), test: null, messages: [], orders: [],
    payment: {
      label: 'Helper line', terms: 'Monthly subscription. Cancel through your account.',
      plan: { meter: 'helper', configured: true, updatedAt: null, free: { turnsPerDay: 20, usdPerDay: null }, paid: { turnsPerDay: 100, usdPerDay: 5, priceUsdMonthly: 15 }, owner: { turnsPerDay: 200 }, spendResourceType: 'line' },
      allowance: { decision: 'paywall', tier: 'free', paywall: true, turns: { used: 20, limit: 20 }, usd: null, day: '2026-09-24', resetsAt: '2026-09-25T00:00:00Z' },
    },
  }
  const thread: LineThread = { id: 'thread_demo', lineId: 'ln_demo', memberId: 'member_demo', sandboxId: 'box_demo', sessionId: 'session_demo', lastMessageAt: null, status: 'active', createdAt: '2026-09-24T12:00:00Z' }
  const client: ChannelsClient = {
    scope: 'agent:demo',
    lines: {
      list: async () => [state.line],
      get: async () => state.line,
      fromConnection: async input => {
        state.line = channelLine({ transport: input.transport, connectionId: input.connectionId, ...(input.transport === 'whatsapp' ? { address: '+15550100002', connect: null, routerAddress: null, providerNumberId: input.phoneNumberId } : {}) })
        return state.line
      },
      threads: () => ({ list: async () => [thread], messages: async () => state.messages }),
    },
    setup: {
      connections: async () => [{ id: 'conn_demo', displayName: 'Owned connection', account: 'owner@example.com' }],
      whatsappNumbers: async () => [{ id: 'number_demo', address: '+15550100002' }],
      fromEmail: async input => { state.line = channelLine({ transport: 'email', address: input.address, connectionId: input.connectionId, routerAddress: null, connect: null }); return state.line },
      fromOrder: async () => { state.line = channelLine({ transport: 'sms', address: '+15550100002', routerAddress: null, connect: null }); return state.line },
      verification: async () => state.test,
      start: async () => (state.test = channelTest()),
      resume: async () => (state.test = channelTest('waiting')),
      send: async () => (state.test = channelTest('sent')),
      reset: async () => { state.test = null },
      // Intentionally does not enforce the UI guard: the hook test must detect
      // a regression even when the fake backend would accept early activation.
      activate: async () => { state.line = { ...state.line, attachment: channelAttachment() }; return state.line },
    },
    ordering: {
      references: { sms: 'agent:demo:sms', imessage: 'agent:demo:imessage' },
      numbers: {
        readiness: async () => ({ configured: true, provider: 'inkbox', transports: ['sms', 'imessage'], billing: 'prepaid_activation', automaticRentalBilling: false, deliveryVerified: false }),
        list: async () => ({ orders: state.orders, nextCursor: null }),
        quote: async input => ({ quote: { ...input, activationCents: 1500, currency: 'usd', termsVersion: 'v1', terms: 'One-time activation. Message usage is separate.', expiresAt: Date.now() + 60000, token: 'opaque-signed-quote' } }),
        create: async input => { const order = numberOrder({ transport: input.transport, clientReference: input.clientReference }); state.orders = [order]; return { order } },
        advance: async id => { const order = state.orders.find(item => item.id === id); if (!order) throw new Error('Order not found'); return { order } },
        cancel: async id => { const order = numberOrder({ ...state.orders.find(item => item.id === id), id, cancellation: 'released', status: 'cancelled' }); state.orders = [order]; return { order } },
      },
    },
    payment: { read: async () => state.payment, checkout: async () => ({ url: 'https://checkout.example.com/session' }) },
  }
  return { client, state, thread }
}
