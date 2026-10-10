import { describe, expect, it } from 'vitest'

import {
  formatMinorAmount,
  hubActionReceipt,
  hubApprovalResumePart,
  hubProviderName,
  pastTense,
  presentHubAction,
  summarizeHubResult,
  unwrapHubResult,
  type HubApprovalItem,
} from './index'

function item(actionPath: string, input: unknown, extra: Partial<HubApprovalItem> = {}): HubApprovalItem {
  return { id: `id:${actionPath}`, actionPath, providerId: actionPath.split('.')[0] ?? '', input, phase: 'waiting', ...extra }
}

const PROPOSE = {
  owner: 'acme', repo: 'site', base: 'main', branch: 'gtm-agent/hero',
  title: 'Fix the hero headline wrap', body: 'It wrapped to four lines at 390 px.',
  files: [{ path: 'src/routes/_index.tsx', content: 'x' }, { path: 'docs/old.md', delete: true }],
}

describe('presentHubAction', () => {
  it('names a proposed pull request by its title and repository, with branch, base and files', () => {
    const shown = presentHubAction(item('github.pulls.propose', PROPOSE))
    expect(shown.title).toBe('Open PR: Fix the hero headline wrap on acme/site')
    expect(shown.provider).toEqual({ id: 'github', name: 'GitHub' })
    expect(shown.target).toBe('acme/site')
    expect(shown.preview).toMatchObject({
      kind: 'pull-request', head: 'gtm-agent/hero', base: 'main', draft: true,
      files: [{ path: 'src/routes/_index.tsx', change: 'modified' }, { path: 'docs/old.md', change: 'deleted' }],
    })
  })

  it('takes counted files from the host by path, keeping the declared order', () => {
    const shown = presentHubAction(item('github.pulls.propose', PROPOSE, {
      files: [{ path: 'docs/old.md', change: 'deleted', additions: 0, deletions: 12 }],
    }))
    expect(shown.preview.kind === 'pull-request' && shown.preview.files).toEqual([
      { path: 'src/routes/_index.tsx', change: 'modified' },
      { path: 'docs/old.md', change: 'deleted', additions: 0, deletions: 12 },
    ])
  })

  it('names the change a bundled step serves instead of the step', () => {
    const shown = presentHubAction(item('github.git.createTree', { owner: 'acme', repo: 'site', tree: [{ path: 'a.md' }] }, {
      bundle: { title: 'Open PR: Fix the hero on acme/site' },
    }))
    expect(shown.title).toBe('Open PR: Fix the hero on acme/site')
    expect(shown.preview).toMatchObject({ kind: 'files', files: [{ path: 'a.md' }] })
  })

  it('reads an email send as recipients, subject and body', () => {
    const shown = presentHubAction(item('gmail.send', { to: ['ada@acme.com', 'bo@acme.com'], cc: ['cy@acme.com'], subject: 'Pilot', body: 'Hello' }))
    expect(shown.title).toBe('Send email to ada@acme.com and 1 more')
    expect(shown.preview).toEqual({ kind: 'email', to: ['ada@acme.com', 'bo@acme.com'], cc: ['cy@acme.com'], bcc: [], subject: 'Pilot', body: 'Hello', html: false, reply: false })
    expect(presentHubAction(item('outlook-mail.create_draft', { to: 'ada@acme.com', subject: 'x', body: 'y' })).title).toBe('Save draft to ada@acme.com')
  })

  it('reads posts in their channel', () => {
    expect(presentHubAction(item('twitter.tweets.create', { text: 'Shipping today' }))).toMatchObject({
      title: 'Post on X: “Shipping today”', provider: { name: 'X' }, preview: { kind: 'post', channel: 'x', text: 'Shipping today' },
    })
    expect(presentHubAction(item('linkedin.posts.create', { author: 'urn:li:person:1', commentary: 'We launched' })).preview)
      .toMatchObject({ kind: 'post', channel: 'linkedin', text: 'We launched' })
  })

  it('reads a Stripe amount in its currency and names the customer', () => {
    const shown = presentHubAction(item('stripe.payment-intents.create', { amount: 4900, currency: 'usd', customerId: 'cus_123' }))
    expect(shown.title).toBe('Create payment of $49.00 for cus_123')
    expect(shown.preview).toMatchObject({ kind: 'payment', amount: 4900, customer: 'cus_123' })
  })

  it('reads ph0ny speech and calls and calendar events', () => {
    expect(presentHubAction(item('phony.synthesize_speech', { text: 'one two three four five six seven eight nine ten', voiceId: 'quinn' })).title)
      .toBe('Create voice memo (Quinn, 4 s)')
    expect(presentHubAction(item('phony.start_outbound_call', { toNumber: '+14155550134', mission: { goal: 'Confirm the demo' } })))
      .toMatchObject({ title: 'Call +14155550134', preview: { kind: 'call', purpose: 'Confirm the demo' } })
    expect(presentHubAction(item('google-calendar.create_event', { summary: 'Demo', start: '2026-10-14T15:00:00Z', end: '2026-10-14T15:30:00Z', attendees: ['ada@acme.com'] })))
      .toMatchObject({ title: 'Book “Demo”', provider: { name: 'Google Calendar' }, preview: { kind: 'event', attendees: ['ada@acme.com'] } })
  })

  it('falls back to the action name and scalar fields for any Hub provider', () => {
    const shown = presentHubAction(item('notion.pages.create', { parentId: 'p1', title: 'Launch notes', archived: false, nested: { a: 1 } }))
    expect(shown.title).toBe('Create page “Launch notes”')
    expect(shown.provider.name).toBe('Notion')
    expect(shown.preview).toEqual({ kind: 'fields', fields: [
      { label: 'Parent id', value: 'p1' }, { label: 'Title', value: 'Launch notes' }, { label: 'Archived', value: 'false' },
    ] })
    expect(presentHubAction(item('acme-crm.contacts.add_tag', {})).title).toBe('Add contact tag')
  })
})

