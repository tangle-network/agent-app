/**
 * Hub actions in an owner's words. Known integrations read as what they do —
 * `github.pulls.propose` is "Open PR: Fix the hero on acme/site", `gmail.send`
 * is "Send email to ada@acme.com" — and any other Hub action falls back to its
 * own name and its input's scalar fields.
 */

import { asRecord, readNumber, readText, resultLink, unwrapHubResult } from './result'
import type {
  HubActionField,
  HubActionFile,
  HubActionPresentation,
  HubActionPreview,
  HubActionReceipt,
  HubApprovalItem,
} from './types'

const PROVIDER_NAMES: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gmail: 'Gmail',
  google: 'Google',
  'google-calendar': 'Google Calendar',
  'microsoft-calendar': 'Outlook Calendar',
  'outlook-mail': 'Outlook',
  outlook: 'Outlook',
  twitter: 'X',
  x: 'X',
  linkedin: 'LinkedIn',
  stripe: 'Stripe',
  phony: 'ph0ny',
  slack: 'Slack',
  notion: 'Notion',
  hubspot: 'HubSpot',
  linear: 'Linear',
  inkbox: 'Inkbox',
  resend: 'Resend',
}

/** A provider's display name: `github` is GitHub, `outlook-mail` is Outlook. */
export function hubProviderName(id: string): string {
  if (PROVIDER_NAMES[id]) return PROVIDER_NAMES[id]
  const words = id.split(/[-_\s]+/).filter(Boolean)
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || id
}

