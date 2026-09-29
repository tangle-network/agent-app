import type { LineApplication, LineAttachment, SandboxInstance } from '@tangle-network/sandbox/core'

/** A line delegates its nominated owner to the application's normal chat path. */
export async function attachWorkspaceLine(input: {
  box: Pick<SandboxInstance, 'lines'>
  lineId: string
  ownerAddress: string
  application: LineApplication
  turnsPerDay?: number
}): Promise<LineAttachment> {
  const address = input.ownerAddress.trim()
  const turnsPerDay = input.turnsPerDay ?? 20
  if (!/^\+[1-9]\d{6,14}$/.test(address) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new TypeError('The delegated sender must be an E.164 number or email/Apple ID')
  }
  if (!Number.isSafeInteger(turnsPerDay) || turnsPerDay < 1 || turnsPerDay > 10_000) {
    throw new TypeError('A daily turn limit between 1 and 10000 is required')
  }
  const url = new URL(input.application.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new TypeError('The application callback must use HTTPS without URL credentials or a fragment')
  }
  if (!/^[\x21-\x7e]{1,1024}$/.test(input.application.binding)
    || !/^[\x21-\x7e]{16,512}$/.test(input.application.secret)) {
    throw new TypeError('A binding and a header-safe callback credential are required')
  }
  return input.box.lines.attach({
    number: input.lineId,
    mode: 'personal',
    members: [{ address: address.includes('@') ? address.toLowerCase() : address, role: 'owner' }],
    unknownSenders: 'reject',
    roles: { owner: { context: 'own', tools: 'act' } },
    respond: { kind: 'agent', application: { ...input.application } },
    limits: { turnsPerMemberPerDay: turnsPerDay },
  })
}
