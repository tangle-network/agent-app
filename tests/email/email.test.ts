import { palettes } from '@tangle-network/brand'
import { describe, expect, it } from 'vitest'
import {
  approvalEmail,
  digestEmail,
  emailPreviewHtml,
  emailSender,
  inviteEmail,
  lintEmailHtml,
  noticeEmail,
  type EmailMessage,
} from '../../src/email/index'
import { EMAIL_PALETTE } from '../../src/email/palette'

const product = { name: 'GTM Agent', url: 'https://gtm.tangle.tools' }
const footer = { workspaceName: 'Tangle Growth', reason: 'You own this workspace.', manageUrl: '/app/ws_1/settings' }

const samples: Record<string, EmailMessage> = {
  approval: approvalEmail(product, {
    actions: [{ summary: 'Create agent “Quinn”', detail: 'ph0ny · open until Oct 9, 3:40 PM UTC' }],
    conversation: 'Launch the Quinn voice agent',
    approveUrl: '/app/ws_1/chat/thr_1',
    reviewUrl: '/app/ws_1/review',
    footer,
  }),
  'approval-multiple': approvalEmail(product, {
    actions: [
      { summary: 'Create agent “Quinn”', detail: 'ph0ny' },
      { summary: 'Synthesize speech “Hello”', detail: 'ph0ny' },
    ],
    approveUrl: '/app/ws_1/chat/thr_1',
    reviewUrl: '/app/ws_1/review',
    footer,
  }),
  invite: inviteEmail(product, {
    workspaceName: 'Tangle Growth',
    inviter: 'drew@tangle.tools',
    role: 'editor',
    acceptUrl: '/invite/inv_1',
    expiresAt: new Date('2026-10-15T12:00:00Z'),
  }),
  digest: digestEmail(product, {
    workspaceName: 'Tangle Growth',
    date: new Date('2026-10-08T07:00:00Z'),
    items: [
      { title: 'Drafted 3 LinkedIn posts', detail: 'Waiting for your review', url: '/app/ws_1/publish' },
      { title: 'Quinn completed 4 calls' },
    ],
    openUrl: '/app/ws_1',
    footer: { ...footer, reason: 'You get a daily digest for this workspace.' },
  }),
  notice: noticeEmail(product, {
    subject: 'Reset your password',
    title: 'Reset your password',
    body: 'Someone asked to reset the password for ada@example.com.',
    action: { label: 'Reset password', url: 'https://gtm.tangle.tools/api/auth/reset-password/tok?callbackURL=%2Freset&x=1' },
    showLink: true,
    note: 'This link expires in 1 hour.',
    footer: { reason: 'You received this because a password reset was requested for this address.' },
  }),
}