/** `provider.action` split at the first dot. */
export function splitHubActionPath(actionPath: string): { provider: string; action: string } {
  const separator = actionPath.indexOf('.')
  return separator < 0 ? { provider: '', action: actionPath } : { provider: actionPath.slice(0, separator), action: actionPath.slice(separator + 1) }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function clipped(value: string, max = 80): string {
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1).trimEnd()}…` : single
}

function list(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean)
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [entry.trim()]
    const record = asRecord(entry)
    const address = text(record.email) ?? text(record.address) ?? text(asRecord(record.emailAddress).address)
    return address ? [address] : []
  })
}

function people(addresses: readonly string[]): string {
  if (addresses.length === 0) return ''
  if (addresses.length === 1) return addresses[0]!
  return `${addresses[0]} and ${addresses.length - 1} more`
}

function shortSha(sha: string | undefined): string | undefined {
  return sha && /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 7) : sha
}

// ---------- verbs ----------

const PAST: Record<string, string> = {
  add: 'added', approve: 'approved', archive: 'archived', assign: 'assigned', book: 'booked', cancel: 'canceled',
  capture: 'captured', charge: 'charged', clone: 'cloned', close: 'closed', comment: 'commented', create: 'created',
  deactivate: 'deactivated', delete: 'deleted', enroll: 'enrolled', export: 'exported', finalize: 'finalized',
  forward: 'forwarded', import: 'imported', ingest: 'ingested', invite: 'invited', like: 'liked', make: 'made',
  merge: 'merged', move: 'moved', open: 'opened', pay: 'paid', place: 'placed', post: 'posted', provision: 'provisioned',
  publish: 'published', put: 'put', react: 'reacted', refund: 'refunded', remove: 'removed', reply: 'replied',
  retweet: 'reposted', review: 'reviewed', run: 'ran', save: 'saved', schedule: 'scheduled', send: 'sent', set: 'set',
  share: 'shared', start: 'started', stop: 'stopped', submit: 'submitted', subscribe: 'subscribed',
  synthesize: 'synthesized', transfer: 'transferred', translate: 'translated', update: 'updated', upload: 'uploaded',
  upsert: 'saved', void: 'voided', watch: 'watched', write: 'wrote',
}

/** The past tense of an English verb this vocabulary uses. */
export function pastTense(verb: string): string {
  const lower = verb.toLowerCase()
  const past = PAST[lower] ?? (lower.endsWith('e') ? `${lower}d` : `${lower}ed`)
  return verb.charAt(0) === verb.charAt(0).toUpperCase() ? past.charAt(0).toUpperCase() + past.slice(1) : past
}

function words(action: string): string[] {
  return action
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[._\-\s]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean)
}

function singular(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.endsWith('sses') || word.endsWith('ss')) return word
  return word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word
}

/** A Hub action's own name as a sentence: `payment-intents.create` is "Create payment intent". */
function genericVerb(action: string): { verb: string; noun: string } {
  const parts = words(action)
  const index = parts.findIndex((word) => word in PAST)
  if (index < 0) return { verb: '', noun: parts.join(' ') }
  const noun = [...parts.slice(0, index), ...parts.slice(index + 1)].map(singular).join(' ')
  return { verb: parts[index]!, noun }
}

function sentence(verb: string, noun: string): string {
  const phrase = [verb, noun].filter(Boolean).join(' ')
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

// ---------- inputs ----------

function repository(input: Record<string, unknown>): string | undefined {
  const owner = text(input.owner)
  const repo = text(input.repo)
  if (owner && repo) return `${owner}/${repo}`
  return repo ?? text(input.repository)
}

function branchOf(ref: unknown): string | undefined {
  return text(ref)?.replace(/^refs\/heads\//, '')
}

/** The files a call writes, as its input declares them. */
export function hubActionFiles(actionPath: string, input: unknown): HubActionFile[] {
  const fields = asRecord(input)
  const { action } = splitHubActionPath(actionPath)
  const entries = action === 'git.createTree' ? fields.tree : fields.files
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry): HubActionFile[] => {
    const item = asRecord(entry)
    const path = text(item.path)
    if (!path) return []
    const deleted = item.delete === true || (item.sha === null && item.content === undefined)
    return [{ path, change: deleted ? 'deleted' : 'modified' }]
  })
}

/** Counted files replace declared ones by path; the declared order stays. */
function mergedFiles(declared: readonly HubActionFile[], counted: readonly HubActionFile[] | undefined): HubActionFile[] {
  if (!counted || counted.length === 0) return [...declared]
  if (declared.length === 0) return [...counted]
  const byPath = new Map(counted.map((file) => [file.path, file]))
  return declared.map((file) => byPath.get(file.path) ?? file)
}

function emailPreview(input: Record<string, unknown>, reply: boolean): HubActionPreview {
  return {
    kind: 'email',
    to: list(input.to ?? input.recipients),
    cc: list(input.cc),
    bcc: list(input.bcc),
    subject: text(input.subject),
    body: text(input.body) ?? text(input.text) ?? text(input.html) ?? text(input.comment),
    html: input.html === true || text(input.bodyType)?.toLowerCase() === 'html' || typeof input.html === 'string',
    reply,
  }
}

function speechSeconds(input: Record<string, unknown>): number | undefined {
  const spoken = text(input.text)
  if (!spoken) return undefined
  const speed = typeof input.speed === 'number' && input.speed > 0 ? input.speed : 1
  // About 2.5 spoken words a second at normal speed.
  return Math.max(1, Math.round(spoken.split(/\s+/).length / 2.5 / speed))
}

function voiceName(input: Record<string, unknown>): string | undefined {
  const voice = text(input.voiceId)
  // An opaque provider id says nothing to an owner; a named voice does.
  if (voice && !/^[0-9a-f-]{16,}$/i.test(voice) && voice.length <= 32) return voice.charAt(0).toUpperCase() + voice.slice(1)
  return text(input.provider)
}

const CURRENCY_DIGITS: Record<string, number> = { jpy: 0, krw: 0, vnd: 0, clp: 0, bhd: 3, kwd: 3, omr: 3 }

/** A Stripe minor-unit amount in its currency: `4900` USD is `$49.00`. */
export function formatMinorAmount(amount: number, currency = 'usd'): string {
  const code = currency.toLowerCase()
  const digits = CURRENCY_DIGITS[code] ?? 2
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code.toUpperCase(), minimumFractionDigits: digits })
      .format(amount / 10 ** digits)
  } catch {
    return `${(amount / 10 ** digits).toFixed(digits)} ${code.toUpperCase()}`
  }
}

/** Scalar input fields, for an action no renderer knows. */
function scalarFields(input: Record<string, unknown>, max = 6): HubActionField[] {
  return Object.entries(input).flatMap(([key, value]): HubActionField[] => {
    if (key.startsWith('__')) return []
    if (typeof value === 'string' && value.trim()) return [{ label: labelOf(key), value: clipped(value, 160) }]
    if (typeof value === 'number' || typeof value === 'boolean') return [{ label: labelOf(key), value: String(value) }]
    const strings = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
    return strings.length > 0 ? [{ label: labelOf(key), value: clipped(strings.join(', '), 160) }] : []
  }).slice(0, max)
}

function labelOf(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// ---------- presentation ----------

type Presenter = (input: Record<string, unknown>, item: Pick<HubApprovalItem, 'actionPath' | 'files'>) => Omit<HubActionPresentation, 'provider'>

function pullRequest(input: Record<string, unknown>, item: Pick<HubApprovalItem, 'actionPath' | 'files'>): Omit<HubActionPresentation, 'provider'> {
  const repo = repository(input)
  const title = text(input.title) ?? 'Untitled change'
  return {
    action: 'Open pull request',
    title: `Open PR: ${clipped(title)}${repo ? ` on ${repo}` : ''}`,
    ...(repo ? { target: repo } : {}),
    preview: {
      kind: 'pull-request',
      repository: repo,
      title,
      body: text(input.body),
      head: branchOf(input.branch ?? input.head),
      base: text(input.base),
      draft: item.actionPath.endsWith('.propose') ? true : input.draft === true,
      files: mergedFiles(hubActionFiles(item.actionPath, input), item.files),
    },
  }
}

function issueLike(verb: string, noun: string): Presenter {
  return (input) => {
    const repo = repository(input)
    const number = readNumber(input, 'issue_number', 'pull_number', 'number')
    const title = text(input.title)
    const object = number !== undefined ? `${noun} #${number}` : title ? `${noun}: ${clipped(title)}` : noun
    return {
      action: sentence(verb, noun.toLowerCase()),
      title: `${sentence(verb, object)}${repo ? ` on ${repo}` : ''}`,
      ...(repo ? { target: repo } : {}),
      preview: {
        kind: 'issue',
        repository: repo,
        number,
        title,
        body: text(input.body),
        verdict: text(input.event)?.toLowerCase().replace(/_/g, ' '),
      },
    }
  }
}

