---
"@tangle-network/agent-app": minor
---

Link-only invitations. `MembersSection` and `InvitationsSection` take `delivery="link"` for a product that emails no invitations: Invite says no email is sent, creates the invitation, and shows the link the server returned in the Members card with Copy link; pending rows never mention email, offer no Resend email (`onResend` is now optional), and a refused copy shows the link to select. `createInvitationsApi` makes `sendInvitationEmail` optional: without it, an invitation stays `not_sent` and resend is refused with 409. The AssistantPanel header title moves to `--font-size-sm` (14px), the size of every other shell header title.
