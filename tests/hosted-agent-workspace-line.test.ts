import { describe, expect, it, vi } from 'vitest'
import type { LineAttachment, SandboxInstance } from '@tangle-network/sandbox/core'
import { attachWorkspaceLine, publicApplicationSenderVerification } from '../src/hosted-agent/application'
import type { OwnerApplicationSenderVerification } from '../src/hosted-agent/application'

const lineId = 'ln_proof'
const testId = 'lsv_proof'
const application = {
  url: 'https://app.example.test/line', binding: 'binding_1', secret: 'callback-secret-123456',
}

function verified(): OwnerApplicationSenderVerification {
  const at = new Date().toISOString()
  return {
    lineId, testId, state: 'verified', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    approvedSender: '+15550100001',
    proof: { signedInboundTestAt: at, providerReplyAcknowledgedAt: at, signedInboundConfirmAt: at },
  }
}

function clients(result: OwnerApplicationSenderVerification) {
  const attach = vi.fn(async () => ({ id: 'lat_proof' }) as LineAttachment)
  const box = { lines: { attach } } as unknown as Pick<SandboxInstance, 'lines'>
  const ownerLines = { getSenderVerification: vi.fn(async () => result) }
  return { attach, box, ownerLines }
}

describe('application line sender proof', () => {
  it('derives the member from the owner read and binds one-use proof to attach', async () => {
    const { attach, box, ownerLines } = clients(verified())
    await attachWorkspaceLine({ box, ownerLines, lineId, senderVerificationId: testId,
      application, turnsPerDay: 8 })
    expect(ownerLines.getSenderVerification).toHaveBeenCalledWith(lineId, testId)
    expect(attach).toHaveBeenCalledWith({
      number: lineId, senderVerificationId: testId, mode: 'personal',
      members: [{ address: '+15550100001', role: 'owner' }], unknownSenders: 'reject',
      roles: { owner: { context: 'own', tools: 'act' } },
      respond: { kind: 'agent', application }, limits: { turnsPerMemberPerDay: 8 },
    })
  })

  it.each([
    ['unverified', { state: 'challenge_sent' }],
    ['wrong line', { lineId: 'ln_other' }],
    ['wrong test', { testId: 'lsv_other' }],
    ['expired', { expiresAt: new Date(Date.now() - 1_000).toISOString() }],
    ['no CONFIRM', { proof: { ...verified().proof, signedInboundConfirmAt: null } }],
    ['no approved sender', { approvedSender: undefined }],
  ])('refuses %s before any attach', async (_name, patch) => {
    const result = { ...verified(), ...patch } as OwnerApplicationSenderVerification
    const { attach, box, ownerLines } = clients(result)
    await expect(attachWorkspaceLine({ box, ownerLines, lineId,
      senderVerificationId: testId, application })).rejects.toThrow()
    expect(attach).not.toHaveBeenCalled()
  })

  it('strips approvedSender from the public status', () => {
    const result = publicApplicationSenderVerification(verified())
    expect(result.state).toBe('verified')
    expect(result.proof.signedInboundConfirmAt).toBeTruthy()
    expect(JSON.stringify(result)).not.toContain('+15550100001')
    expect(result).not.toHaveProperty('approvedSender')
  })
})