function sendEmail(verb: 'Send' | 'Save draft', reply = false): Presenter {
  return (input) => {
    const preview = emailPreview(input, reply)
    const recipients = preview.kind === 'email' ? people(preview.to) : ''
    const action = reply ? 'Send reply' : verb === 'Send' ? 'Send email' : 'Save draft'
    return {
      action,
      title: reply ? 'Send reply' : `${action}${recipients ? ` to ${recipients}` : ''}`,
      ...(recipients ? { target: recipients } : {}),
      preview,
    }
  }
}

function post(channel: 'x' | 'linkedin', reply = false): Presenter {
  return (input) => {
    const body = text(input.text) ?? text(input.commentary) ?? ''
    const url = text(input.url)
    const where = channel === 'x' ? 'X' : 'LinkedIn'
    return {
      action: reply ? `Reply on ${where}` : `Post on ${where}`,
      title: `${reply ? 'Reply' : 'Post'} on ${where}${body ? `: “${clipped(body, 60)}”` : ''}`,
      target: where,
      preview: {
        kind: 'post',
        channel,
        text: body,
        ...(url ? { link: { url, title: text(input.title), description: text(input.description) } } : {}),
      },
    }
  }
}

function payment(label: string): Presenter {
  return (input) => {
    const amount = readNumber(input, 'amount')
    const currency = text(input.currency)
    const customer = text(input.customerId) ?? text(input.customer) ?? text(input.email)
    const formatted = amount !== undefined ? formatMinorAmount(amount, currency) : undefined
    const object = formatted ? `${label} of ${formatted}` : label
    return {
      action: sentence('create', label),
      title: `${sentence('create', object)}${customer ? ` for ${customer}` : ''}`,
      ...(customer ? { target: customer } : {}),
      preview: { kind: 'payment', label, amount, currency, customer, description: text(input.description) },
    }
  }
}