describe('hubActionReceipt', () => {
  it('reports an opened pull request with its link, branch, commit and files', () => {
    const receipt = hubActionReceipt(item('github.pulls.propose', PROPOSE, {
      phase: 'done',
      result: { result: {
        pullRequest: { number: 123, url: 'https://github.com/acme/site/pull/123', title: 'Fix', state: 'open', draft: true },
        repository: 'acme/site', base: 'main', branch: 'gtm-agent/hero',
        commit: { sha: '60568543335bbaf23bce528e7a6092fae10d1974', url: 'https://github.com/acme/site/commit/6056854' },
        files: [{ path: 'src/routes/_index.tsx', status: 'modified', additions: 1, deletions: 3 }, { path: 'docs/old.md', status: 'removed', additions: 0, deletions: 9 }],
      } },
    }))
    expect(receipt).toMatchObject({
      title: 'Opened PR #123',
      href: 'https://github.com/acme/site/pull/123',
      status: 'done',
      files: [
        { path: 'src/routes/_index.tsx', change: 'modified', additions: 1, deletions: 3 },
        { path: 'docs/old.md', change: 'deleted', additions: 0, deletions: 9 },
      ],
    })
    expect(receipt.fields).toEqual([
      { label: 'Pull request', value: '#123', href: 'https://github.com/acme/site/pull/123' },
      { label: 'Branch', value: 'gtm-agent/hero → main', mono: true },
      { label: 'Commit', value: '6056854', href: 'https://github.com/acme/site/commit/6056854', mono: true },
      { label: 'Repository', value: 'acme/site', href: 'https://github.com/acme/site' },
    ])
  })

  it('reads results stored as Hub’s JSON text', () => {
    const receipt = hubActionReceipt(item('github.git.createCommit', { owner: 'acme', repo: 'site', message: 'fix' }, {
      phase: 'done', result: '{"result":{"sha":"ab49d842fdea494a587aaf0232e3234d8555f7ce","url":"https://api.github.com/x"}}',
    }))
    expect(receipt.title).toBe('Created commit ab49d84')
    expect(receipt.href).toBeUndefined()
  })

  it('plays a voice memo and links posts and events', () => {
    expect(hubActionReceipt(item('phony.synthesize_speech', { text: 'hi' }, {
      phase: 'done', result: { result: { audioUrl: 'https://audio.example/a.mp3', durationSeconds: 5.62 } },
    }))).toMatchObject({ title: 'Created voice memo', media: { kind: 'audio', src: 'https://audio.example/a.mp3', seconds: 5.62 }, fields: [{ label: 'Length', value: '5.6 s' }] })
    expect(hubActionReceipt(item('twitter.tweets.create', { text: 'x' }, { phase: 'done', result: { id: '1840000000000000001' } })))
      .toMatchObject({ title: 'Posted on X', href: 'https://x.com/i/web/status/1840000000000000001' })
    expect(hubActionReceipt(item('google-calendar.create_event', { summary: 'Demo', start: '2026-10-14T15:00:00Z' }, {
      phase: 'done', result: { htmlLink: 'https://calendar.google.com/event?eid=1' },
    }))).toMatchObject({ title: 'Booked “Demo”', href: 'https://calendar.google.com/event?eid=1' })
  })

  it('reports sends, payments and failures in plain words', () => {
    expect(hubActionReceipt(item('gmail.send', { to: 'ada@acme.com', subject: 'Pilot', body: 'x' }, { phase: 'done', result: { id: 'm1' } })))
      .toMatchObject({ title: 'Sent email to ada@acme.com', fields: [{ label: 'Subject', value: 'Pilot' }] })
    expect(hubActionReceipt(item('stripe.payment-links.create', { lineItems: [] }, { phase: 'done', result: { url: 'https://buy.stripe.com/x', status: 'active' } })))
      .toMatchObject({ title: 'Created payment link', href: 'https://buy.stripe.com/x' })
    expect(hubActionReceipt(item('gmail.send', { to: 'ada@acme.com' }, { phase: 'failed', error: 'Recipient rejected' })))
      .toEqual({ provider: { id: 'gmail', name: 'Gmail' }, status: 'failed', title: 'Could not send email', fields: [], error: 'Recipient rejected' })
    expect(hubActionReceipt(item('gmail.send', { to: 'ada@acme.com' }, { phase: 'denied' })).title).toBe('Denied: Send email to ada@acme.com')
  })
})

