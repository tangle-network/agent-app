---
"@tangle-network/agent-app": patch
---

`./platform` adds `createPlatformBillingConsent`: an app that creates sandboxes under its service key and names the signed-in person as `billingOwnerId` records that person's billing delegation grant from their sign-in key before the first delegated create, so the Sandbox API stops refusing it with `BILLING_DELEGATION_GRANT_REQUIRED`. Refusals come back typed (`billing_consent.payer_not_chargeable`, `.refused`, `.unavailable`) with a message written for the person.