function calendarEvent(input: Record<string, unknown>, _item?: Pick<HubApprovalItem, 'actionPath' | 'files'>): Omit<HubActionPresentation, 'provider'> {
  const title = text(input.summary) ?? text(input.title) ?? text(input.subject)
  return {
    action: 'Book event',
    title: title ? `Book “${clipped(title, 60)}”` : 'Book an event',
    preview: {
      kind: 'event',
      title,
      start: text(input.start) ?? text(asRecord(input.start).dateTime),
      end: text(input.end) ?? text(asRecord(input.end).dateTime),
      location: text(input.location) ?? text(asRecord(input.location).displayName),
      attendees: list(input.attendees),
      description: text(input.description),
    },
  }
}

const PRESENTERS: Record<string, Presenter> = {
  'github.pulls.propose': pullRequest,
  'github.pulls.create': pullRequest,
  'github.git.createTree': (input, item) => {
    const repo = repository(input)
    const files = mergedFiles(hubActionFiles(item.actionPath, input), item.files)
    return {
      action: 'Write files',
      title: `Write ${files.length === 1 ? files[0]!.path : `${files.length} files`}${repo ? ` to ${repo}` : ''}`,
      ...(repo ? { target: repo } : {}),
      preview: { kind: 'files', repository: repo, files },
    }
  },
  'github.git.createCommit': (input) => {
    const repo = repository(input)
    const message = text(input.message)
    return {
      action: 'Create commit',
      title: `Commit${message ? ` “${clipped(message, 60)}”` : ''}${repo ? ` to ${repo}` : ''}`,
      ...(repo ? { target: repo } : {}),
      preview: { kind: 'commit', repository: repo, message, tree: text(input.tree), parents: list(input.parents) },
    }
  },
  'github.git.createRef': (input) => {
    const repo = repository(input)
    const branch = branchOf(input.ref)
    return {
      action: 'Create branch',
      title: `Create branch ${branch ?? ''}${repo ? ` in ${repo}` : ''}`.replace(/\s+/g, ' ').trim(),
      ...(repo ? { target: repo } : {}),
      preview: { kind: 'branch', repository: repo, branch, sha: text(input.sha) },
    }
  },
  'github.pulls.merge': issueLike('merge', 'PR'),
  'github.pulls.reviews.create': issueLike('review', 'PR'),
  'github.issues.create': issueLike('open', 'Issue'),
  'github.issues.update': issueLike('update', 'Issue'),
  'github.issues.createComment': issueLike('comment on', 'Issue'),
  'gmail.send': sendEmail('Send'),
  'gmail.send_reply': sendEmail('Send', true),
  'outlook-mail.send_message': sendEmail('Send'),
  'outlook-mail.send_draft': sendEmail('Send'),
  'outlook-mail.create_draft': sendEmail('Save draft'),
  'outlook-mail.send_reply': sendEmail('Send', true),
  'inkbox.email.send': sendEmail('Send'),
  'resend.emails.send': sendEmail('Send'),
  'resend.emails.reply': sendEmail('Send', true),
  'twitter.tweets.create': post('x'),
  'twitter.tweets.reply': post('x', true),
  'x.tweets.create': post('x'),
  'linkedin.posts.create': post('linkedin'),
  'linkedin.shares.create': post('linkedin'),
  'slack.post_message': (input) => {
    const channel = text(input.channel) ?? text(input.channelId)
    const where = channel ? (channel.startsWith('#') || /^[CDG][A-Z0-9]{6,}$/.test(channel) ? channel : `#${channel}`) : undefined
    return {
      action: 'Post in Slack',
      title: `Post in ${where ?? 'Slack'}`,
      ...(where ? { target: where } : {}),
      preview: { kind: 'post', channel: 'slack', text: text(input.text) ?? '', where },
    }
  },
  'stripe.payment-intents.create': payment('payment'),
  'stripe.payment-links.create': payment('payment link'),
  'stripe.invoices.create': payment('invoice'),
  'stripe.refunds.create': payment('refund'),
  'stripe.subscriptions.create': payment('subscription'),
  'phony.synthesize_speech': (input) => {
    const seconds = speechSeconds(input)
    const voice = voiceName(input)
    const detail = [voice, seconds ? `${seconds} s` : undefined].filter(Boolean)
    return {
      action: 'Create voice memo',
      title: `Create voice memo${detail.length ? ` (${detail.join(', ')})` : ''}`,
      preview: { kind: 'speech', text: text(input.text) ?? '', voice, seconds },
    }
  },
  'phony.start_outbound_call': (input) => {
    const to = text(input.toNumber) ?? text(input.to)
    const mission = asRecord(input.mission)
    return {
      action: 'Start call',
      title: to ? `Call ${to}` : 'Start an outbound call',
      ...(to ? { target: to } : {}),
      preview: {
        kind: 'call',
        to,
        from: text(input.fromNumber),
        purpose: text(mission.goal) ?? text(mission.objective) ?? text(mission.summary) ?? text(input.missionId),
      },
    }
  },
  'google-calendar.create_event': calendarEvent,
  'google-calendar.book_slot': calendarEvent,
  'google-calendar.update_event': (input, item) => ({ ...calendarEvent(input, item), action: 'Update event' }),
  'microsoft-calendar.book_slot': calendarEvent,
}

