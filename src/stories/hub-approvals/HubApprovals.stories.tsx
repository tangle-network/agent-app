/**
 * Hub approvals — the dock above the composer, the Approvals list beside the
 * conversation, the transcript row and the receipts that replace the resume
 * message. One story per integration renderer and per run phase.
 */
import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'

import type { HubApprovalItem } from '../../hub-approvals'
import { HubActionPreviewView, HubApprovalDock, HubApprovalReceipts, HubApprovalRow, HubApprovalsList, type HubApprovalDecision } from '../../hub-approvals-react'
import { ChatComposer, ReviewInbox, type ReviewInboxItem } from '../../web-react'

const later = new Date(Date.now() + 22 * 60 * 60 * 1000).toISOString()
const earlier = new Date(Date.now() - 4 * 60 * 1000).toISOString()

export const PULL_REQUEST: HubApprovalItem = {
  id: 'm1:pr', actionPath: 'github.pulls.propose', providerId: 'github', account: 'drewstone', phase: 'waiting',
  requestedAt: earlier, expiresAt: later,
  input: {
    owner: 'tangle-network', repo: 'tangle-website', base: 'main', branch: 'gtm-agent/hero-wrap',
    title: 'Keep the hero headline on two lines at 390 px',
    body: 'The hero headline wraps to four lines on a 390 px phone, pushing the primary call to action below the fold. This shortens the headline and lets it balance.',
    files: [
      { path: 'src/routes/_index.tsx', content: '…' },
      { path: 'src/styles/hero.css', content: '…' },
    ],
  },
  files: [
    { path: 'src/routes/_index.tsx', change: 'modified', additions: 6, deletions: 4 },
    { path: 'src/styles/hero.css', change: 'modified', additions: 3, deletions: 1 },
  ],
}

const EMAIL: HubApprovalItem = {
  id: 'm1:email', actionPath: 'gmail.send', providerId: 'gmail', account: 'drew@tangle.tools', phase: 'waiting',
  requestedAt: earlier, expiresAt: later,
  input: {
    to: ['ada@northwind.dev'], cc: ['ops@tangle.tools'], subject: 'Sandbox pilot: two dates for a setup call',
    body: 'Hi Ada,\n\nThanks for the questions about isolation. Each agent runs in its own sandbox with its own filesystem and network policy.\n\nWould Tuesday 10:00 or Wednesday 15:00 work for a 30 minute setup call?\n\nDrew',
  },
}

const X_POST: HubApprovalItem = {
  id: 'm1:x', actionPath: 'twitter.tweets.create', providerId: 'twitter', account: 'tangle_tools', phase: 'waiting',
  requestedAt: earlier, expiresAt: later,
  input: { text: 'Agents that open real pull requests now ask once per change, not once per git object. One approval, the full diff, then the PR link.' },
}

const LINKEDIN: HubApprovalItem = {
  id: 'm1:li', actionPath: 'linkedin.posts.create', providerId: 'linkedin', account: 'Drew Stone', phase: 'waiting',
  requestedAt: earlier, expiresAt: later,
  input: { author: 'urn:li:person:abc', commentary: 'We rebuilt how agents ask for permission.\n\nEvery action now shows exactly what it will do, where, and as which account, before anything runs.' },
}

const STRIPE: HubApprovalItem = {
  id: 'm1:stripe', actionPath: 'stripe.payment-intents.create', providerId: 'stripe', account: 'Tangle Network', phase: 'waiting',
  requestedAt: earlier, expiresAt: later,
  input: { amount: 49000, currency: 'usd', customerId: 'cus_Q8x2LmVt0', metadata: { plan: 'team' } },
}

const SPEECH: HubApprovalItem = {
  id: 'm1:speech', actionPath: 'phony.synthesize_speech', providerId: 'phony', account: 'ph0ny', phase: 'waiting',
  requestedAt: earlier, expiresAt: later,
  input: { text: 'Hi, this is Quinn from Tangle. I am calling to confirm your sandbox pilot starts Monday.', voiceId: 'quinn' },
}

const EVENT: HubApprovalItem = {
  id: 'm1:event', actionPath: 'google-calendar.create_event', providerId: 'google-calendar', account: 'drew@tangle.tools', phase: 'waiting',
  requestedAt: earlier, expiresAt: later,
  input: { summary: 'Sandbox pilot setup', start: '2026-10-14T17:00:00Z', end: '2026-10-14T17:30:00Z', location: 'Google Meet', attendees: ['ada@northwind.dev', 'drew@tangle.tools'] },
}

