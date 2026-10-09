/**
 * Transactional email for Tangle agent apps: one branded layout and typed
 * templates that each return `{ subject, preheader, html, text, attachments }`.
 * The header is the Tangle lockup with the product name (`Tangle GTM Agent`);
 * the footer names the workspace, the reason and a manage link, plus a postal
 * address only when a marketing email such as a digest passes one.
 *
 * Transport-free and dependency-free, so it runs in Workers and Node alike:
 * the app hands the message to its own Resend or SES client. The header's
 * Tangle mark is an inline `cid:` image, which renders without the app hosting
 * an asset and while remote images are blocked, so pass `attachments` through.
 *
 *   import { approvalEmail, emailSender } from '@tangle-network/agent-app/email'
 *
 *   const message = approvalEmail({ name: 'GTM Agent', url: origin }, {
 *     actions: [{ summary: 'Create agent “Quinn”', detail: 'ph0ny' }],
 *     approveUrl: `/app/${workspaceId}/chat/${threadId}`,
 *     reviewUrl: `/app/${workspaceId}/review`,
 *     footer: { workspaceName, reason: 'You own this workspace.' },
 *   })
 *   await resend.emails.send({ from: emailSender('GTM Agent', 'noreply@tangle.tools'), to, ...message })
 *
 * Every field the message carries goes to the mail client, `headers`
 * included: a footer `unsubscribeUrl` adds the RFC 8058 one-click headers.
 *
 * `lintEmailHtml` checks rendered HTML against Gmail and Outlook constraints;
 * `emailPreviewHtml` embeds the inline images for a browser preview.
 */
export {
  emailPreviewHtml,
  emailSender,
  type EmailAction,
  type EmailAttachment,
  type EmailFooter,
  type EmailItem,
  type EmailMessage,
  type EmailProduct,
  type EmailSection,
} from './layout'
export {
  approvalEmail,
  digestEmail,
  inviteEmail,
  noticeEmail,
  type ApprovalEmailAction,
  type ApprovalEmailInput,
  type DigestEmailInput,
  type InviteEmailInput,
  type NoticeEmailInput,
} from './templates'
export { lintEmailHtml, type EmailLintIssue } from './lint'