/** A held call in the owner's words, with the preview its integration renders. */
export function presentHubAction(item: Pick<HubApprovalItem, 'actionPath' | 'providerId' | 'input' | 'files' | 'bundle'>): HubActionPresentation {
  const { provider: pathProvider, action } = splitHubActionPath(item.actionPath)
  const providerId = item.providerId || pathProvider
  const provider = { id: providerId, name: hubProviderName(providerId) }
  const input = asRecord(item.input)
  const known = PRESENTERS[item.actionPath]
  const presented = known
    ? known(input, item)
    : (() => {
        const { verb, noun } = genericVerb(action)
        const phrase = sentence(verb, noun) || action
        const object = text(input.name) ?? text(input.title) ?? text(input.subject) ?? text(input.label)
        return {
          action: phrase,
          title: object ? `${phrase} “${clipped(object, 60)}”` : phrase,
          preview: { kind: 'fields', fields: scalarFields(input) } as HubActionPreview,
        }
      })()
  return { provider, ...presented, ...(item.bundle ? { title: item.bundle.title } : {}) }
}

// ---------- receipts ----------

function prField(result: Record<string, unknown>): HubActionField | undefined {
  const pull = asRecord(result.pullRequest)
  const number = readNumber(pull, 'number') ?? readNumber(result, 'number')
  if (number === undefined) return undefined
  return { label: 'Pull request', value: `#${number}`, href: resultLink(pull) ?? resultLink(result) }
}

function receiptTitle(item: HubApprovalItem, presentation: HubActionPresentation, result: Record<string, unknown>): string {
  const { action } = splitHubActionPath(item.actionPath)
  const input = asRecord(item.input)
  const pull = asRecord(result.pullRequest)
  const number = readNumber(pull, 'number') ?? readNumber(result, 'number')
  switch (item.actionPath) {
    case 'github.pulls.propose':
    case 'github.pulls.create':
      return number !== undefined ? `Opened PR #${number}` : 'Opened pull request'
    case 'github.git.createCommit': {
      const sha = shortSha(readText(result, 'sha'))
      return sha ? `Created commit ${sha}` : 'Created commit'
    }
    case 'github.git.createTree': {
      const files = hubActionFiles(item.actionPath, input).length
      return `Wrote ${files === 1 ? '1 file' : `${files} files`}`
    }
    case 'github.git.createRef':
      return `Created branch ${branchOf(readText(result, 'ref') ?? input.ref) ?? ''}`.trim()
    case 'github.issues.create':
      return number !== undefined ? `Opened issue #${number}` : 'Opened issue'
    case 'github.issues.createComment': {
      const on = readNumber(input, 'issue_number')
      return on !== undefined ? `Commented on #${on}` : 'Commented'
    }
    case 'github.pulls.reviews.create': {
      const on = readNumber(input, 'pull_number')
      return on !== undefined ? `Reviewed PR #${on}` : 'Reviewed pull request'
    }
    case 'github.pulls.merge': {
      const on = readNumber(input, 'pull_number')
      return on !== undefined ? `Merged PR #${on}` : 'Merged pull request'
    }
    case 'phony.synthesize_speech':
      return 'Created voice memo'
  }
  if (presentation.preview.kind === 'email') {
    const to = people(presentation.preview.to)
    if (presentation.preview.reply) return 'Sent reply'
    return action.includes('draft') && !action.startsWith('send') ? `Saved draft${to ? ` to ${to}` : ''}` : `Sent email${to ? ` to ${to}` : ''}`
  }
  if (presentation.preview.kind === 'post') {
    return presentation.preview.channel === 'slack' ? `Posted in ${presentation.preview.where ?? 'Slack'}` : `Posted on ${presentation.target ?? presentation.provider.name}`
  }
  if (presentation.preview.kind === 'event') return presentation.preview.title ? `Booked “${clipped(presentation.preview.title, 60)}”` : 'Booked event'
  if (presentation.preview.kind === 'call') return presentation.preview.to ? `Started call to ${presentation.preview.to}` : 'Started call'
  const [first = '', ...rest] = presentation.action.split(' ')
  return [pastTense(first), ...rest].join(' ')
}