const GENERIC: HubApprovalItem = {
  id: 'm1:notion', actionPath: 'notion.pages.create', providerId: 'notion', account: 'Tangle', phase: 'waiting',
  requestedAt: earlier, expiresAt: later,
  input: { parentId: 'launch-notes', title: 'Pilot follow-ups', icon: 'memo' },
}

const PR_DONE: HubApprovalItem = {
  ...PULL_REQUEST, id: 'm1:pr-done', phase: 'done',
  result: {
    pullRequest: { number: 214, url: 'https://github.com/tangle-network/tangle-website/pull/214', title: 'Keep the hero headline on two lines at 390 px', state: 'open', draft: true },
    repository: 'tangle-network/tangle-website', base: 'main', branch: 'gtm-agent/hero-wrap',
    commit: { sha: '60568543335bbaf23bce528e7a6092fae10d1974', url: 'https://github.com/tangle-network/tangle-website/commit/6056854' },
    files: [
      { path: 'src/routes/_index.tsx', status: 'modified', additions: 6, deletions: 4 },
      { path: 'src/styles/hero.css', status: 'modified', additions: 3, deletions: 1 },
    ],
  },
}

const UNKNOWN: HubApprovalItem = {
  ...EMAIL, id: 'm1:unknown', phase: 'unknown',
  error: 'The connection ended before the provider confirmed the result.',
}

const SPEECH_DONE: HubApprovalItem = {
  ...SPEECH, id: 'm1:speech-done', phase: 'done',
  result: { audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg', durationSeconds: 5.6, format: 'mp3' },
}

const meta: Meta = {
  title: 'Chat/Hub approvals',
  parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

function Conversation({ items: initial, permissions = true }: { items: HubApprovalItem[]; permissions?: boolean }) {
  const [items, setItems] = useState(initial)
  async function onDecide(item: HubApprovalItem, decision: HubApprovalDecision) {
    if (decision.kind === 'deny') {
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, phase: 'denied' } : entry))
      return
    }
    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, phase: 'running' } : entry))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    setItems((current) => current.map((entry) => entry.id === item.id
      ? (item.id === PULL_REQUEST.id ? { ...PR_DONE, id: item.id } : { ...entry, phase: 'done', result: { id: 'ok_1' } })
      : entry))
  }
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="mx-auto w-full max-w-[820px] flex-1 space-y-4 px-5 pt-6">
        <div className="ml-auto w-fit max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-base text-foreground">Fix the hero wrap on the site and open a PR.</div>
        <p className="text-base leading-7 text-foreground">I found the headline in <code>src/routes/_index.tsx</code> and prepared the change. It is waiting for your approval.</p>
        {items.map((item) => <HubApprovalRow key={item.id} item={item} onReview={() => undefined} />)}
      </div>
      <div className="sticky bottom-0 border-t border-border bg-[var(--md3-surface-container-low,hsl(var(--card)))] px-4 pb-4 pt-3">
        <div className="mx-auto max-w-[820px] space-y-3">
          <HubApprovalDock
            items={items}
            onDecide={onDecide}
            onOpen={() => undefined}
            permissions={permissions
              ? (item) => item.providerId === 'gmail' || item.providerId === 'twitter' || item.providerId === 'linkedin' || item.providerId === 'stripe'
                  ? { never: 'Sends, posts and payments always ask.' }
                  : { scopes: [{ id: 'narrow', label: 'Only in this repository' }, { id: 'action', label: 'Any call of this action' }] }
              : undefined}
          />
          <ChatComposer value="" onValueChange={() => undefined} onSend={() => undefined} placeholder="Message the agent..." sendVariant="icon" />
        </div>
      </div>
    </div>
  )
}

