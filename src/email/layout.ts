import { TANGLE_MARK_PNG_BASE64 } from './mark.generated'
import { EMAIL_FONT_STACK, EMAIL_PALETTE, TANGLE_POSTAL_ADDRESS } from './palette'

/** The app an email comes from. */
export interface EmailProduct {
  /** Shown beside the Tangle mark, after each subject and in the sender name, e.g. `GTM Agent`. */
  name: string
  /** The app's absolute origin; app-relative links resolve against it. */
  url: string
}

/** Why the recipient got the email and where they control it. */
export interface EmailFooter {
  /** The workspace the email concerns. */
  workspaceName?: string
  /** One sentence, e.g. `You own this workspace.` */
  reason: string
  /** Where the recipient changes which emails they get; absolute or app-relative. */
  manageUrl?: string
}

/** A button. `url` is absolute or app-relative. */
export interface EmailAction {
  label: string
  url: string
}

/** One row in the email's list box: an approval request or a digest entry. */
export interface EmailItem {
  title: string
  detail?: string
  /** Makes the title a link; absolute or app-relative. */
  url?: string
}

/** An inline image the HTML references by `cid:`; the mail client must send it with the message. */
export interface EmailAttachment {
  filename: string
  /** Base64 file content, the form Resend and SES accept. */
  content: string
  contentType: string
  contentId: string
}

/** A rendered email, ready for any transport. */
export interface EmailMessage {
  subject: string
  /** The inbox preview line. */
  preheader: string
  html: string
  text: string
  /** Pass these through to the mail client; the header mark is one of them. */
  attachments: EmailAttachment[]
}

/** What a template places in the shared layout. */
interface EmailContent {
  subject: string
  preheader: string
  title: string
  paragraphs: readonly string[]
  items?: readonly EmailItem[]
  primary?: EmailAction
  secondary?: EmailAction
  /** Print the primary link under the buttons for clients that strip them. */
  showPrimaryLink?: boolean
  /** A short line under the buttons, e.g. an expiry. */
  note?: string
  footer: EmailFooter
}

const MARK_CONTENT_ID = 'tangle-mark'
const MARK_ATTACHMENT: EmailAttachment = {
  filename: 'tangle.png',
  content: TANGLE_MARK_PNG_BASE64,
  contentType: 'image/png',
  contentId: MARK_CONTENT_ID,
}

const L = EMAIL_PALETTE.light
const D = EMAIL_PALETTE.dark
const FONT = EMAIL_FONT_STACK

// Inline styles carry the light design; this block only adapts it for clients
// that honor dark mode or narrow screens. A client that drops <style> still
// renders the complete light email.
const STYLE = `
@media (prefers-color-scheme: dark) {
  .t-bg { background-color: ${D.canvas} !important; }
  .t-card { background-color: ${D.card} !important; border-color: ${D.hairline} !important; }
  .t-well { background-color: ${D.well} !important; }
  .t-rule { border-color: ${D.hairline} !important; }
  .t-ink { color: ${D.ink} !important; }
  .t-ink2 { color: ${D.inkSecondary} !important; }
  .t-muted { color: ${D.inkMuted} !important; }
  .t-link { color: ${D.accentText} !important; }
  .t-btn2 { border-color: ${D.hairline} !important; }
}
@media (max-width: 600px) {
  .t-outer { padding: 20px 8px !important; }
  .t-card { padding: 28px 22px 24px !important; }
}
[data-ogsb] .t-bg { background-color: ${D.canvas} !important; }
[data-ogsb] .t-card { background-color: ${D.card} !important; }
[data-ogsb] .t-well { background-color: ${D.well} !important; }
[data-ogsc] .t-ink { color: ${D.ink} !important; }
[data-ogsc] .t-ink2 { color: ${D.inkSecondary} !important; }
[data-ogsc] .t-muted { color: ${D.inkMuted} !important; }
[data-ogsc] .t-link { color: ${D.accentText} !important; }
`.trim()

/** Escape text for HTML element content and quoted attribute values. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** An absolute http(s) URL; app-relative paths resolve against the product origin. */
function resolveEmailUrl(url: string, product: EmailProduct): string {
  const resolved = new URL(url, product.url)
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
    throw new TypeError(`Email links must be http(s): ${resolved.protocol}`)
  }
  return resolved.toString()
}