function postLink(item: HubApprovalItem, result: Record<string, unknown>): string | undefined {
  const id = readText(result, 'id', 'urn', 'postUrn')
  if (!id) return resultLink(result)
  if (item.providerId === 'twitter' || item.providerId === 'x') return /^\d+$/.test(id) ? `https://x.com/i/web/status/${id}` : resultLink(result)
  if (item.providerId === 'linkedin') return id.startsWith('urn:li:') ? `https://www.linkedin.com/feed/update/${id}/` : resultLink(result)
  return resultLink(result)
}

function receiptFields(item: HubApprovalItem, presentation: HubActionPresentation, result: Record<string, unknown>): HubActionField[] {
  const fields: HubActionField[] = []
  const preview = presentation.preview
  switch (preview.kind) {
    case 'pull-request': {
      const pr = prField(result)
      if (pr) fields.push(pr)
      const head = readText(result, 'branch') ?? preview.head
      const base = readText(result, 'base') ?? preview.base
      if (head && base) fields.push({ label: 'Branch', value: `${head} → ${base}`, mono: true })
      const commit = asRecord(result.commit)
      const sha = readText(commit, 'sha')
      if (sha) fields.push({ label: 'Commit', value: shortSha(sha)!, href: resultLink(commit), mono: true })
      const repo = readText(result, 'repository') ?? preview.repository
      if (repo) fields.push({ label: 'Repository', value: repo, href: `https://github.com/${repo}` })
      return fields
    }
    case 'commit': {
      const sha = readText(result, 'sha')
      if (sha) fields.push({ label: 'Commit', value: shortSha(sha)!, href: resultLink(result)?.includes('api.github.com') ? undefined : resultLink(result), mono: true })
      if (preview.message) fields.push({ label: 'Message', value: clipped(preview.message, 120) })
      return fields
    }
    case 'branch': {
      const branch = branchOf(readText(result, 'ref')) ?? preview.branch
      if (branch && preview.repository) fields.push({ label: 'Branch', value: branch, href: `https://github.com/${preview.repository}/tree/${branch}`, mono: true })
      return fields
    }
    case 'files': {
      const sha = readText(result, 'sha')
      if (sha) fields.push({ label: 'Tree', value: shortSha(sha)!, mono: true })
      return fields
    }
    case 'email': {
      if (preview.subject) fields.push({ label: 'Subject', value: clipped(preview.subject, 120) })
      if (preview.cc.length) fields.push({ label: 'Cc', value: preview.cc.join(', ') })
      return fields
    }
    case 'payment': {
      const amount = readNumber(result, 'amount', 'amount_total', 'total') ?? preview.amount
      const currency = readText(result, 'currency') ?? preview.currency
      if (amount !== undefined) fields.push({ label: 'Amount', value: formatMinorAmount(amount, currency) })
      const customer = readText(result, 'customer_email', 'customer') ?? preview.customer
      if (customer) fields.push({ label: 'Customer', value: customer, mono: customer.startsWith('cus_') })
      const status = readText(result, 'status')
      if (status) fields.push({ label: 'Status', value: status })
      return fields
    }
    case 'speech': {
      const seconds = readNumber(result, 'durationSeconds', 'duration')
      if (seconds !== undefined) fields.push({ label: 'Length', value: `${Math.round(seconds * 10) / 10} s` })
      if (preview.voice) fields.push({ label: 'Voice', value: preview.voice })
      return fields
    }
    case 'event': {
      if (preview.start) fields.push({ label: 'When', value: formatWhen(preview.start, preview.end) })
      if (preview.attendees.length) fields.push({ label: 'Guests', value: people(preview.attendees) })
      return fields
    }
    case 'call': {
      const status = readText(asRecord(result.call), 'status') ?? readText(result, 'status')
      if (status) fields.push({ label: 'Status', value: status })
      return fields
    }
    default: {
      const id = readText(result, 'id', 'number', 'key')
      if (id) fields.push({ label: 'ID', value: id, mono: true })
      const status = readText(result, 'status', 'state')
      if (status) fields.push({ label: 'Status', value: status })
      const name = readText(result, 'name', 'title')
      if (name) fields.push({ label: 'Name', value: clipped(name, 80) })
      return fields
    }
  }
}

