import type { Line, LineFromConnectionInput, LinesClient, LineTransport } from '@tangle-network/sandbox'
import type { HubAllowanceDecision, HubAllowancePlan, HubManagedNumbersClient } from '@tangle-network/hub-sdk'

export type { Line, LineAttachment, LineFromConnectionInput, LineMessage, LineThread, LineTransport } from '@tangle-network/sandbox'
export type { HubNumberOrder, HubNumberQuote, HubNumberReadiness } from '@tangle-network/hub-sdk'

/** Public evidence only. The host never returns a confirmation secret or sender identity. */
export interface ChannelVerification {
  id: string
  lineId: string
  status: 'configuring' | 'waiting' | 'received' | 'sending' | 'uncertain' | 'sent' | 'verified' | 'revoked' | 'needs_review'
  instruction: string
  expiresAt: number
  expired: boolean
  error: string | null
}

export interface ChannelConnection { id: string; displayName: string; account: string | null }
export interface ChannelNumber { id: string; address: string }
export interface ChannelReadContext { signal: AbortSignal }
export interface LinePayment {
  label: string
  plan: HubAllowancePlan
  allowance: HubAllowanceDecision
  /** Published terms, required before checkout is offered. */
  terms: string
}
export type ConnectChannelInput =
  | { kind: 'connection'; input: LineFromConnectionInput }
  | { kind: 'email'; connectionId: string; address: string }
  | { kind: 'order'; orderId: string }

/**
 * The one authenticated, agent-scoped boundary. Keep this object stable.
 *
 * `lines` delegates to Sandbox SDK client.lines (list MUST be scoped to this
 * agent). `setup` is the host's existing Hub/hosted-agent control plane: it
 * verifies ownership and delivery before sandbox.lines.attach, and never runs
 * provider HTTP calls in the browser. No execution, webhook, credential,
 * consent, or billing authority is implemented by this React subpath.
 *
 * Sandbox 0.51+ supplies fromConnection/get/threads; it does not supply email
 * creation, managed-order binding, or delivery verification. Those operations
 * deliberately remain injected instead of pretending they exist on the SDK.
 * The current hosted-agent export is server-only. Its hub-lines implementation
 * can implement this contract without changing channels.
 */
export interface ChannelsClient {
  /** Changes whenever the authenticated agent or owner changes. Not an auth credential. */
  scope: string
  lines: Pick<LinesClient, 'fromConnection' | 'get' | 'threads'> & { list(): Promise<Line[]> }
  setup: {
    connections(transport: LineTransport, context: ChannelReadContext): Promise<ChannelConnection[]>
    whatsappNumbers(connectionId: string, context: ChannelReadContext): Promise<ChannelNumber[]>
    fromEmail(input: { connectionId: string; address: string }): Promise<Line>
    fromOrder(orderId: string): Promise<Line>
    verification(lineId: string, context: ChannelReadContext): Promise<ChannelVerification | null>
    start(lineId: string): Promise<ChannelVerification>
    resume(lineId: string, testId: string): Promise<ChannelVerification>
    send(lineId: string, testId: string): Promise<ChannelVerification>
    reset(lineId: string, testId: string): Promise<void>
    /** Recheck proof and ownership server-side; attach through sandbox.lines. */
    activate(lineId: string, testId: string): Promise<Line>
  }
  /** Optional owner-only number ordering, delegated to hub.numbers. */
  ordering?: {
    numbers: Pick<HubManagedNumbersClient, 'readiness' | 'list' | 'quote' | 'create' | 'advance' | 'cancel'>
    references: Record<'sms' | 'imessage', string>
  }
  /** Optional member pay page. The host derives member/meter from authentication. */
  payment?: {
    /** Read Hub allowance plan/status, never admit a turn or grant a paid tier. */
    read(lineId: string, context: ChannelReadContext): Promise<LinePayment>
    /** Host-owned checkout; only a payment settlement may grant Hub allowance. */
    checkout(lineId: string): Promise<{ url: string }>
  }
}
