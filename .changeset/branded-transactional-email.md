---
"@tangle-network/agent-app": minor
---

New `./email` subpath: one branded transactional email layout for every Tangle agent app. The header is the Tangle mark beside the product name, as in the app header; the body is a title, a short body and a primary button; the footer names the workspace, why the recipient got the email, a manage-notifications link and Tangle's postal address. Colors come from Brand's `palettes` (a test pins them) with a dark-mode override block, type is Brand's Inter stack with system fallbacks, and every message has a plain-text part. Typed templates: `approvalEmail`, `inviteEmail`, `digestEmail` and `noticeEmail`; `emailSender` builds the `Product · Tangle <address>` From header; `lintEmailHtml` checks HTML against Gmail and Outlook constraints. The mark is an inline `cid:` image, so mail clients must receive `attachments`.

`createAppAuth` password-reset and verification emails now use this layout (subjects `Reset your password — <App>` and `Verify your email — <App>`) and pass `attachments` to the email client.

Breaking: `renderInvitationEmail`, `RenderInvitationEmailInput`, `InvitationEmailBrand` and `RenderedInvitationEmail` are removed from `./teams`; render invitations with `inviteEmail` from `./email`.
