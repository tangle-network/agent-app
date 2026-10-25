---
"@tangle-network/agent-app": patch
---

Own the server pieces every agent app copied: the direct-generation request check (`checkGenerateRequest`) and the provider-side generation steps over the generated-media store (`createGeneratedMediaFlows`: ingest, settle a video or avatar job, speech, transcription, provider images, and polling a running job); plan lookup parsing and plan-decision refusal responses; the members route handler (`handleMembersRequest`); a thread-access check; the rolling GitHub-issue alert channel; the sandbox Router model policy read; gateway-backed operator keys; the shared-billing state read; Platform URL and SSO client options from the deployment environment; and table factories for the spend box ledger, thread artifact links and agent runs. `createPlatformBillingHttp` now reads `PLATFORM_SERVICE_TOKEN` when no service token is given.
