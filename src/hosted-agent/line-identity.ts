import type { Line, Sandbox } from '@tangle-network/sandbox/core'

/** Resolve an exact owned identity through the published SDK, never provider HTTP.
 * Selected iMessage numbers must already be registered as native lines until
 * number-selecting fromConnection is part of the published SDK contract.
 */
export async function resolveHostedLine(client: Pick<Sandbox, 'lines'>, input: {
  connectionId: string
  transport: 'imessage' | 'whatsapp' | 'email'
  phoneNumberId?: string
}): Promise<Line> {
  if (input.transport === 'email' && input.phoneNumberId) throw new Error('Email lines do not accept phoneNumberId.')
  if (input.transport === 'imessage' && input.phoneNumberId) {
    const matches = (await client.lines.list()).filter(line => line.status !== 'released' &&
      line.connectionId === input.connectionId && line.transport === input.transport &&
      line.providerNumberId === input.phoneNumberId)
    if (matches.length !== 1) throw new Error(matches.length
      ? 'Multiple lines match this provider number. Attach the intended line by its exact id.'
      : 'Register this iMessage number as a native line in Hub, then attach its line id. No other number was selected.')
    return matches[0]!
  }
  if (input.transport === 'whatsapp') {
    if (!input.phoneNumberId) throw new Error('WhatsApp requires phoneNumberId.')
    return client.lines.fromConnection({ connectionId: input.connectionId, transport: input.transport, phoneNumberId: input.phoneNumberId })
  }
  return client.lines.fromConnection({ connectionId: input.connectionId, transport: input.transport })
}
