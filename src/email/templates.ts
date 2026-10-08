import {
  emailSubject,
  renderEmail,
  type EmailAction,
  type EmailFooter,
  type EmailItem,
  type EmailMessage,
  type EmailProduct,
} from './layout'

/** Sentence case to mid-sentence: `Create agent` → `create agent`; acronyms such as `API key` keep their case. */
function midSentence(text: string): string {
  const first = text.split(/\s/, 1)[0] ?? ''
  if ((first.match(/[A-Z]/g) ?? []).length > 1) return text
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

function day(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** One action an agent is waiting to run. */
export interface ApprovalEmailAction {
  /** What runs, in plain language and sentence case: `Create agent “Quinn”`. */
  summary: string
  /** Where it runs and until when, e.g. `ph0ny · open until Oct 9, 3:40 PM UTC`. */
  detail?: string
}

/** Input for {@link approvalEmail}. */
export interface ApprovalEmailInput {
  /** At least one action, in the order the agent asked. */
  actions: readonly ApprovalEmailAction[]
  /** The conversation the agent paused in. */
  conversation?: string
  /** Opens the decision, e.g. the chat with the approval card. */
  approveUrl: string
  /** Opens the context, e.g. every request waiting in the workspace. */
  reviewUrl: string
  footer: EmailFooter
}

/**
 * An agent paused until someone approves what it wants to do. Neither button
 * decides anything: link scanners open email links, so both lead to the app,
 * where the signed-in owner approves.
 */
export function approvalEmail(product: EmailProduct, input: ApprovalEmailInput): EmailMessage {
  const [first, ...rest] = input.actions
  if (!first) throw new TypeError('approvalEmail needs at least one action')
  const what = rest.length === 0
    ? midSentence(first.summary)
    : `${midSentence(first.summary)} and ${rest.length} more`
  const where = input.conversation ? ` in “${input.conversation}”` : ''
  return renderEmail(product, {
    subject: emailSubject(`Approve: ${what}`, product),
    preheader: `The agent paused${where} until you decide.`,
    title: rest.length === 0 ? 'Approval needed' : `${input.actions.length} approvals needed`,
    paragraphs: [`The agent paused${where} until you decide. Nothing runs until you approve.`],
    items: input.actions.map((action): EmailItem => ({ title: action.summary, ...(action.detail ? { detail: action.detail } : {}) })),
    primary: { label: 'Approve', url: input.approveUrl },
    secondary: { label: 'Review', url: input.reviewUrl },
    footer: input.footer,
  })
}

/** Input for {@link inviteEmail}. */
export interface InviteEmailInput {
  workspaceName: string
  /** Who sent the invitation: a name or an email address. */
  inviter: string
  /** The role the invitation grants, e.g. `editor`. */
  role: string
  acceptUrl: string
  expiresAt: Date
}

/** Someone invited the recipient to a workspace. */
export function inviteEmail(product: EmailProduct, input: InviteEmailInput): EmailMessage {
  const role = input.role.toLowerCase()
  const article = /^[aeiou]/.test(role) ? 'an' : 'a'
  return renderEmail(product, {
    subject: emailSubject(`Join ${input.workspaceName}`, product),
    preheader: `${input.inviter} invited you to ${input.workspaceName}.`,
    title: `Join ${input.workspaceName}`,
    paragraphs: [`${input.inviter} invited you to ${input.workspaceName} on ${product.name} as ${article} ${role}.`],
    primary: { label: 'Accept invitation', url: input.acceptUrl },
    showPrimaryLink: true,
    note: `This invitation expires on ${day(input.expiresAt)}.`,
    footer: {
      workspaceName: input.workspaceName,
      reason: `You received this because ${input.inviter} invited this address.`,
    },
  })
}

/** Input for {@link digestEmail}. */
export interface DigestEmailInput {
  workspaceName: string
  /** The day the digest covers. */
  date: Date
  /** What happened, most important first. */
  items: readonly EmailItem[]
  /** Opens the workspace. */
  openUrl: string
  footer: EmailFooter
}

/** What happened in a workspace that day. */
export function digestEmail(product: EmailProduct, input: DigestEmailInput): EmailMessage {
  const count = input.items.length
  const updates = `${count} ${plural(count, 'update', 'updates')}`
  const date = input.date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
  return renderEmail(product, {
    subject: emailSubject(`${input.workspaceName}: ${updates}`, product),
    preheader: input.items[0]?.title ?? `Nothing new in ${input.workspaceName}.`,
    title: `What happened in ${input.workspaceName}`,
    paragraphs: [count === 0 ? `Nothing new on ${date}.` : `${updates} on ${date}.`],
    items: input.items,
    primary: { label: `Open ${product.name}`, url: input.openUrl },
    footer: input.footer,
  })
}

/** Input for {@link noticeEmail}. */
export interface NoticeEmailInput {
  /** Short; the product name is appended. */
  subject: string
  title: string
  /** One or two short paragraphs. */
  body: string | readonly string[]
  action?: EmailAction
  secondaryAction?: EmailAction
  /** Print the action's link too, for one-time links such as sign-in. */
  showLink?: boolean
  note?: string
  /** Inbox preview line. Defaults to the first paragraph. */
  preheader?: string
  footer: EmailFooter
}

/** Any other transactional message: one title, a short body and at most two buttons. */
export function noticeEmail(product: EmailProduct, input: NoticeEmailInput): EmailMessage {
  const paragraphs = typeof input.body === 'string' ? [input.body] : [...input.body]
  return renderEmail(product, {
    subject: emailSubject(input.subject, product),
    preheader: input.preheader ?? paragraphs[0] ?? input.title,
    title: input.title,
    paragraphs,
    ...(input.action ? { primary: input.action } : {}),
    ...(input.secondaryAction ? { secondary: input.secondaryAction } : {}),
    ...(input.showLink ? { showPrimaryLink: true } : {}),
    ...(input.note ? { note: input.note } : {}),
    footer: input.footer,
  })
}
