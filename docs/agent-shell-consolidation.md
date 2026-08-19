# Agent Shell Consolidation — One Shell, Five Thin Domain Seams

Staff architecture doc. Status: proposal. Owner: agent-app maintainers. Consumers: gtm / creative / tax / legal / insurance.

---

## 1. TL;DR + the problem

**One sentence:** Every product re-hand-rolls the same ~3,000 lines of agent-shell plumbing (sandbox provisioning, skill mount, profile assembly, model resolution, prompt assembly); we lift that plumbing into `@tangle-network/agent-app` once, and each product collapses to a single `defineAgentProfile({...})` data object plus a thin runtime-config — because the domain seam the shell consumes is **already** the sandbox SDK's `AgentProfile` type, not a new invented shape.

For the browser surface, the same rule now applies to the chat-first workspace:
use `@tangle-network/agent-app/workspace-react` for the outer layout and session
rail, `EntryComposer` from `@tangle-network/agent-app/web-react` for the
new-session composer, and the same subpath for the full history view.
Products keep their navigation taxonomy, routes, storage, and domain content.
Workflow-first and queue-first products may omit the session rail when it would
conflict with the product's primary job.

**The duplication, measured (from the maps):**

| Concern | gtm | creative | tax | legal | insurance | Status across fleet |
|---|---|---|---|---|---|---|
| sandbox `ensureWorkspaceSandbox` + provisioning | `sandbox/index.ts` 805 L | `sandbox/index.ts` **1474 L** | `sandbox-service.ts` 386 L | `sandbox/index.ts` 595 L | `sandbox/index.ts` ~560 L | same export shape, copied 5× |
| `model-resolution.ts` | 181 L | `chat/model-resolution.ts` 104 L | 123 L (**byte-identical dupe** in `packages/api-worker`) | 117 L | 115 L | "nearly identical" / "diff -q IDENTICAL" |
| dual-path corpus loader (Vite `?raw` glob / fs fallback) | `skills.ts`+`doctrine.ts`+`profile.ts` (3×) | `skill-mounts.ts`+`agent-prompt` | `buildKnowledgeFileMounts` | appears **3× in one repo** (`agent-profile.ts`,`profile.ts`,`loader.ts`) | `agent-profile.ts:50-117` | same pattern, 12+ copies fleet-wide |
| `buildDelegationMcpServer` wrapper | imports lifted `/delegation` | **hand-rolled inline** `index.ts:152-184` | n/a | imports `/delegation` | imports `/delegation` | creative behind; "prime lift candidate" |
| app-tool MCP assembly | `app-tool-runtime.ts` 183 L (defers to `frameworkAppToolMcp`) | **2345 L** hand-rolled | inline in `chat-turn.ts` | `buildAppToolMcpServers` | inline | creative is **12.8×** gtm's size for the same job |
| `composeProductionAgentProfile` (base profile + delegation MCP + extraFiles + extraMcp merge) | `sandbox/index.ts:139-173` | inline `buildPromptBackend` | `mergeAgentProfiles` in `chat-turn.ts:509` | `mergeAgentProfiles` `index.ts:498` | `mergeAgentProfiles` `index.ts:453` | every sandbox product re-merges by hand |

**The cost of the copies (not just LOC):** drift. Three confirmed instances already:
- **tax:** the eval harness scores `packages/api-worker/.../agent-profile.ts`, which **diverged 58 lines** from the deployed `apps/web` copy (missing the human-prose skill mount commit `d60a8dd` added only to prod). Nightly evals grade a profile users never get.
- **creative `sandbox/index.ts` is 1474 L vs gtm's 805** not because it's structurally heavier but because it's **behind on the lift** — measured causes: delegation inline, 2345-L hand-rolled app-tool layer, inline crypto/snapshot helpers. Of 65 top-level decls only 6 overlap gtm — gtm already pushed the rest into agent-app subpaths.
- **model defaults:** tax has **three** sources of truth (`agent-profile.ts` `claude-code/sonnet`, `model-resolution` `gemini-2.5-flash-lite`, wrangler `MODEL_NAME`).

Five teams each maintain, debug, and re-secure the same provisioning lifecycle, the same capability-token mint, the same dual-path loader. A fix to one (e.g. severed-stream detection, which creative has in `model-backend.ts` and nobody else does) does not propagate.

