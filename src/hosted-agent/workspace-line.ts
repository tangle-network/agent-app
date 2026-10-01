import type { LineApplication, LineAttachment, SandboxInstance } from '@tangle-network/sandbox/core'
import type { OwnerApplicationSenderVerification } from './application-verification'

export interface ApplicationOwnerLines {
  /** Read with the same owner API key that started TEST and will attach. */
  getSenderVerification(lineId: string, testId: string): Promise<OwnerApplicationSenderVerification>
}

/** Attach a proved handset to the application's normal chat path. Platform
 * atomically consumes the one-use proof and checks this owner key again. */
export async function attachWorkspaceLine(input: {
  box: Pick<SandboxInstance, 'lines'>
  ownerLines: ApplicationOwnerLines
  lineId: string
  senderVerificationId: string
  application: LineApplication
  turnsPerDay?: number
}): Promise<LineAttachment> {
  if (!/^lsv_[A-Za-z0-9_-]+$/.test(input.senderVerificationId)) {
    throw new TypeError('A valid sender verification id is required')
  }
  const verification = await input.ownerLines.getSenderVerification(input.lineId, input.senderVerificationId)
  const expiresAt = new Date(verification.expiresAt).getTime()
  if (verification.lineId !== input.lineId || verification.testId !== input.senderVerificationId
    || verification.state !== 'verified' || !verification.proof.signedInboundTestAt
    || !verification.proof.providerReplyAcknowledgedAt || !verification.proof.signedInboundConfirmAt
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new TypeError('The selected line has no current verified sender proof')
  }
  const address = verification.approvedSender?.trim() ?? ''
  const turnsPerDay = input.turnsPerDay ?? 20
  if (!/^\+[1-9]\d{6,14}$/.test(address) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new TypeError('The verified sender must be an E.164 number or email/Apple ID')
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
  const attachment = {
    number: input.lineId,
    senderVerificationId: input.senderVerificationId,
    mode: 'personal',
    members: [{ address: address.includes('@') ? address.toLowerCase() : address, role: 'owner' }],
    unknownSenders: 'reject',
    roles: { owner: { context: 'own', tools: 'act' } },
    respond: { kind: 'agent', application: { ...input.application } },
    limits: { turnsPerMemberPerDay: turnsPerDay },
  } satisfies Parameters<SandboxInstance['lines']['attach']>[0] & { senderVerificationId: string }
  return input.box.lines.attach(attachment)
}
