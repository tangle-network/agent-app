import { describe, it, expect, vi, beforeEach } from 'vitest'

// vitest hoists vi.mock above imports; factory-referenced vars must be `mock`-prefixed.
const mockSend = vi.fn()
vi.mock('resend', () => ({ Resend: vi.fn(() => ({ emails: { send: mockSend } })) }))

import { Resend } from 'resend'
import { createResendInvitationSender } from '../../src/teams/resend'

const input = {
  to: 'invitee@x.com',
  workspaceName: 'Acme',
  inviterEmail: 'boss@x.com',
  permission: 'editor' as const,
  inviteUrl: 'https://app/invite/inv_x',
  expiresAt: new Date('2026-01-08T00:00:00.000Z'),
}

describe('createResendInvitationSender', () => {
  beforeEach(() => mockSend.mockClear())

  it('fails typed when no API key is configured (and never calls Resend)', async () => {
    const prev = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY
    try {
      const send = createResendInvitationSender({ from: 'X <x@x.com>' })
      expect(await send(input)).toEqual({ succeeded: false, error: 'RESEND_API_KEY is not configured' })
      expect(mockSend).not.toHaveBeenCalled()
    } finally {
      if (prev !== undefined) process.env.RESEND_API_KEY = prev
    }
  })

  it('succeeds when Resend returns no error, sending the rendered template', async () => {
    mockSend.mockImplementation(async () => ({ data: { id: 'e1' }, error: null }))
    const send = createResendInvitationSender({ from: 'X <x@x.com>', apiKey: 'key' })
    expect(await send(input)).toEqual({ succeeded: true })
    expect(mockSend).toHaveBeenCalledOnce()
    const arg = mockSend.mock.calls[0]![0]
    expect(arg.from).toBe('X <x@x.com>')
    expect(arg.to).toBe('invitee@x.com')
    expect(arg.subject).toContain('boss@x.com')
    expect(arg.html).toContain('https://app/invite/inv_x')
    expect(typeof arg.text).toBe('string')
  })

  it('fails typed when Resend reports result.error WITHOUT throwing', async () => {
    mockSend.mockImplementation(async () => ({ data: null, error: { name: 'validation_error', message: 'domain not verified' } }))
    const send = createResendInvitationSender({ from: 'X <x@x.com>', apiKey: 'key' })
    expect(await send(input)).toEqual({ succeeded: false, error: 'domain not verified' })
  })

  it('fails typed when the send throws', async () => {
    // A plain throwing `send` (not a vi.fn) for this case: vitest's mock
    // instrumentation otherwise surfaces the already-caught throw as a spurious
    // failure. The seam still catches it and returns the typed outcome.
    vi.mocked(Resend).mockImplementationOnce(
      () => ({ emails: { send: () => { throw new Error('network down') } } }) as unknown as Resend,
    )
    const send = createResendInvitationSender({ from: 'X <x@x.com>', apiKey: 'key' })
    expect(await send(input)).toEqual({ succeeded: false, error: 'network down' })
  })
})
