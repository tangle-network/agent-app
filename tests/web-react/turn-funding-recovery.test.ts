import { describe, expect, it } from 'vitest'
import { getChatFundingRecovery } from '../../src/web-react/turn-funding-recovery'

describe('chat funding recovery', () => {
  it.each([
    ['opencode execution failed: Insufficient credits. Top up at id.tangle.tools. (exit code 1)', 'insufficient_credits'],
    ['opencode execution failed: Inference requires verified paid access. Add funds or activate a paid seat at id.tangle.tools. (exit code 1)', 'paid_access_required'],
  ] as const)('directs the observed sandbox refusal to billing: %s', (message, reason) => {
    const recovery = getChatFundingRecovery({ code: 'OPENCODE_ERROR', message })
    expect(recovery?.reason).toBe(reason)
    expect(recovery?.retryable).toBe(false)
    expect(recovery?.actionLabel).toBe('Open billing')
    expect(recovery?.message).toContain('before trying again')
    expect(recovery?.message).not.toMatch(/pick|switch|different model/i)
  })

  it.each(['paid_access_required', 'funding_required', 'insufficient_credits'])(
    'recognizes structured %s without depending on provider wording',
    (code) => expect(getChatFundingRecovery({ code, message: 'Request denied' })?.retryable).toBe(false),
  )

  it('keeps the structured prerequisite when a wrapper carries another funding message', () => {
    expect(getChatFundingRecovery({ code: 'paid_access_required', message: 'Insufficient credits' })?.reason)
      .toBe('paid_access_required')
  })

  it('accepts legacy string-only and Error failures', () => {
    expect(getChatFundingRecovery('Insufficient credits')?.title).toBe('Insufficient credits')
    expect(getChatFundingRecovery(new Error('Inference requires verified paid access'))?.title).toBe('Paid access required')
  })

  it.each([
    undefined, null, '', '503 upstream unavailable', '429 rate limit exceeded',
    'Invalid API key', 'Your credits are available',
    { code: 'readiness.blocked', message: 'Upload supporting documents' },
    { code: 'email_verification_required', message: 'Verify your email' },
    { message: 'Payment service unavailable' },
  ])('leaves unrelated or missing failures to the owning recovery policy: %j', (failure) => {
    expect(getChatFundingRecovery(failure)).toBeNull()
  })
})