describe('email templates', () => {
  it.each(Object.entries(samples))('%s renders the snapshotted HTML and text', async (name, message) => {
    await expect(message.html).toMatchFileSnapshot(`__snapshots__/${name}.html`)
    await expect(`Subject: ${message.subject}\nPreheader: ${message.preheader}\n\n${message.text}`)
      .toMatchFileSnapshot(`__snapshots__/${name}.txt`)
  })

  it.each(Object.entries(samples))('%s passes the Gmail and Outlook checks', (_name, message) => {
    expect(lintEmailHtml(message.html)).toEqual([])
  })

  it('names the action in the subject, mid-sentence, with the product last', () => {
    expect(samples.approval!.subject).toBe('Approve: create agent “Quinn” — GTM Agent')
    expect(samples['approval-multiple']!.subject).toBe('Approve: create agent “Quinn” and 1 more — GTM Agent')
    expect(approvalEmail(product, {
      actions: [{ summary: 'API key rotation' }], approveUrl: '/a', reviewUrl: '/r', footer,
    }).subject).toBe('Approve: API key rotation — GTM Agent')
    expect(samples.invite!.subject).toBe('Join Tangle Growth — GTM Agent')
    expect(samples.digest!.subject).toBe('Tangle Growth: 2 updates — GTM Agent')
  })

  it('links into the app with absolute URLs and carries the footer in both parts', () => {
    const { html, text } = samples.approval!
    expect(html).toContain('href="https://gtm.tangle.tools/app/ws_1/chat/thr_1"')
    expect(html).toContain('href="https://gtm.tangle.tools/app/ws_1/review"')
    expect(text).toContain('Approve: https://gtm.tangle.tools/app/ws_1/chat/thr_1')
    expect(text).toContain('Review: https://gtm.tangle.tools/app/ws_1/review')
    expect(text).toContain('Manage notifications: https://gtm.tangle.tools/app/ws_1/settings')
    for (const part of [html, text]) {
      expect(part).toContain('Tangle Growth · GTM Agent')
      expect(part).toContain('You own this workspace.')
    }
  })

  it('leads with the Tangle lockup and the product name, without doubling Tangle', () => {
    const { html, text } = samples.approval!
    expect(html).toMatch(/font-weight:700">Tangle<\/span><span[^>]*font-weight:500">&nbsp;GTM Agent<\/span>/)
    expect(text.split('\n')[0]).toBe('Tangle GTM Agent')
    const sandbox = noticeEmail({ name: 'Tangle Sandbox', url: 'https://sandbox.tangle.tools' }, {
      subject: 'Hello', title: 'Hello', body: 'Hi.', footer: { reason: 'You have an account.' },
    })
    expect(sandbox.html).toContain('&nbsp;Sandbox</span>')
    expect(sandbox.text.split('\n')[0]).toBe('Tangle Sandbox')
    expect(sandbox.subject).toBe('Hello — Tangle Sandbox')
  })

  it('prints a postal address only when the product passes one', () => {
    for (const message of Object.values(samples)) {
      expect(message.html).not.toContain('[redacted]')
      expect(message.text).not.toContain('Tangle Technologies')
    }
    const digest = digestEmail(product, {
      workspaceName: 'Tangle Growth', date: new Date('2026-10-08T07:00:00Z'), items: [], openUrl: '/app/ws_1',
      footer: { reason: 'You get a daily digest.', postalAddress: 'Example Co., 1 Main St, Springfield' },
    })
    expect(digest.html).toContain('Example Co., 1 Main St, Springfield')
    expect(digest.text).toContain('Example Co., 1 Main St, Springfield')
    expect(lintEmailHtml(digest.html)).toEqual([])
  })

  it('escapes product data in HTML and keeps it readable in text', () => {
    const message = inviteEmail(product, {
      workspaceName: '<script>alert(1)</script>',
      inviter: 'a&b@x.com',
      role: 'viewer',
      acceptUrl: '/invite/inv_1',
      expiresAt: new Date('2026-10-15T00:00:00Z'),
    })
    expect(message.html).not.toContain('<script>')
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(message.html).toContain('a&amp;b@x.com')
    expect(message.text).toContain('a&b@x.com invited you to <script>alert(1)</script> on GTM Agent as a viewer.')
  })

  it('refuses links that are not http(s) and approvals with nothing to approve', () => {
    expect(() => noticeEmail(product, {
      subject: 'x', title: 'x', body: 'x', action: { label: 'x', url: 'javascript:alert(1)' }, footer,
    })).toThrow(/http\(s\)/)
    expect(() => approvalEmail(product, { actions: [], approveUrl: '/a', reviewUrl: '/r', footer })).toThrow()
  })

  it('embeds the Tangle mark inline and previews it as a data URI', () => {
    const message = samples.approval!
    // Decorative: the Tangle wordmark beside it carries the name.
    expect(message.html).toContain('<img src="cid:tangle-mark" width="28" height="28" alt=""')
    expect(message.attachments).toEqual([
      expect.objectContaining({ contentId: 'tangle-mark', contentType: 'image/png', filename: 'tangle.png' }),
    ])
    expect(Buffer.from(message.attachments[0]!.content, 'base64').subarray(1, 4).toString()).toBe('PNG')
    const preview = emailPreviewHtml(message)
    expect(preview).not.toContain('cid:')
    expect(preview).toContain('src="data:image/png;base64,')
  })
})

describe('emailSender', () => {
  it('leads with the product and ties it to Tangle', () => {
    expect(emailSender('GTM Agent', 'noreply@tangle.tools')).toBe('GTM Agent · Tangle <noreply@tangle.tools>')
    expect(emailSender('Tangle Sandbox', 'noreply@tangle.tools')).toBe('Tangle Sandbox <noreply@tangle.tools>')
    expect(() => emailSender('GTM Agent', 'not-an-address')).toThrow()
  })
})

describe('lintEmailHtml', () => {
  it('reports each construct Gmail or Outlook breaks on', () => {
    const broken = [
      '<html><head><link rel="stylesheet" href="https://x/a.css"><style>.a { color: red; }</style></head><body>',
      '<table><tr><td><div style="display:flex;width:600px">x</div></td></tr></table>',
      '<p>unstyled</p><img src="http://x/logo.png"><a href="/relative" style="color:#000">x</a><svg></svg>',
      '</body></html>',
    ].join('')
    expect(new Set(lintEmailHtml(broken).map((issue) => issue.rule))).toEqual(new Set([
      'document', 'external-css', 'style-block', 'unsupported-element', 'unsupported-css',
      'layout-table', 'inline-style', 'image', 'link',
    ]))
  })

  it('reports a body Gmail would clip', () => {
    const html = samples.notice!.html.replace('</body>', `${'<!-- pad -->'.repeat(10_000)}</body>`)
    expect(lintEmailHtml(html).map((issue) => issue.rule)).toEqual(['size'])
  })
})

describe('email palette', () => {
  it('matches the Brand palette role for role', () => {
    for (const theme of ['light', 'dark'] as const) {
      const brand = palettes[theme] as Record<string, string>
      for (const [role, value] of Object.entries(EMAIL_PALETTE[theme])) {
        expect([theme, role, value]).toEqual([theme, role, brand[role]])
      }
    }
  })
})