export const PullRequestDock: Story = { render: () => <Conversation items={[PULL_REQUEST]} /> }
export const EmailDock: Story = { render: () => <Conversation items={[EMAIL]} /> }
export const XPostDock: Story = { render: () => <Conversation items={[X_POST]} /> }
export const LinkedInDock: Story = { render: () => <Conversation items={[LINKEDIN]} /> }
export const StripeDock: Story = { render: () => <Conversation items={[STRIPE]} /> }
export const VoiceMemoDock: Story = { render: () => <Conversation items={[SPEECH]} /> }
export const CalendarDock: Story = { render: () => <Conversation items={[EVENT]} /> }
export const AnyProviderDock: Story = { render: () => <Conversation items={[GENERIC]} /> }
export const SeveralWaiting: Story = { render: () => <Conversation items={[PULL_REQUEST, EMAIL, SPEECH]} /> }
export const Running: Story = { render: () => <Conversation items={[{ ...PULL_REQUEST, phase: 'running' }]} /> }
export const MayHaveRun: Story = {
  render: () => (
    <div className="mx-auto max-w-[820px] space-y-4 overflow-hidden bg-background px-5 py-6">
      <HubApprovalRow item={UNKNOWN} actions={<button>Request again</button>} />
      <HubApprovalDock items={[UNKNOWN]} onDecide={async () => undefined} />
      <HubApprovalReceipts items={[UNKNOWN]} />
    </div>
  ),
}
export const Failed: Story = {
  render: () => <Conversation items={[{ ...PULL_REQUEST, phase: 'failed', error: 'Branch gtm-agent/hero-wrap already exists in tangle-network/tangle-website; name a new branch.' }]} />,
}

export const ApprovalsList: Story = {
  render: () => (
    <div className="h-screen w-[420px] max-w-full border-r border-border bg-[var(--md3-surface-container-low,hsl(var(--card)))]">
      <HubApprovalsList items={[PR_DONE, SPEECH_DONE, UNKNOWN, { ...EMAIL, phase: 'denied' }, { ...STRIPE, phase: 'failed', error: 'Card declined' }, { ...X_POST, phase: 'running' }, PULL_REQUEST, EVENT]} selectedId={PULL_REQUEST.id} />
    </div>
  ),
}

export const Receipts: Story = {
  render: () => (
    <div className="mx-auto max-w-[820px] space-y-4 bg-background px-5 py-6">
      <HubApprovalReceipts items={[PR_DONE, SPEECH_DONE, UNKNOWN, { ...EMAIL, phase: 'denied' }]} message={'I decided the Hub actions you requested:\n- github.pulls.propose: I approved it, and it ran. Hub result: {…}'} at={new Date().toISOString()} />
    </div>
  ),
}

/** Teaching is independent of approving this exact action live. */
export const DryRunEmailFeedback: Story = {
  render: function PreviewFeedbackStory() {
    const [item, setItem] = useState<HubApprovalItem>({ ...EMAIL, executionMode: 'dry-run', input: {
      from: 'Taylor <taylor@example.invalid>', fromName: 'Taylor', to: ['Alex <alex@example.invalid>'],
      subject: 'A sandbox for your next prototype', previewText: 'A working environment without a setup afternoon.',
      body: '<p>Hi Alex,</p><p>Your prototype should start with code. Here is the <a href="https://example.invalid/sandbox">walkthrough</a>.</p><p>Taylor<br>Example team</p>', html: true,
    } })
    return <div className="mx-auto max-w-3xl p-4"><HubApprovalRow item={item} expanded onFeedback={async (_, feedback) => {
      setItem((current) => ({ ...current, feedback: { ...feedback, savedAt: new Date().toISOString() } }))
    }} /></div>
  },
}

/** Local raster fixtures keep feed layout review independent of provider requests. */
function mediaFixtures() {
  return ['#243e82', '#7a421d', '#314d3f'].map((color, index) => {
    const canvas = document.createElement('canvas')
    canvas.width = 360; canvas.height = 640
    const drawing = canvas.getContext('2d')!
    drawing.fillStyle = color; drawing.fillRect(0, 0, 360, 640)
    drawing.fillStyle = '#ffffff'; drawing.font = 'bold 32px sans-serif'; drawing.fillText('Sandbox', 28, 220)
    drawing.font = '20px sans-serif'; drawing.fillText(`Local slide ${index + 1}`, 28, 258)
    return { kind: 'image' as const, src: canvas.toDataURL('image/png'), alt: `Sandbox local slide ${index + 1}`, width: 360, height: 640 }
  })
}