/** `Title — Product`, the one subject shape every Tangle email uses. */
export function emailSubject(subject: string, product: EmailProduct): string {
  return `${subject} — ${product.name}`
}

function paragraph(text: string, margin: string): string {
  return `<p class="t-ink2" style="margin:${margin};font-family:${FONT};font-size:15px;line-height:24px;color:${L.inkSecondary}">${escapeHtml(text)}</p>`
}

function link(label: string, href: string, style: string): string {
  return `<a class="t-link" href="${escapeHtml(href)}" style="color:${L.accentText};text-decoration:none;${style}">${escapeHtml(label)}</a>`
}

function header(product: EmailProduct): string {
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0">',
    '<tr>',
    `<td style="padding:0 10px 0 0;vertical-align:middle"><img src="cid:${MARK_CONTENT_ID}" width="28" height="28" alt="Tangle" style="display:block;width:28px;height:28px;border:0;outline:none;text-decoration:none"></td>`,
    `<td class="t-ink" style="vertical-align:middle;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;letter-spacing:-0.01em;color:${L.ink}">${escapeHtml(product.name)}</td>`,
    '</tr>',
    '</table>',
  ].join('')
}

function items(list: readonly EmailItem[], product: EmailProduct): string {
  const rows = list.map((item, index) => {
    const rule = index === 0 ? '' : `border-top:1px solid ${L.hairline};`
    const title = item.url
      ? link(item.title, resolveEmailUrl(item.url, product), 'font-weight:600')
      : escapeHtml(item.title)
    const detail = item.detail
      ? `<p class="t-muted" style="margin:2px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${L.inkMuted}">${escapeHtml(item.detail)}</p>`
      : ''
    return [
      `<tr><td class="t-rule" style="padding:14px 16px;${rule}">`,
      `<p class="t-ink" style="margin:0;font-family:${FONT};font-size:15px;line-height:22px;font-weight:600;color:${L.ink}">${title}</p>`,
      detail,
      '</td></tr>',
    ].join('')
  })
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="t-well" bgcolor="${L.well}" style="background-color:${L.well};border-radius:8px;margin:4px 0 8px">`,
    ...rows,
    '</table>',
  ].join('')
}

function primaryButton(action: EmailAction, href: string): string {
  return [
    `<td bgcolor="${L.accent}" style="border-radius:8px;background-color:${L.accent};mso-padding-alt:12px 22px">`,
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:${L.onAccent};text-decoration:none;border-radius:8px">${escapeHtml(action.label)}</a>`,
    '</td>',
  ].join('')
}

function secondaryButton(action: EmailAction, href: string): string {
  return [
    `<td class="t-btn2" style="border:1px solid ${L.hairline};border-radius:8px;mso-padding-alt:11px 21px">`,
    `<a class="t-ink" href="${escapeHtml(href)}" style="display:inline-block;padding:11px 21px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:${L.ink};text-decoration:none;border-radius:8px">${escapeHtml(action.label)}</a>`,
    '</td>',
  ].join('')
}

function buttons(content: EmailContent, product: EmailProduct): string {
  const cells: string[] = []
  if (content.primary) cells.push(primaryButton(content.primary, resolveEmailUrl(content.primary.url, product)))
  if (content.secondary) {
    if (cells.length > 0) cells.push('<td style="width:10px;font-size:0;line-height:0">&nbsp;</td>')
    cells.push(secondaryButton(content.secondary, resolveEmailUrl(content.secondary.url, product)))
  }
  if (cells.length === 0) return ''
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0"><tr>${cells.join('')}</tr></table>`
}

function small(html: string, margin: string, size = 13): string {
  return `<p class="t-muted" style="margin:${margin};font-family:${FONT};font-size:${size}px;line-height:${size + 7}px;color:${L.inkMuted}">${html}</p>`
}

function footerLines(footer: EmailFooter, product: EmailProduct): { html: string[]; text: string[] } {
  const where = footer.workspaceName ? `${footer.workspaceName} · ${product.name}` : product.name
  const manage = footer.manageUrl ? resolveEmailUrl(footer.manageUrl, product) : null
  const html = [
    escapeHtml(where),
    escapeHtml(footer.reason),
    ...(manage ? [link('Manage notifications', manage, 'text-decoration:underline')] : []),
    escapeHtml(TANGLE_POSTAL_ADDRESS),
  ]
  const text = [where, footer.reason, ...(manage ? [`Manage notifications: ${manage}`] : []), TANGLE_POSTAL_ADDRESS]
  return { html, text }
}

