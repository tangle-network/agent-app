import { describe, it, expect } from 'vitest'
import {
  INVITATION_EXPIRY_DAYS,
  generateInvitationToken,
  getInvitationExpiresAt,
  inviteUrlForToken,
  normalizeInvitationEmail,
  parseInvitationPermission,
  renderInvitationEmail,
} from '../../src/teams/invitations'

describe('invitation pure helpers', () => {
  it('normalizes email (trim + lowercase)', () => {
    expect(normalizeInvitationEmail('  Foo@Bar.COM ')).toBe('foo@bar.com')
  })

  it('parses only assignable permissions (never owner)', () => {
    expect(parseInvitationPermission('admin')).toBe('admin')
    expect(parseInvitationPermission('editor')).toBe('editor')
    expect(parseInvitationPermission('viewer')).toBe('viewer')
    expect(parseInvitationPermission('owner')).toBeNull()
    expect(parseInvitationPermission(undefined)).toBeNull()
    expect(parseInvitationPermission('garbage')).toBeNull()
  })

  it('mints inv_-prefixed, url-safe, unique tokens', () => {
    const a = generateInvitationToken()
    const b = generateInvitationToken()
    expect(a).toMatch(/^inv_[A-Za-z0-9_-]+$/)
    expect(a.length).toBeGreaterThan(20)
    expect(a).not.toBe(b)
  })

  it('expires INVITATION_EXPIRY_DAYS in the future', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    expect(getInvitationExpiresAt(now).getTime() - now.getTime()).toBe(
      INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    )
  })

  it('builds the invite url with a trimmed origin and encoded token', () => {
    expect(inviteUrlForToken('https://app.example.com/', 'inv_abc')).toBe(
      'https://app.example.com/invite/inv_abc',
    )
  })
})

describe('renderInvitationEmail', () => {
  const base = {
    to: 'invitee@x.com',
    workspaceName: 'Acme',
    inviterEmail: 'boss@x.com',
    permission: 'editor',
    inviteUrl: 'https://app/invite/inv_x',
    expiresAt: new Date('2026-01-08T00:00:00.000Z'),
  }

  it('uses the brand from-address and an inviter+workspace subject', () => {
    const msg = renderInvitationEmail(base, { fromAddress: 'GTM Agent <noreply@gtm.tangle.tools>' })
    expect(msg.from).toBe('GTM Agent <noreply@gtm.tangle.tools>')
    expect(msg.subject).toBe('boss@x.com invited you to Acme')
    expect(msg.html).toContain('https://app/invite/inv_x')
    expect(msg.html).toContain('as editor')
    expect(msg.text).toContain('Accept the invitation: https://app/invite/inv_x')
  })

  it('escapes html in workspace name and inviter email', () => {
    const msg = renderInvitationEmail(
      { ...base, workspaceName: '<script>', inviterEmail: 'a&b@x.com' },
      { fromAddress: 'X <x@x.com>' },
    )
    expect(msg.html).toContain('&lt;script&gt;')
    expect(msg.html).toContain('a&amp;b@x.com')
    expect(msg.html).not.toContain('<script>')
  })
})