/** A start and optional end in the viewer's locale: `Tue, Oct 14, 3:00 – 3:30 PM`. */
export function formatWhen(start: string, end?: string): string {
  const from = new Date(start)
  if (Number.isNaN(from.getTime())) return end ? `${start} – ${end}` : start
  const day = from.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const to = end ? new Date(end) : null
  if (!to || Number.isNaN(to.getTime())) return `${day}, ${time(from)}`
  return to.toDateString() === from.toDateString() ? `${day}, ${time(from)} – ${time(to)}` : `${day}, ${time(from)} – ${to.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time(to)}`
}

function receiptFiles(result: Record<string, unknown>): HubActionFile[] | undefined {
  if (!Array.isArray(result.files)) return undefined
  return result.files.flatMap((entry): HubActionFile[] => {
    const file = asRecord(entry)
    const path = text(file.path) ?? text(file.filename)
    if (!path) return []
    const status = text(file.status)
    const change = status === 'added' ? 'added' : status === 'removed' || status === 'deleted' ? 'deleted' : 'modified'
    return [{ path, change, additions: readNumber(file, 'additions'), deletions: readNumber(file, 'deletions') }]
  })
}

/** What a decided call did: its past-tense title, key fields, link, media and files. */
export function hubActionReceipt(item: HubApprovalItem): HubActionReceipt {
  const presentation = presentHubAction(item)
  const result = asRecord(unwrapHubResult(item.result))
  const status: HubActionReceipt['status'] = item.phase === 'done' || item.phase === 'failed' || item.phase === 'denied' || item.phase === 'expired'
    ? item.phase
    : item.phase === 'queued' || item.phase === 'running' ? 'running' : 'waiting'
  const base = { provider: presentation.provider, status }
  if (status === 'denied') return { ...base, title: `Denied: ${presentation.title}`, fields: [] }
  if (status === 'expired') return { ...base, title: `Expired: ${presentation.title}`, fields: [] }
  if (status === 'failed') return { ...base, title: `Could not ${presentation.action.charAt(0).toLowerCase()}${presentation.action.slice(1)}`, fields: [], ...(item.error ? { error: item.error } : {}) }
  if (status !== 'done') return { ...base, title: presentation.title, fields: [] }
  const title = receiptTitle(item, presentation, result)
  const fields = receiptFields(item, presentation, result)
  const pull = asRecord(result.pullRequest)
  const href = presentation.preview.kind === 'post'
    ? postLink(item, result)
    : resultLink(pull) ?? (item.actionPath.startsWith('github.git.') ? undefined : resultLink(result))
  const audio = readText(result, 'audioUrl')
  const seconds = readNumber(result, 'durationSeconds', 'duration')
  const files = receiptFiles(result)
  return {
    ...base,
    title,
    ...(href ? { href } : {}),
    fields,
    ...(files && files.length ? { files } : {}),
    ...(audio && /^https:\/\//.test(audio) ? { media: { kind: 'audio' as const, src: audio, ...(seconds !== undefined ? { seconds } : {}) } } : {}),
  }
}
