# Shared agent app release workflow

[release-agent-app.yml](../.github/workflows/release-agent-app.yml) owns the production release phase order for agent apps. Apps retain their existing release commands, migration authority, served-revision checks and recovery behavior. Callers pin this reusable workflow to a reviewed full Git SHA.

The workflow separates three existing command boundaries:

| Input | Required behavior |
| --- | --- |
| `preflight-command` | Frozen lifecycle install, types, lint, build, bundle checks and applicable non-credentialed invariants. This command prepares the artifact that the release consumes. |
| `release-command` | Credentialed startup qualification, additive migrations, native deployment, exact served identity, bounded smoke/canary and compatible artifact recovery. It consumes the already built artifact. |
| `suites-command` | Its own frozen install and the app's complete post-release test population, plus any post-release check of the served app through its release host (`RELEASE_SSH_KEY` is its only credential). This job runs on the same source commit after the release job. |

These are command inputs to the existing native surfaces, not additional CLIs. Release-only and suite-only modes must leave the normal full merge gate unchanged. A named suite with excluded cases is not proof of full coverage: account for every moved case before adopting the split.

GTM's [release phase split](https://github.com/tangle-network/gtm-agent/pull/1896) supplies the existing `SHIP_RELEASE_GATE` and `SHIP_VERIFY_SUITES` modes of `bash scripts/ship.sh verify`; `bash scripts/ship.sh release` retains its canary and recovery. Creative's [post-release suite](https://github.com/tangle-network/creative-agent/pull/730) supplies the sequencing reference. Neither reference alone qualifies another app's adapter.

## Caller configuration

`environment` names the caller's existing protected environment. Preserve its allowed branches, required reviewers and existing deployment identity checks. Do not create a replacement environment to avoid a restriction.

`release-runs-on` and optional `suites-runs-on` are JSON GitHub runner specifications, accepting a label array or runner-group object. Omit `suites-runs-on` to use the workflow's deployment-runner default; reserve `ci-ops` for short API and observation jobs. Native SQLite/browser prerequisites, QA leases and host credential capabilities remain app-owned admission requirements. The suite runner also hosts the light failure-reporting job; the shared workflow never selects a hosted runner for a private app.

The native preflight retains the app's package manager. pnpm setup runs only for a caller with its root `pnpm-lock.yaml`; npm callers keep their existing frozen npm commands.

`node-version-file` defaults to the app's `.nvmrc`. Preserve that owner rather than migrating its runtime during adoption. The YAML owns timeout defaults; use overrides only for the existing app's measured bounds.

`release-env` carries only the public native settings explicitly allowed by the workflow. Credentials must never be placed in inputs. The named optional secrets in `workflow_call.secrets` are the accepted credential interface; pass only the existing secrets the app needs. Never use `secrets: inherit` or serialize all caller secrets.

GitHub environment secrets remain authoritative: a same-name secret in the selected environment takes precedence over a passed secret. Missing optional secret variables are removed from the native subprocess environment, preserving native file, Worker-secret and other supported fallback behavior. Their values are never logged by the wrapper.

The caller must allow `contents: read`, `actions: read` and `issues: write`. The release job uses content, action and issue reads to inspect private release receipts; suites have only content reads, and only the failure-reporting job receives issue writes. No deployment, package, pull-request or administration write permission is required by the shared workflow. An app command needing more authority needs explicit owner review rather than a broader inherited token.

Keep caller triggers and runtime path filters in the thin caller. This workflow accepts only default-branch production pushes/manual requests and explicit `v*` tags whose source is merged into the default branch. It does not implement a preview or generic dry-run surface. Preserve an existing native dry-run contract explicitly before replacing a caller that has one; a command that ignores a dry-run flag cannot be made safe by setting that flag here.

## Source, artifact and writer invariants

The checkout is the immutable `github.sha`, with full history and no persisted credentials. The source guard uses the tracking ref populated by checkout; it does not issue an unauthenticated second fetch in private repositories. The native release retains its supported authenticated fresh-source and served-ancestry barrier. Only a successfully validated source may reach the later suites or failure-reporting job; rejecting an event, branch or ancestry must not execute its test code on a self-hosted runner.

Do not require the candidate to equal a mutable default-branch tip after verification. A later docs merge must not strand a verified forward release. Refuse actual source rewinds against the served release through the native owner's existing barrier.

The repository-scoped `deploy-production` group serializes only the release job and never cancels an active writer. Existing deployment paths must use the same group until migration is complete, then the obsolete writer is removed. Post-release suites do not hold the production lock.

There is no reinstall or rebuild between preflight and native release. Keep native credentialed startup checks ahead of migrations, even when those checks need Cloudflare credentials and therefore belong inside `release-command`. Keep account, database, bucket, rollout and service-key checks in their existing owner. Do not substitute a generic Cloudflare deployment for an app's release command.

For the maintained signoff CLI, classify the existing config steps and use `--source head --phase release --keep-workspace --json <report>`. Set `signoff-report` to that report path, relative to the caller checkout or absolute. The shared workflow requires a passing release-phase report for the exact clean source and verifies the retained workspace's HEAD and common Git repository before running the native release from it. This is a same-job handoff of the verified artifact; a second install or rebuild is not equivalent. A partial release report cannot attest a full merge signoff. The phase API must be published before a caller adopts it.

An empty `signoff-report` retains the native in-place preflight contract. For retained workspaces, give the CLI a unique job-scoped `--cache-dir` under the workflow scratch directory; a shared cache can retire idle trees during another run. After native release and diagnostic retention, use the signoff owner's exported `pruneSignoffCache(jobCache, {maxAgeMs: 0, maxBytes: 0})` lifecycle. Immediate cleanup must never target a shared cache; active leases fail closed. This export, unique cache ownership and a finally cleanup path must be proven before activation. The shared workflow does not remove source worktrees or invent a cleanup command.

Migrations remain additive. A failed post-deploy canary may restore a compatible previously served artifact and its associated cron or multi-Worker state through the native release path. It never reverts merged source or rolls back a database. If a previous artifact is incompatible, the native owner must fail closed and fix forward.

## Native outputs and honest qualification

The existing release command writes explicit fields to `GITHUB_OUTPUT`:

| Output | Meaning |
| --- | --- |
| `deployed` | `true` when a physical deployment occurred; `false` only for a native verified safe no-op such as an already-served release. Missing means unknown and cannot pass qualification. This may remain `true` when a later canary fails or recovery runs. |
| `qualified-served-sha` | The full candidate SHA, emitted only after the native served-revision and required smoke/canary checks pass. Do not echo the checkout SHA after an unknown result or no-op. |
| `served-at` | Optional authoritative timestamp from the native served observation. Missing stays unknown. |
| `recovery` | Optional native recovery outcome. Missing stays unknown; do not infer successful rollback from a failed release command. |

The shared workflow validates `qualified-served-sha` against the immutable candidate only after `release-command` exits successfully and reports a physical deployment. A nonzero native exit cannot qualify the candidate even if a physical deployment output was already written. A safe no-op is not counted as a new served release.

Existing commands must adapt these output semantics explicitly before switching their caller. A wrapper that unconditionally echoes `deployed=true` or a candidate SHA after running an old command is not a qualified adapter.

The workflow returns source, deployment, qualified served SHA and separate release/suite phase results. Its sanitized artifact preserves physical deployment, native served time, recovery and qualification independently. It does not collect credentials, reconstruct billing or infer served time from job completion. `qualifiedAt` is a later qualification observation, never an alias for `servedAt`.

Keep each app's existing sanitized native canary diagnostics and release receipt, written under `RELEASE_EVIDENCE_DIR` so the workflow uploads them with its receipt: a release runner's home does not outlive its job. The generic receipt supplements their provenance; it must not replace native evidence or silently erase a partial mutation.

## Failure reporting and measurements

A release or post-release suite failure files or appends to the existing rolling safety-net issue. A red post-release suite does not undo a healthy deployment. Its fix goes forward through the existing source owner. Cancellation, skipped qualification, unknown native outputs and no-op are distinct outcomes.

Use release-phase and native served evidence for deploy-success rates; the aggregate workflow conclusion can be red solely because a later suite failed. Keep terminal production requests, cancellations, preflight failures, no-ops and still-running requests separately visible, with the denominator stated.

Measure merge-to-served latency by joining authoritative merge timestamps for newly served commits to the native served timestamp. Missing timestamps stay unknown. Source pins do not establish served SDK identity or pin lag: reuse the existing adoption/fleet inventory and authoritative registry timestamp.

Count actual workflow deletions minus additions across the shared owner and every adopted caller. Moving provider logic to its native owner is not equivalent to deleting that logic. A prototype or a source merge is not rollout evidence.

## Adoption proof

Before removing an app's old workflow, prove the adapter through its existing admitted runner and environment:

1. Full exact-source merge verification remains intact, including every moved test population.
2. Release preflight runs the required non-suite commands and prepares the exact artifact the native release consumes.
3. Native startup, additive migrations, served identity and canary/smoke retain their existing authority; failure recovery restores and verifies compatible artifact state.
4. A safe no-op and an unknown/failed native output cannot become a qualified deployment.
5. Post-release suites cover the same full population and report failure through the rolling issue without blocking the production writer.
6. Private checkout, environment secrets, explicit credential maps, runner-group admission, diagnostics retention and existing dry-run behavior are accounted for.

A static YAML check does not prove any of these runtime outcomes. Deploy, served and suite proof remain separate from source review.

## Component catalog placement

[component-catalog.yml](../.github/workflows/component-catalog.yml) retains the catalog's main-branch input path filter and manual dispatch. Storybook configuration, package source, generated templates, build/toolchain configuration and the two catalog workflow files trigger publication; unrelated documentation and test-only pushes do not.

The credential-free build, full post-release signoff and suite-failure reporter in [deploy-catalog.yml](../.github/workflows/deploy-catalog.yml) run on GitHub-hosted Ubuntu for this public repository. Build and suites retain content reads; only the reporter receives issue writes. The caller's pinned deployment workflow keeps the existing production runner, Cloudflare credential boundary and immutable artifact verification. Build, immutable Pages deployment and post-release suites remain ordered; a red later suite reports an issue without blocking the completed deployment.
