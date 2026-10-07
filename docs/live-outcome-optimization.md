# Live outcome optimization

Every agent product should get better at the jobs customers actually ask of it, measured on real production runs. This page specializes the [application improvement contract](agent-improvement-contract.md) for live jobs: it defines how a product turns each production run into an outcome claim bound to the exact execution and profile revision, which that contract's Outcome and Comparison stages consume. It maps the loop onto the packages that already own each stage and names the parts that are missing. GTM Agent's ad-creative job is the first implementation ([gtm-agent `src/lib/.server/outcomes`](https://github.com/tangle-network/gtm-agent/tree/master/src/lib/.server/outcomes)).

## Problem

Offline evaluation (agent-eval `selfImprove`, persona campaigns) tells us whether a profile does well on scenarios we wrote. It does not tell us whether the agent did the job a customer asked for. On 2026-10-07 the GTM agent produced eight ads that passed its own review and every scripted check we had, and the founder rejected all of them: the image model had painted invented logos. An unassisted run on the same day fetched the real logo and rendered HTML with the real fonts, and got it right. Nothing recorded the difference, nothing attributed it to the profile or to a missing tool, and nothing changed the agent's next run.

## Change

Treat each production turn that performs a declared job as a scored episode, and close the loop on live data.

| Stage | What happens | Owner today | Missing |
| --- | --- | --- | --- |
| Declare | An outcome contract per job: decidable checks over durable records, each tagged with the lever that fixes it (`profile` or `capability`) | — | Contract types and scorer. First instance in GTM; move to agent-eval `./outcomes` once a second product adopts it, so the vocabulary stays agent-eval's reward channels |
| Capture | Turn admission, persisted tool parts, assistant receipt, profile revision that ran | agent-app chat-store and turn routes; GTM profile execution receipts | Production trace ingestion is off in GTM (`INGESTION_URL` unset); the ledger reads durable rows instead until it is on |
| Check | Deterministic checks computed from what the run left behind; an unobservable check is `null`, never a pass | — (new, per contract) | — |
| Signal | Human verdicts, business results, review decisions; humans outrank business, which outranks checks | Work-product review and Asset Studio decisions stay in their existing version-fenced stores; Hub reports and ad metrics (agent-integrations) | A shared "useful / not useful, why" control on a turn (agent-app chat has none); decision rows that record whether a person or the agent acted. Until then a product may retain operator-relayed labels with explicit provenance, never as a substitute for its review service |
| Judge | Model judgement for what checks cannot decide (visual quality, claim support) | agent-eval `buildEnsembleJudge`, judge calibration, chat-trace analyst engine | Running a calibrated judge on live episodes; calibration against the human labels the ledger collects |
| Diagnose | Classify each failure: the agent chose badly (profile) or could not act (capability); flag human rejections every check passed (contract blind spot) | agent-runtime `runAnalystLoop` (findings ledger, proposal sources) for model-based diagnosis | The deterministic classifier ships in the contract; analyst-loop wiring over episodes is slice 2 |
| Act: profile | Candidate profile tried on live work, compared with its parent by success rate per profile revision, kept or reverted | GTM profile trials (try / keep / revert, receipts); agent-runtime `improve()` and agent-eval `selfImprove` for candidate search | Proposal-to-candidate authoring; the agent's own `profile-authoring` skill is the intended author |
| Act: capability | Issue draft with the failing check, observed details and replayable trace links | Software factory / product repositories | Filing the drafts automatically once their precision is established |
| Retain | Scored episodes are the product's outcome claims, bound to execution id and profile revision, upserted as signals arrive | Product store (GTM `outcome_episode`, `outcome_finding`) | Export through the product's existing authorized ingest/outbox to Intelligence once enabled; no second feedback service |
| Feed back | The agent reads its own record (`knowledge/outcomes/<job>.md`) before repeating the job | Workspace vault | — |
| Schedule | Deterministic scoring hourly; judge and analyst passes daily | Product crons and agent automations | No new scheduler |

Guardrails: experiments run in the owner's own workspace or isolated copies; candidates are never promoted into a customer workspace automatically; promotion needs a live comparison by profile revision over a minimum number of scored episodes; production rows are append-or-upsert only; a judge counts only after it agrees with human labels.

## Why this is the right long-term shape

The agent does the work and the platform measures it. Human and business outcomes decide, so the loop cannot optimize for its own checks. Splitting failures by lever keeps prompt tuning from papering over a missing tool, and a missing tool from being blamed on the prompt. Every stage reuses the package that already owns it, so a second product adopts the loop by writing contracts, not infrastructure.

## Cost

Slice 1 (GTM ad-creative: contract, ledger, hourly scoring, findings, relayed labels, vault feedback): about a day. Slice 2 (shared turn-feedback control, live judge with calibration, analyst-loop diagnosis, more GTM jobs: lead finding, outbound, reporting): about three days. Extracting the contract to agent-eval: under a day once a second consumer exists. Rollback for each slice is removing its scheduled call; ledger tables are additive.