describe('results and vocabulary', () => {
  it('reads a stored JSON array whole, and JSON after a text prefix', () => {
    expect(unwrapHubResult('[{"id":"1"}]')).toEqual([{ id: '1' }])
    expect(unwrapHubResult('Hub result: {"result":{"sha":"x"}}')).toEqual({ sha: 'x' })
    expect(unwrapHubResult('not json')).toBe('not json')
  })

  it('names a calendar update as an update', () => {
    const update = item('google-calendar.update_event', { summary: 'Demo', start: '2026-10-14T15:00:00Z' })
    expect(presentHubAction(update).title).toBe('Update “Demo”')
    expect(hubActionReceipt({ ...update, phase: 'done', result: {} }).title).toBe('Updated “Demo”')
  })

  it('unwraps only thin envelopes', () => {
    expect(unwrapHubResult({ result: { data: { sha: 'x' } } })).toEqual({ sha: 'x' })
    expect(unwrapHubResult({ id: 1, data: { a: 1 }, name: 'kept', status: 'ok' })).toEqual({ id: 1, data: { a: 1 }, name: 'kept', status: 'ok' })
  })

  it('bounds a result before a host stores it', () => {
    const summary = summarizeHubResult({ result: { long: 'x'.repeat(5000), list: Array.from({ length: 80 }, (_, i) => i), deep: { a: { b: { c: { d: { e: 1 } } } } } } }) as Record<string, unknown>
    expect((summary.long as string).length).toBe(600)
    expect((summary.list as number[]).length).toBe(50)
    expect(summary.deep).toEqual({ a: { b: {} } })
  })

  it('formats minor units, provider names and past tense', () => {
    expect(formatMinorAmount(4900, 'usd')).toBe('$49.00')
    expect(formatMinorAmount(5000, 'jpy')).toBe('¥5,000')
    expect(hubProviderName('outlook-mail')).toBe('Outlook')
    expect(hubProviderName('acme-crm')).toBe('Acme Crm')
    expect(pastTense('Send')).toBe('Sent')
    expect(pastTense('archive')).toBe('archived')
    expect(pastTense('fetch')).toBe('fetched')
  })

  it('finds the resume marker among a message’s parts', () => {
    expect(hubApprovalResumePart([{ type: 'text', text: 'x' }, { type: 'hub-approval-resume', messageId: 'm1' }])).toEqual({ type: 'hub-approval-resume', messageId: 'm1' })
    expect(hubApprovalResumePart([{ type: 'hub-approval-resume' }])).toBeNull()
    expect(hubApprovalResumePart(null)).toBeNull()
  })
})