---

## 2. What agent-app already provides vs the GAP

agent-app today is **rich** but it ships the **pieces and seams**, not the **end-to-end sandbox shell function**. The five concerns each product re-hand-rolls map exactly to agent-app's own `missing` list.

**Already lifted (consume, don't rebuild):**
- chat tool-loop + SSE/OpenAI-compat normalization — `/runtime` `runAppToolLoop`/`streamAppToolLoop`/`createOpenAICompatStreamTurn` (`dist/runtime/index.d.ts:3,82`)
- turn-event persistence + replay — `/stream` `createD1TurnEventStore`, `pumpBufferedTurn`, `replayTurnEvents` (`dist/index.d.ts:16`)
- **endpoint** model-config resolution from env — `/runtime` `resolveTangleModelConfig`, `createTangleRouterModelConfig` (`dist/model-CKzniMMr.d.ts:108`)
- model catalog — `/runtime` `fetchModelCatalog`, `buildCatalog`, `normalizeModelId` (`dist/model-catalog-BEAEVDaa.d.ts`)
- capability auth + app-tool MCP — `/tools` `createCapabilityToken`, `buildAppToolMcpServer`, `frameworkAppToolMcp`, `authenticateToolRequest(verifyToken seam)` (`dist/tools/index.d.ts:2,41`)
- delegation MCP — `/delegation` `buildDelegationMcpServer`, `delegationMcpForConfig` (kept "structural here so this package needs no sandbox-SDK dependency", `dist/delegation/index.d.ts:13`)
- harness coercion — `/harness` `coerceHarness`, `resolveSessionHarness`
- billing, integration-hub proxy, SSO, field-crypto, surface overlay, missions, certified-delivery — `/billing`, `/platform`, `/crypto`, `/runtime` `mergeSurfaceOverlay`/`createCertifiedDelivery`

**The GAP — five core-loop concerns with ZERO export (from agent-app's `missing`):**
1. **Skill registry + `~/.claude/skills` mount.** `grep dist for skillRegistry/mountSkill = ZERO` (only a doc-comment at `src/eval-campaign/index.ts:24`). Certified delivery *folds* a delivered skill into the prompt but does not **enumerate a skills directory**. → gtm `agent-prompt/skills.ts:32-70`, legal `loader.ts:41-80`, insurance `buildSkillFileMounts`.
2. **Agent profile assembly** for the sandbox path. No export builds the SDK `AgentProfile` from parts. agent-app ships `ResolvedAgentProfile{systemPrompt,extraTools}` (in-process only, `dist/runtime/index.d.ts:133`) + the `composeProfile` transform + `mergeSurfaceOverlay`, but **not** the sandbox `AgentProfile` composer. → gtm `composeProductionAgentProfile()` `sandbox/index.ts:139-173`.
3. **Sandbox provisioning.** agent-app imports **no** `@tangle-network/sandbox`, exports no `createSandbox`/`getOrCreate`/per-workspace lifecycle. → gtm `ensureWorkspaceSandbox()` `sandbox/index.ts:368-508`.
4. **Per-turn model resolution** (which model this turn: request>workspace>env>default, allowlist gate, catalog validation, bare-suffix→canonical). agent-app resolves the **endpoint** config and offers catalog lookup, but **picks no model**. → 5 near-identical `model-resolution.ts`.
5. **System-prompt assembly** from identity + fragments + skills + workspace/history. agent-app holds persona **data** + a `systemPrompt` string field + the certified-append transform, but **no** assembler. → gtm `buildSystemPrompt()` `build-prompt.ts:68-146`.

**Why these belong in the shell (layering rule, `build-agent-app SKILL.md:26-32`):** a capability that makes sense *without* this app's side-channel/approval-queue/chat-route = ENGINE (peer-dep). Otherwise = SHELL. The product's nouns/prompts/schema/taxonomy = DOMAIN, injected through seams. All five gaps are pure provisioning/assembly mechanics with no domain content → SHELL.

---

## 3. Target architecture — the shell is a function of `AgentProfile`

**The critical constraint (confirmed against the SDK):** the domain seam a product supplies is **not a new invented shape**. It is the sandbox SDK type `AgentProfile` (`@tangle-network/sandbox` `dist/sandbox-Dyf07Ckv.d.ts:190`, built via `defineAgentProfile`, merged via `mergeAgentProfiles`). Verified — `AgentProfile` already carries **every** seam field:

| Shell concern needs… | `AgentProfile` field (verified line) |
|---|---|
| system prompt base | `prompt.systemPrompt` / `prompt.instructions[]` (`:111-119`) |
| model hints (default/small) | `model.default` / `model.small` / `model.provider` (`:90-107`) |
| permission posture | `permissions: Record<string, "allow"\|"ask"\|"deny">` (`:197`, `:12`) |
| tool roster | `tools: Record<string, boolean>` (`:198`) |
| MCP capability surface | `mcp: Record<string, AgentProfileMcpServer>` (`:199`, `:176`) |
| **specialists / subagents** | `subagents: Record<string, AgentSubagentProfile>` (`:200`, `:124` — carries `prompt`/`model`/`tools`/`permissions`/`metadata`) |
| **skills + knowledge corpus** | `resources.files: AgentProfileFileMount[]` + `resources.skills` (`:55-69`) |
| harness hooks | `hooks: Record<string, AgentProfileHookCommand[]>` (`:202`) |
| reasoning-effort / backend extras | `extensions: Record<string, Record<string,unknown>>` (`:212`) |
| eval-serializable identity | the whole object is plain JSON (`name`/`description`/`version`/`tags`/`metadata`) |

So the shell **is**:

```
shell(profile: AgentProfile, runtimeConfig: ShellRuntimeConfig)
  -> provisioned sandbox
   + resources.files materialized at ~/.claude/skills/<id>/SKILL.md and corpus paths
   + assembled system prompt (profile.prompt + per-turn augmentation)
   + resolved per-turn model (profile.model + request/workspace/env precedence)
   + driven chat turn (box.streamPrompt + normalized events)
```

**DO NOT** introduce a parallel `{systemPrompt, tools, knowledge, skills, modelHints}` seam. Each maps onto an existing `AgentProfile` field:
- skills + knowledge → `resources.files` (skills at `~/.claude/skills/<id>/SKILL.md`; corpus at its own paths)
- specialists → `subagents`
- model hints → `model`
- tools → `tools` / `mcp`
- permissions → `permissions`

**What a product becomes (~10 lines + a config object).** The product owns one `defineAgentProfile` (DOMAIN data) and a thin `ShellRuntimeConfig` (the per-product seam *values* — env keys, header names, defaults, R2 prefix, name prefix). Everything else is shell.

```ts
// product/agent-profile.ts — DOMAIN data, the only thing the team authors
export const gtmAgentProfile = defineAgentProfile({
  name: 'gtm-operator',
  prompt:   { systemPrompt: OPERATOR_CEO_SYSTEM_PROMPT },     // domain corpus
  model:    { default: DEFAULT_ROUTER_MODEL, small: 'kimi-code/k2.6' },
  permissions: GTM_PERMISSIONS,                                // crm:read, pricing:change:ask…
  tools:    GTM_TOOLS,                                         // gtm-seo-check, gtm-generate-ad…
  mcp:      GTM_MCP_SERVERS,                                   // hubspot-crm, copy-generator…
  subagents: GTM_SUBAGENTS,                                    // ICP/compete/pricing micros
  resources: { files: composeShellResources({                 // SHELL helper, see §4.1
    skills:   './agent-prompt/skills/*/SKILL.md',             // corpus glob → ~/.claude/skills
    knowledge: './agent-prompt/doctrine/*.md',
    evolvable: './self-improve/evolved-addendum.md',          // the one self-improve section
  }) },
})

// product/shell-config.ts — the thin runtime seam (values, not logic)
export const gtmShell: ShellRuntimeConfig = {
  profile: gtmAgentProfile,
  namePrefix: 'gtm-',
  envSeam: { GTM_WORKSPACE_ID, GTM_INTEGRATION_INVOKE_URL, PHONY_BASE_URL },
  headerNames: GTM_HEADER_NAMES, taxonomy: GTM_TAXONOMY, verifyToken: gtmVerifyToken,
  modelDefaults: { router: DEFAULT_ROUTER_MODEL, sandbox: DEFAULT_SANDBOX_OPENAI_MODEL },
  appToolHandlers: gtmAppToolHandlers,                         // D1/vault writes (domain)
  snapshotR2Prefix: 'gtm/', tokenBinding: 'workspace',         // workspace- not user-bound
}
```

```ts
// product/routes/api.chat.ts — wiring, identical across products
const sandbox = await ensureWorkspaceSandbox(gtmShell, { workspaceId, userId })
const model   = resolveChatModel(gtmShell, { request, workspace, env })
const prompt  = assembleSystemPrompt(gtmShell, { workspace, history, augment: buildGtmAugment(ctx) })
return streamSandboxPrompt(gtmShell, { sandbox, model, prompt, message, history })
```

`ShellRuntimeConfig` is the **only** new type. Its fields are seam *values* (env keys, prefixes, defaults, header names) and a small set of injected behavior closures the layering rule already names: `appToolHandlers` (persist to product store), `verifyToken`, `augment` (per-turn prompt policy), `getUserApiKey`. These match the existing seam styles in the map: `AppToolHandlers`, the `verifyToken` seam in `authenticateToolRequest` (`dist/tools/index.d.ts:23`), `getUserApiKey` for `resolveUserTangleExecutionKeyForUser` (`dist/model-CKzniMMr.d.ts:39`).

---

## 4. Per-concern lift plan (dependency order)

Order is by duplication-× and risk: highest-dup + just-exercised first, deepest-coupling last. Each concern ships as an **additive agent-app subpath** (no consumer break until the product opts in by deleting its shim).

### 4.1 Skill registry + `~/.claude/skills` mount — FIRST

**Why first:** highest duplication (12+ copies of the dual-path loader fleet-wide), just exercised (insurance `29dfe82` added the cleanest template; tax `d60a8dd` exposed the drift cost), and a clean leaf with no upstream dependency.

**What lifts** (new subpath `@tangle-network/agent-app/skills`):
- `loadMarkdownCorpus(globPattern)` — the **one** dual-path loader: Vite `import.meta.glob('?raw', eager)` → Node `fs.readdir`/`createRequire` fallback. Collapses gtm `skills.ts:32-70` + `doctrine.ts:16-51` + `profile.ts:119-154`, legal's **3** copies (`agent-profile.ts:49-84`, `profile.ts:88-113`, `loader.ts:41-80`), insurance `agent-profile.ts:50-85`, tax `buildKnowledgeFileMounts`. The literal string `import.meta.glob` must be preserved verbatim for Vite static analysis (gtm `skills.ts:33`).
- `composeShellResources({ skills, knowledge, evolvable, predicate })` → `AgentProfileFileMount[]`, projecting SKILL.md folders onto `resources.files` at `~/.claude/skills/<id>/SKILL.md` (the SDK materializes them before the harness runs).
- `SkillEntry` registry type + `skillMountPath()` (lift insurance `skill-registry.ts:16-31` verbatim — already the template shape) with **two adapters**: `corpusSkills` (always-mounted) and `registrySkills(tier)` (tier-gated installable, gtm's 813-L marketplace / legal's 14-entry registry).

**The seam:** a `predicate` + `skipList` (insurance `:106` `/universal|playbooks|markets/`; tax skip list), and the *content* of every SKILL.md (domain). The registry's `category` enum is domain taxonomy.

**Thin shim that stays in product:** the glob path constants and the registry array. ~5 lines.

**Two-skill-systems invariant (do not conflate):** the shell must support BOTH (a) always-mounted **knowledge corpus** (`loadSkills`→prompt/sandbox) and (b) tier-gated **marketplace registry** (`SKILL_REGISTRY`→`/api/skills` on-demand). gtm has both; creative/legal/insurance have the corpus + on-disk-prompt split; insurance is the reference for the file-mount adapter, gtm for the registry adapter. Both ride `resources.files` through the same channel.

### 4.2 Profile assembly — SECOND

**What lifts** (`@tangle-network/agent-app/profile` or extend `/config`):
- `composeProductionAgentProfile(base: AgentProfile, { delegationMcp, extraFiles, extraMcp, systemPrompt })` → `AgentProfile`. Generic version of gtm `sandbox/index.ts:139-173`. Built on the SDK's own `mergeAgentProfiles` (`sandbox-Dyf07Ckv.d.ts:268`) — collision-guarded MCP merge (gtm `:637`), file-mount concat, prompt override. tax/legal/insurance already call `mergeAgentProfiles` directly; this wraps the common merge order.
- The **evolvable-section** seam: one `resources.files` entry (or one prompt section) wired to a markdown override (`evolved-addendum.md`) that the offline self-improve loop patches and prod renders from the SAME artifact — the `prod==eval==self-improve` invariant. This rides the agent-eval `profile.*` namespace (`baselineProfile`/`prodProfile`/`renderProfile`) that tax/legal/insurance already consume; gtm consumes it via `lib/gtm/profile.ts`. Shell exposes "one evolvable domain section wired to a file."

**The seam:** the `base` profile (domain) and which section is `evolvable: true` (`LEARNED_GUIDANCE_SECTION_ID`).

**Thin shim:** none beyond the profile object itself.

### 4.3 Sandbox provisioning — THIRD

**What lifts** (`@tangle-network/agent-app/sandbox` — the one subpath that takes a `@tangle-network/sandbox` peer-dep):
- `ensureWorkspaceSandbox(shell, { workspaceId, userId })` — provisioning core: list-running → reuse-by-harness-match → recreate-on-harness-mismatch (gtm `:380-409`), `create()`/`waitFor('running')`/`refresh()` (gtm `:457-507`), capability-token env injection, `backend.profile`/`backend.model` binding. Identical shape in all five (legal `:168-332`, insurance `:92-264`, tax `sandbox-service.ts:304-361`, creative `:362-510`).
- `getClient()` + credential-fingerprint cache (gtm/creative/legal/insurance all have it).
- `buildAppToolMcpServers()` loop over `frameworkAppToolMcp` (gtm `:184-236` — the keyed-HTTP-MCP-from-table pattern; creative's 2345-L hand-roll deletes here).
- `streamSandboxPrompt(shell, {...})` driver: provider resolution, history flatten, collision-guarded MCP merge (gtm `:636`), reasoning-effort via `profile.extensions[harness]` (gtm `:658-675`), `box.streamPrompt`. Lift creative's **severed-stream + model-call-failure classifiers** (`model-backend.ts` `detectSandboxModelCallFailure`/`SandboxModelStreamSeveredError`) as a shell default — it's product-agnostic harness-shape knowledge nobody else has.
- R2 snapshot lifecycle (creative `:831-899`, legal/insurance BYOS3 blocks), HMAC terminal-proxy token mint/verify + base64/constant-time helpers (creative `:758-818`) — pure utility shell.
- `cancelWorkspaceRun`, `runSandboxPrompt` (non-streaming collect), `readSandboxFile`/`listSandboxFiles`.

**The seam (`ShellRuntimeConfig`):** `namePrefix` (`gtm-`/`ins-s11-`/`creative-`), the env block (`GTM_*`/`INSURANCE_*`/`BAD_*`), R2 bucket/prefix, the SET of tools installed + toolkit install command (tax's `apk-add python3 PyMuPDF`, creative's ~20 film tools), `tokenBinding: 'workspace'|'user'`.

**Thin shim:** none — the shim collapses into config values.

### 4.4 Model resolution — FOURTH

**What lifts** (`@tangle-network/agent-app/model-resolution`):
- `resolveChatModel(shell, { request, workspace, env })` — precedence (request > workspace > env:`TANGLE_ROUTER_MODEL` > default), `validateChatModelId` fail-closed against the live catalog with well-formed-id guard, `cleanModelId`/`catalogIdsForModel`, bare-suffix→canonical uniqueness. This is the canonical module the audit names; tax has a **byte-identical** dupe across two packages, legal/insurance/creative are near-identical. Built on already-lifted `fetchModelCatalog`/`normalizeModelId`.

**The seam:** `modelDefaults` only (gtm `DEFAULT_ROUTER_MODEL`/`DEFAULT_SANDBOX_OPENAI_MODEL`, others `gemini-2.5-flash-lite`). **This collapses tax's 3 sources of truth to one** — the shell reads `profile.model.default` as the single default, and `ShellRuntimeConfig.modelDefaults` overrides per backend.

**Thin shim:** delete the file; pass defaults in config.

### 4.5 Prompt assembly — FIFTH (deepest domain coupling)

**What lifts** (`@tangle-network/agent-app/prompt`):
- `assembleSystemPrompt(shell, { workspace, history, augment })` — the **skeleton**: base `profile.prompt.systemPrompt` + `renderSkillsSection()` (§4.1) + workspace/history/confidence context + the injected `augment` block. Generic version of gtm `build-prompt.ts:68-146`.

**The seam:** `augment` — a product closure returning the per-turn augmentation. This is where **all** domain prompt policy stays: gtm's approval-confidence + recent-rejections + learned-style + `OPERATING_DIRECTIVE` (`build-prompt.ts:51-228`), creative's mission/media directives + `buildArtifactSection` (`:154-369`), legal's Document-Review-Loop + entity/deadline/filing DB blocks (`:59-119`), insurance's live-book D1 summary (`:38-95`), tax's tax-review channel. The section *ordering* is shell; every section *body* is domain.

**Thin shim:** the `augment` closure (largest remaining product surface — correctly so; it's domain policy).

---

## 5. Per-product migration notes + outliers the seam must handle

**gtm (reference #1 — closest, already pushed the most into agent-app):**
- Specialists: `GTM_SUBAGENTS` (six micros: ICP/compete/pricing/sales-playbook/pipeline/hiring) ship via `profile.subagents` — already maps to the SDK field. **Delete the dead in-app router** (`specialists/index.ts` `routeMessage`/`buildSpecialistPrompt` — verified zero prod importers; `api.chat.ts` never calls it; only two tests do) OR, if revived, add an optional `routeMessage(message)→subagentId` hook to `ShellRuntimeConfig` the orchestrator calls before `assembleSystemPrompt`. The subagent *definitions* are NOT dead — keep them.
- Intelligence/broker-token: `tokenBinding: 'workspace'` (GTM binds the workspace id in the userId slot via `GTM_HEADER_NAMES`/`createWorkspaceCapabilityToken`). The tool-runtime + `/tangle` seams must accept a **workspace-bound, not user-bound** token model — this is a `ShellRuntimeConfig` flag, not a code fork.
- Two skill systems: corpus (`agent-prompt/skills/*`) + marketplace (`skill-registry.ts`, `/api/skills`) — both ride §4.1 adapters.
- Cleanup on migration: delete empty `agent-prompt/agents/` (.gitkeep) and orphan `hooks/hooks.json` (18 B, no loader).

**legal (reference #2 — closest after gtm):** normalized diff vs gtm = 757 added / 547 removed / 39 modified (gtm superset). Common core (`readWorkspaceHarness`/`buildDelegationMcpServer`/`ensureWorkspaceSandbox`/`buildAppToolMcpServers`/`streamSandboxPrompt`/`runSandboxPrompt`) lifts cleanly; gtm's extras (member-sync, scoped-token mint, integration-secret store, `streamRouterPrompt`) stay as product additions. Outliers: TWO skill stores (14-entry `SKILL_REGISTRY`→sandbox + 8 on-disk SKILL.md→chat prompt) → §4.1 two adapters; filing browser-automation (`irs-ein`/`fincen-boi` inline bash + `bad run` + `BAD_*` env) → arbitrary domain script bundle in `resources.files`; evolvable section via agent-eval `profile.*` → §4.2.

**creative (oversized, behind on lift — biggest single win):** the 1474→~600 L reduction comes free from §4.3 (delete inline `buildDelegationMcpServer` `:152-184`, adopt lifted) + §4.1/§4.3 (delete the 2345-L `app-tool-runtime.ts`, defer to `frameworkAppToolMcp` like gtm) + lift inline crypto/snapshot helpers. **Outlier the seam must handle: design-canvas** — creative is the only consumer of `@tangle-network/agent-app/design-canvas` (+ `/drizzle`, `design-canvas-react`, 9 importers). The shell offers it as an **optional surface module** the way it offers sequences — not in the core shell function. Second outlier: **data-derived subagents** — the channel-specialist fleet is generated from `CHANNEL_TEMPLATES` with brand-truth placeholder substitution, so `profile.subagents` must accept a **generated** map (it already does — it's a plain `Record`). Skill-mount-not-registry: creative has no `skill-registry.ts`; it uses file-mount + prompt-concat — §4.1's two adapters cover this.

**tax (monorepo outlier — sequencing trap):** the deployed surface is `apps/web/src/lib/.server/tax/**`; `packages/api-worker` is **dead as a deploy target but eval-referenced**. **Hard ordering constraint:** repoint `tests/eval/lib/agent-profile-cell.ts:6` + `scorecard-integration.ts:33` off `packages/api-worker/.../agent-profile` and onto the deployed copy (or the lifted shell) **BEFORE** deleting api-worker — otherwise evals keep silently diverging (already happening). Also delete the byte-identical `packages/api-worker/.../model-resolution.ts`. Prompt assembly lives in agent-eval `profile.*` (no `build-prompt.ts`) — §4.2/§4.5 accommodate "render a profile with one evolvable section." Domain corpus is a **non-code data package** (`packages/agent-prompt`, build-time-inlined to `system-prompt.generated.ts` — no runtime FS in Workers); §4.1's loader must support "inline a folder-per-skill corpus, pinned to on-disk SKILL.md by guard tests." Tax-review MCP (`submit_tax_citation`/`propose_form_change`) is the only authoring channel, fail-closed without a token — a per-turn `mergeAgentProfiles` overlay seam. **Migrate tax LAST.**

**insurance (cleanest template for §4.1):** market-pack knowledge corpus (`knowledge/{universal,playbooks,markets/<market>}`) — the loader's `predicate` + `skipList` seam (`:106`) is exactly this; the prompt's "Active market" block selects at render. `buildSkillFileMounts` (commit `29dfe82`) is the reference shape for the lifted §4.1 mount. Proposal taxonomy (`INSURANCE_TAXONOMY` regulated/non-regulated + `X-Insurance-*` headers) — already consumed by `agent-app/tools` as `AppToolTaxonomy`/`ToolHeaderNames`, proving the seam shape works. Constraint: the SAME `insuranceAgentProfile` is the eval substrate input (`toAgentProfileJson`), so the shell's assembly output must stay JSON-serializable — it is (`AgentProfile` is plain data).

**Cross-cutting:** every product's profile is also its eval input (gtm/tax/legal/insurance all feed `agent-profile-cell.ts`). Because the seam IS `AgentProfile` (plain JSON), the shell output is eval-ready by construction — no separate serialization path.

---

## 6. Rollout — additive, flag-gated, live-revenue-safe, no big-bang

**Substrate side (`/substrate-release` loop), one concern per release, each an additive subpath:**
1. `agent-app/skills` (§4.1) — additive, zero consumer breakage.
2. `agent-app/profile` (§4.2).
3. `agent-app/sandbox` (§4.3) — introduces the `@tangle-network/sandbox` peer-dep on this subpath only.
4. `agent-app/model-resolution` (§4.4).
5. `agent-app/prompt` (§4.5).

Additive subpaths mean **no consumer update is forced** by a release (the `/substrate-release` rule: propagate only on breaking change). A product migrates when *it* deletes its shim.

**Consumer side — thin-shim migration, one product at a time, behind each product's existing test suite:**
- Each product keeps its current function names as 1-line re-exports of the lifted shell during cutover (e.g. `export const ensureWorkspaceSandbox = (a,b) => shellEnsureWorkspaceSandbox(gtmShell, …)`), so `vitest`/`playwright` and CI deploy gates run unchanged. Delete the shim only once green.
- **Migration order:** gtm → legal (the two closest shells, common core lifts with smallest delta) → insurance → creative (largest delete, highest payoff, but needs the design-canvas optional-surface seam first) → **tax last** (monorepo + eval-repoint prerequisite).
- **Per-concern within a product:** migrate §4.1 first (leaf, lowest risk), §4.5 last (deepest domain coupling). A product can be half-migrated (skills lifted, prompt still local) indefinitely — the shim boundary makes it safe.

**Live-revenue safety:** gtm/tax/legal/insurance/creative are all on prod domains. Gate every cutover behind the product's existing deploy CI; the shim re-export means a bad lift fails the product's own test suite, not prod. No flag in the LLM path beyond the shim swap. Roll back = revert the shim to its inline body (one commit).

**Reference-shell rationale:** gtm and legal already import `agent-app/{delegation,tools,harness}` and share 100% of the sandbox export shape — they prove the seam against real prod traffic before the harder migrations. tax last because its dead-but-eval-referenced fork is a foot-gun that must be defused first.

---

## 7. Risks + explicitly out-of-scope

**Risks:**
- **Sandbox peer-dep coupling.** `agent-app/sandbox` taking `@tangle-network/sandbox` couples shell releases to SDK releases. Mitigation: confine the dep to that ONE subpath (the rest of agent-app stays sandbox-free, as `/delegation` already is — `dist/delegation/index.d.ts:13`).
- **tax eval divergence during cutover.** If api-worker is deleted before the eval repoint, evals silently grade nothing-real. Mitigation: the §5 hard-ordering constraint, enforced as a CI guard that fails if `agent-profile-cell.ts` imports `packages/api-worker`.
- **Over-generalizing the loader predicate.** insurance's market-pack layout and tax's build-time inlining are structurally different; a too-rigid `loadMarkdownCorpus` re-forks. Mitigation: predicate + skipList + a `mode: 'fs'|'inline'` seam, validated against all 5 before release 1 ships.
- **Severed-stream classifier as a default could mask real errors** if a product's harness emits the same shape benignly. Mitigation: ship it opt-in via `ShellRuntimeConfig.streamFailureClassifier` defaulting to creative's implementation; products can override.
- **Reasoning-effort via `profile.extensions[harness]`** is backend-specific (`extensions` is explicitly "non-portable", `:212`). Keep it a documented extension key, not a portable field.

**Explicitly out-of-scope:**
- The chat tool-loop, SSE normalization, turn persistence, billing, SSO, hub proxy, missions, certified-delivery — **already lifted**, untouched.
- Reviving gtm's dead specialist router (separate decision; the subagent *definitions* migrate, the router does not).
- design-canvas internals (creative-only optional surface; lifted as-is, not redesigned).
- The agent-eval `profile.*` namespace itself (already substrate; the shell consumes it).
- Any change to per-product domain content (prompts, skills, subagent bodies, taxonomies) — these are the seam *values*, deliberately untouched.
- Non-sandbox/edge-copilot shell variants (browser/Workers-only) — the SDK `AgentProfile` seam still applies, but the provisioning subpath (§4.3) is sandbox-specific; edge variants are a follow-on.

---

## 8. Decisions to confirm (Drew)

1. **`ShellRuntimeConfig` home:** new subpath `@tangle-network/agent-app/shell`, or fold the config type into existing `@tangle-network/agent-app/config` (`defineAgentApp`)? The map shows `/config` already owns the declarative DATA contract — folding keeps one config surface but mixes the sandbox-runtime seam into the substrate-free config module. Recommend a separate `/shell` subpath to keep the sandbox peer-dep isolated.
2. **gtm specialist router:** delete the dead in-app router outright (verified zero prod importers), or lift an optional `routeMessage` hook into the shell for a future revival? Deleting is cleaner now; the hook is reversible-but-speculative. Recommend delete + open an issue for the hook if/when the router is wired.
3. **tax api-worker:** confirm the eval-repoint (`agent-profile-cell.ts`/`scorecard-integration.ts` → deployed copy) lands as a standalone PR **before** the tax migration starts — or block the whole tax lift on it? Recommend standalone PR first; it's independently valuable (fixes live eval drift today).
4. **Marketplace registry scope:** is the tier-gated installable catalog (gtm 813-L `SKILL_REGISTRY`, legal 14-entry) in-scope for §4.1's lifted registry, or does only the always-mounted corpus lift first and the marketplace stay product-local for now? Recommend corpus-first (release 1), marketplace adapter as a fast-follow once gtm/legal both consume the corpus path.
5. **Severed-stream classifier default:** ship creative's `detectSandboxModelCallFailure`/`SandboxModelStreamSeveredError` as the shell default (opt-out), or opt-in only? It's the only hardened copy in the fleet; default-on spreads the fix but risks masking a benign shape. Recommend default-on with a documented override.
6. **design-canvas / sequences optional-surface contract:** confirm these stay product-imported optional modules (not part of the core shell function) — i.e. the shell does not gain a "surfaces" registry beyond the existing `defineSurfaceKind`/`createSurfaceRegistry` seam (`dist/runtime/index.d.ts:317`). Recommend yes — reuse the existing surface seam, no new abstraction.