function MediaFeedbackStory({ channel, placement, sponsored = false }: {
  channel: 'x' | 'instagram' | 'facebook' | 'linkedin'; placement: 'feed' | 'vertical' | 'carousel'; sponsored?: boolean
}) {
  const [item, setItem] = useState<HubApprovalItem>(() => ({
    id: 'story-media', actionPath: 'work-product', providerId: channel, phase: 'waiting', executionMode: 'dry-run',
    input: { text: 'Build the prototype before the setup afternoon.' },
    preview: { kind: 'post', channel, placement, sponsored, displayName: 'Example studio', handle: '@example-studio',
      text: 'Build the prototype before the setup afternoon.', media: mediaFixtures(), ...(sponsored ? { callToAction: 'Learn more' } : {}) },
  }))
  return <div className="mx-auto max-w-xl p-4"><HubApprovalRow item={item} expanded onFeedback={async (_, feedback) => {
    setItem(current => ({ ...current, feedback: { ...feedback, savedAt: new Date().toISOString() } }))
  }} /></div>
}
export const XMediaGridFeedback: Story = { render: () => <MediaFeedbackStory channel="x" placement="feed" /> }
export const InstagramCarouselFeedback: Story = { render: () => <MediaFeedbackStory channel="instagram" placement="carousel" /> }
export const VerticalSafeZonesFeedback: Story = { render: () => <MediaFeedbackStory channel="instagram" placement="vertical" /> }
export const MetaFeedAdFeedback: Story = { render: () => <MediaFeedbackStory channel="facebook" placement="feed" sponsored /> }
export const LinkedInSponsoredFeedback: Story = { render: () => <MediaFeedbackStory channel="linkedin" placement="feed" sponsored /> }

function InboxStory({ state = 'mixed' }: { state?: 'mixed' | 'readonly' | 'error' | 'empty' | 'compare' }) {
  const [items, setItems] = useState<ReviewInboxItem[]>(() => state === 'empty' ? [] : state === 'compare' ? Array.from({ length: 5 }, (_, index) => ({
    id: `cell-${index}`, revision: 1, title: 'Hidden column title', kind: 'Hidden source', createdAt: index,
    canReview: true, compare: { rowId: 'launch-brief', seed: 'retained-review-order' },
    input: { content: ['Start with the prototype.', 'Less setup. More building.', 'A smaller first step.', 'Make room for the work.', 'One clear next step.'][index] },
    allowedVerdicts: ['approve', 'reject'] as const,
  })) : [
    { id: 'brief', revision: 1, title: 'Sandbox launch brief', kind: 'work product', createdAt: 1000,
      canReview: state !== 'readonly', input: { content: 'Explain the setup problem with a concrete example.' } },
    { id: 'email', revision: 1, title: 'Email for Alex', kind: 'dry-run email', createdAt: 2000,
      canReview: state !== 'readonly', approveLabel: 'Approve preview',
      input: { from: 'Taylor <taylor@example.invalid>', to: ['alex@example.invalid'], subject: 'A smaller setup', body: 'Hi Alex, would a smaller sandbox setup help?', html: false },
      preview: { kind: 'email', from: 'Taylor <taylor@example.invalid>', to: ['alex@example.invalid'], cc: [], bcc: [],
        subject: 'A smaller setup', body: 'Hi Alex, would a smaller sandbox setup help?', html: false, reply: false } },
    { id: 'asset', revision: 1, title: 'Campaign carousel', kind: 'asset', createdAt: 3000,
      canReview: state !== 'readonly', input: { caption: 'Start with the prototype.' },
      preview: { kind: 'post', channel: 'instagram', placement: 'carousel', text: 'Start with the prototype.', media: mediaFixtures() } },
  ])
  return <div className="min-h-screen bg-background p-4"><ReviewInbox items={items} error={state === 'error' ? 'The review service is unavailable. Your drafts are kept.' : undefined}
    renderCompareBrief={() => <p>Launch brief: make the setup problem concrete. Judge each draft independently.</p>}
    onVerdict={async item => { if (state === 'error') throw new Error('Review could not save. Your edits are kept.'); setItems(current => current.filter(row => row.id !== item.id)) }}
    onFeedback={async (item, feedback) => { if (state === 'error') throw new Error('Feedback could not save. Your edits are kept.'); setItems(current => current.map(row => row.id === item.id ? { ...row, feedback } : row)) }}
    renderItem={item => item.preview ? <HubActionPreviewView preview={item.preview} /> : <article className="rounded-lg border border-border bg-card p-5"><p>{(item.input as { content: string }).content}</p></article>} /></div>
}
export const MixedReviewInbox: Story = { render: () => <InboxStory /> }
export const ReadOnlyReviewInbox: Story = { render: () => <InboxStory state="readonly" /> }
export const ReviewInboxSaveError: Story = { render: () => <InboxStory state="error" /> }
export const ReviewInboxCaughtUp: Story = { render: () => <InboxStory state="empty" /> }


/** The same inbox and feedback forms; host content never names the source column. */
export const BlindCompareReviewInbox: Story = { render: () => <InboxStory state="compare" /> }