// Keeps the body text that follows out of the inbox preview line.
const PREHEADER_SPACER = '&#847;&zwnj;&nbsp;'.repeat(40)

function renderHtml(content: EmailContent, product: EmailProduct): string {
  const primaryHref = content.primary ? resolveEmailUrl(content.primary.url, product) : null
  const footer = footerLines(content.footer, product)
  const body = [
    `<h1 class="t-ink" style="margin:0 0 12px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.01em;color:${L.ink}">${escapeHtml(content.title)}</h1>`,
    ...content.paragraphs.map((text) => paragraph(text, '0 0 12px')),
    content.items && content.items.length > 0 ? items(content.items, product) : '',
    buttons(content, product),
    content.showPrimaryLink && primaryHref
      ? small(`Or open this link: ${link(primaryHref, primaryHref, 'word-break:break-all')}`, '20px 0 0')
      : '',
    content.note ? small(escapeHtml(content.note), content.showPrimaryLink ? '8px 0 0' : '20px 0 0') : '',
  ].join('')

  return [
    '<!DOCTYPE html>',
    '<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="X-UA-Compatible" content="IE=edge">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${escapeHtml(content.subject)}</title>`,
    '<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->',
    `<style>\n${STYLE}\n</style>`,
    '</head>',
    `<body class="t-bg" style="margin:0;padding:0;width:100%;background-color:${L.canvas};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">`,
    `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escapeHtml(content.preheader)}${PREHEADER_SPACER}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="t-bg" bgcolor="${L.canvas}" style="background-color:${L.canvas}">`,
    '<tr><td class="t-outer" align="center" style="padding:32px 12px">',
    '<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto">',
    `<tr><td style="padding:0 4px 20px">${header(product)}</td></tr>`,
    `<tr><td class="t-card" bgcolor="${L.card}" style="background-color:${L.card};border:1px solid ${L.hairline};border-radius:12px;padding:36px 36px 32px">${body}</td></tr>`,
    `<tr><td style="padding:24px 4px 0">${footer.html.map((line, index) => small(line, index === 0 ? '0' : '4px 0 0', 12)).join('')}</td></tr>`,
    '</table>',
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('\n')
}

function renderText(content: EmailContent, product: EmailProduct): string {
  const blocks: string[] = [product.name, content.title, ...content.paragraphs]
  if (content.items && content.items.length > 0) {
    blocks.push(content.items.map((item) => {
      const lines = [`- ${item.title}`]
      if (item.detail) lines.push(`  ${item.detail}`)
      if (item.url) lines.push(`  ${resolveEmailUrl(item.url, product)}`)
      return lines.join('\n')
    }).join('\n'))
  }
  const actions = [content.primary, content.secondary]
    .filter((action): action is EmailAction => Boolean(action))
    .map((action) => `${action.label}: ${resolveEmailUrl(action.url, product)}`)
  if (actions.length > 0) blocks.push(actions.join('\n'))
  if (content.note) blocks.push(content.note)
  blocks.push(['--', ...footerLines(content.footer, product).text].join('\n'))
  return `${blocks.join('\n\n')}\n`
}

/** Place a template's content in the shared Tangle layout. */
export function renderEmail(product: EmailProduct, content: EmailContent): EmailMessage {
  return {
    subject: content.subject,
    preheader: content.preheader,
    html: renderHtml(content, product),
    text: renderText(content, product),
    attachments: [MARK_ATTACHMENT],
  }
}

/**
 * The HTML with inline images embedded as data URIs, for browser previews and
 * screenshots. Mail clients get `cid:` references and the attachments instead.
 */
export function emailPreviewHtml(message: Pick<EmailMessage, 'html' | 'attachments'>): string {
  return message.attachments.reduce(
    (html, attachment) => html.split(`cid:${attachment.contentId}`).join(`data:${attachment.contentType};base64,${attachment.content}`),
    message.html,
  )
}

/**
 * The From header for an app's mail: `GTM Agent · Tangle <noreply@tangle.tools>`.
 * The product leads because inbox sender columns truncate; `· Tangle` ties
 * every app to the company and the sending domain.
 */
export function emailSender(productName: string, address: string): string {
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address)) throw new TypeError(`Not an email address: ${address}`)
  const name = /\bTangle\b/i.test(productName) ? productName : `${productName} · Tangle`
  return `${name} <${address}>`
}
