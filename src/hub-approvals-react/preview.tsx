import { ArrowRight, CalendarDays, GitBranch, GitCommitHorizontal, GitPullRequest, MapPin, Phone, Users } from 'lucide-react'

import { formatMinorAmount, formatWhen, type HubActionPreview } from '../hub-approvals'
import { Chip, HubDiffSummary, HubFieldList } from './parts'

/** Readable text of an HTML email body, for a preview that never renders markup. */
function plainText(body: string, html: boolean): string {
  if (!html) return body
  return body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function initial(name: string | null | undefined): string {
  return (name?.trim().replace(/^@/, '').charAt(0) || '?').toUpperCase()
}

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-border bg-background ${className}`}>{children}</div>
}

function PullRequestPreview({ preview }: { preview: Extract<HubActionPreview, { kind: 'pull-request' }> }) {
  return (
    <div className="space-y-3">
      <Panel className="px-3 py-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <GitPullRequest aria-hidden className="size-4 shrink-0" />
          {preview.repository && <span className="font-medium text-foreground">{preview.repository}</span>}
          {preview.head && preview.base && (
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Chip mono>{preview.head}</Chip>
              <ArrowRight aria-label="into" className="size-4 shrink-0" />
              <Chip mono>{preview.base}</Chip>
            </span>
          )}
          {preview.draft && <span className="rounded-md border border-border px-1.5 py-0.5 text-sm text-muted-foreground">Draft</span>}
        </div>
        {preview.title && <p className="mt-2 text-base font-semibold leading-6 text-foreground">{preview.title}</p>}
        {preview.body && <p className="mt-1 line-clamp-4 whitespace-pre-line text-sm leading-6 text-muted-foreground">{preview.body}</p>}
      </Panel>
      {preview.files.length > 0 && <HubDiffSummary files={preview.files} />}
    </div>
  )
}

function EmailPreview({ preview, account }: { preview: Extract<HubActionPreview, { kind: 'email' }>; account?: string | null }) {
  const rows: Array<[string, string]> = [
    ...(account ? [['From', account] as [string, string]] : []),
    ...(preview.to.length ? [['To', preview.to.join(', ')] as [string, string]] : []),
    ...(preview.cc.length ? [['Cc', preview.cc.join(', ')] as [string, string]] : []),
    ...(preview.bcc.length ? [['Bcc', preview.bcc.join(', ')] as [string, string]] : []),
  ]
  const body = preview.body ? plainText(preview.body, preview.html) : ''
  return (
    <Panel className="overflow-hidden">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border px-3 py-2.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words text-foreground">{value}</dd>
          </div>
        ))}
        {preview.subject && (
          <div className="contents">
            <dt className="text-muted-foreground">Subject</dt>
            <dd className="break-words font-semibold text-foreground">{preview.subject}</dd>
          </div>
        )}
        {preview.reply && !preview.subject && (
          <div className="contents">
            <dt className="text-muted-foreground">Reply</dt>
            <dd className="text-foreground">In the existing conversation</dd>
          </div>
        )}
      </dl>
      {body && <div className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words px-3 py-3 text-sm leading-6 text-foreground">{body}</div>}
    </Panel>
  )
}

function PostPreview({ preview, account }: { preview: Extract<HubActionPreview, { kind: 'post' }>; account?: string | null }) {
  if (preview.channel === 'slack') {
    return (
      <Panel className="px-3 py-3">
        <p className="text-sm font-semibold text-foreground">{preview.where ?? 'Slack'}</p>
        <div className="mt-2 flex gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold text-foreground">{initial(account)}</span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{account ?? 'Your account'}</p>
            <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{preview.text}</p>
          </div>
        </div>
      </Panel>
    )
  }
  const x = preview.channel === 'x'
  const length = [...preview.text].length
  return (
    <Panel className="px-4 py-3">
      <div className="flex gap-3">
        <span className={`flex size-10 shrink-0 items-center justify-center rounded-full text-base font-semibold ${x ? 'bg-foreground text-background' : 'bg-[#0a66c2] text-white'}`}>
          {initial(account)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
            <span className="font-semibold text-foreground">{account ?? 'Your account'}</span>
            <span className="text-muted-foreground">{x ? '· now' : '· Post · Anyone'}</span>
          </p>
          <p className={`mt-1 whitespace-pre-wrap break-words text-foreground ${x ? 'text-[15px] leading-6' : 'text-sm leading-6'}`}>{preview.text}</p>
          {preview.link && (
            <div className="mt-3 overflow-hidden rounded-lg border border-border">
              <div className="px-3 py-2">
                <p className="truncate text-sm text-muted-foreground">{preview.link.url.replace(/^https?:\/\//, '')}</p>
                {preview.link.title && <p className="truncate text-sm font-semibold text-foreground">{preview.link.title}</p>}
                {preview.link.description && <p className="line-clamp-2 text-sm text-muted-foreground">{preview.link.description}</p>}
              </div>
            </div>
          )}
        </div>
      </div>
      {x && (
        <p className={`mt-2 text-right text-sm tabular-nums ${length > 280 ? 'text-[var(--surface-danger-text)]' : 'text-muted-foreground'}`}>
          {length} / 280
        </p>
      )}
    </Panel>
  )
}

function PaymentPreview({ preview }: { preview: Extract<HubActionPreview, { kind: 'payment' }> }) {
  return (
    <Panel className="px-4 py-3">
      <p className="text-sm text-muted-foreground">{preview.label.charAt(0).toUpperCase() + preview.label.slice(1)}</p>
      {preview.amount !== undefined && (
        <p className="mt-0.5 text-2xl font-semibold tabular-nums text-foreground">{formatMinorAmount(preview.amount, preview.currency)}</p>
      )}
      <div className="mt-2 space-y-1 text-sm">
        {preview.customer && (
          <p className="text-muted-foreground">Customer <span className={`text-foreground ${preview.customer.startsWith('cus_') ? 'font-mono' : ''}`}>{preview.customer}</span></p>
        )}
        {preview.description && <p className="text-foreground">{preview.description}</p>}
      </div>
    </Panel>
  )
}

function SpeechPreview({ preview }: { preview: Extract<HubActionPreview, { kind: 'speech' }> }) {
  return (
    <Panel className="px-4 py-3">
      <blockquote className="border-l-2 border-[var(--accent-text)] pl-3 text-base leading-7 text-foreground">{preview.text}</blockquote>
      {(preview.voice || preview.seconds) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {preview.voice && <Chip>Voice: {preview.voice}</Chip>}
          {preview.seconds && <Chip>About {preview.seconds} s</Chip>}
        </div>
      )}
    </Panel>
  )
}

function CallPreview({ preview }: { preview: Extract<HubActionPreview, { kind: 'call' }> }) {
  return (
    <Panel className="flex gap-3 px-4 py-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted"><Phone aria-hidden className="size-5 text-foreground" /></span>
      <div className="min-w-0 space-y-1 text-sm">
        <p className="text-base font-semibold tabular-nums text-foreground">{preview.to ?? 'Unknown number'}</p>
        {preview.from && <p className="text-muted-foreground">From <span className="tabular-nums text-foreground">{preview.from}</span></p>}
        {preview.purpose && <p className="leading-6 text-foreground">{preview.purpose}</p>}
      </div>
    </Panel>
  )
}

function EventPreview({ preview }: { preview: Extract<HubActionPreview, { kind: 'event' }> }) {
  const start = preview.start ? new Date(preview.start) : null
  const valid = start && !Number.isNaN(start.getTime())
  return (
    <Panel className="flex gap-4 px-4 py-3">
      <div className="flex w-14 shrink-0 flex-col items-center overflow-hidden rounded-lg border border-border text-center">
        <span className="w-full bg-[var(--surface-danger-bg)] py-0.5 text-sm font-semibold uppercase text-[var(--surface-danger-text)]">
          {valid ? start!.toLocaleDateString(undefined, { month: 'short' }) : <CalendarDays aria-hidden className="mx-auto size-4" />}
        </span>
        <span className="py-1 text-xl font-semibold tabular-nums text-foreground">{valid ? start!.getDate() : '–'}</span>
      </div>
      <div className="min-w-0 space-y-1 text-sm">
        <p className="text-base font-semibold text-foreground">{preview.title ?? 'Untitled event'}</p>
        {preview.start && <p className="text-foreground">{formatWhen(preview.start, preview.end)}</p>}
        {preview.location && <p className="flex items-center gap-1.5 text-muted-foreground"><MapPin aria-hidden className="size-4 shrink-0" />{preview.location}</p>}
        {preview.attendees.length > 0 && (
          <p className="flex items-start gap-1.5 text-muted-foreground"><Users aria-hidden className="mt-0.5 size-4 shrink-0" /><span className="break-words">{preview.attendees.join(', ')}</span></p>
        )}
        {preview.description && <p className="line-clamp-3 leading-6 text-foreground">{preview.description}</p>}
      </div>
    </Panel>
  )
}

/**
 * What a held call will do, drawn the way its integration shows it: a pull
 * request with its branch and file changes, an email, a post in the channel's
 * style, a payment, a voice memo, a call or a calendar event. Any other action
 * lists its input fields.
 */
export function HubActionPreviewView({ preview, account }: { preview: HubActionPreview; account?: string | null }) {
  switch (preview.kind) {
    case 'pull-request':
      return <PullRequestPreview preview={preview} />
    case 'files':
      return preview.files.length > 0 ? <HubDiffSummary files={preview.files} /> : null
    case 'commit':
      return (
        <Panel className="px-3 py-3">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <GitCommitHorizontal aria-hidden className="size-4 shrink-0" />
            {preview.repository ?? 'Commit'}
          </p>
          {preview.message && <p className="mt-2 whitespace-pre-line text-sm leading-6 text-foreground">{preview.message}</p>}
          <HubFieldList fields={[
            ...(preview.tree ? [{ label: 'Tree', value: preview.tree.slice(0, 7), mono: true }] : []),
            ...preview.parents.map((parent) => ({ label: 'Parent', value: parent.slice(0, 7), mono: true })),
          ]} />
        </Panel>
      )
    case 'branch':
      return (
        <Panel className="flex flex-wrap items-center gap-2 px-3 py-3 text-sm">
          <GitBranch aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          {preview.branch && <Chip mono>{preview.branch}</Chip>}
          {preview.sha && <span className="text-muted-foreground">at <span className="font-mono text-foreground">{preview.sha.slice(0, 7)}</span></span>}
        </Panel>
      )
    case 'issue':
      return (
        <Panel className="px-3 py-3">
          {preview.verdict && <p className="text-sm font-medium capitalize text-foreground">{preview.verdict}</p>}
          {preview.title && <p className="text-base font-semibold leading-6 text-foreground">{preview.title}</p>}
          {preview.body && <p className="mt-1 line-clamp-6 whitespace-pre-line text-sm leading-6 text-foreground">{preview.body}</p>}
        </Panel>
      )
    case 'email':
      return <EmailPreview preview={preview} account={account} />
    case 'post':
      return <PostPreview preview={preview} account={account} />
    case 'payment':
      return <PaymentPreview preview={preview} />
    case 'speech':
      return <SpeechPreview preview={preview} />
    case 'call':
      return <CallPreview preview={preview} />
    case 'event':
      return <EventPreview preview={preview} />
    case 'fields':
      return preview.fields.length > 0 ? <Panel className="px-3 py-3"><HubFieldList fields={preview.fields} /></Panel> : null
  }
}
