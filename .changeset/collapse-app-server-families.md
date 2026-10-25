---
"@tangle-network/agent-app": patch
---

Own the server pieces every agent app copied: the direct-generation request check (`checkGenerateRequest`) and the provider-side generation steps over the generated-media store (`createGeneratedMediaFlows`: ingest, settle a video or avatar job, speech, transcription, provider images, and polling a running job); plan lookup parsing and plan-decision refusal responses; the members route handler (`handleMembersRequest`); a thread-access check; the rolling GitHub-issue alert channel; the sandbox Router model policy read; gateway-backed operator keys; the shared-billing state read; Platform URL and SSO client options from the deployment environment; and table factories for the spend box ledger, thread artifact links and agent runs. `createPlatformBillingHttp` now reads `PLATFORM_SERVICE_TOKEN` when no service token is given.

`createGeneratedMediaFlows` takes `failOnRejectedResultUrl` (default true): false records a result URL the store rejects as a storage failure, keeping the provider's row, instead of failing the generation (GTM's behaviour). `platformBaseUrlFromEnv` reads the environment through a guarded lookup, and the delegated-key client uses it; `createPlatformBillingHttp` trims `PLATFORM_SERVICE_TOKEN`.
