# CUSTOMIZE.md — fill this project, in order

Customize the agent's data and credentials, then use the generated React
workspace. The server vertical and frontend assembly already exist. Local
injected-producer tests are not a substitute for a live model turn.

## ① Identity — `agent.config.ts` + `prompts/system.md`

Discovery: **Whose job does this agent do, in whose voice, under what hard rules?**

- [ ] Set `name` in `agent.config.ts` and the browser title in `web/index.html`.
- [ ] Rewrite `prompts/system.md` as the real persona: role, voice, remit, and hard rules. State intents, not tool or installation scripts.
- [ ] Keep the grounding rule: never fabricate; cite a record or NOT ON FILE.

## ② Model + harness — `agent.config.ts`

Discovery: **Which real model answers, on which harness?**

- [ ] Set `model.default` to a model your Tangle Router key can reach.
- [ ] Set `gateway.maxProviderInputTokens` to its full input limit, including retained tool and sidecar history.
- [ ] Choose a compatible harness. Vendor-locked harnesses must use their provider's models.
- [ ] Review fallbacks and the optional `MODEL_NAME` environment override.
- [ ] Keep unavailable model, effort, profile, and plan-mode controls hidden. Add a display catalog and real callbacks only when your server can honor them. Resolve prompts, tools, permissions, connections, resources, and backend policy server-side. Profile authoring belongs in settings, not a new composer picker.

The existing per-turn model/effort wire remains available. The template does
not manufacture a browser catalog or silently add a model-selection endpoint.

## ③ Infrastructure — `wrangler.toml` + `.dev.vars` + `migrations/`

Discovery: **Where does this app live and what may it spend?**

- [ ] `wrangler d1 create <name>` and set `database_id` in `wrangler.toml`.
- [ ] Copy `.dev.vars.example` to `.dev.vars`. Set a fresh `BETTER_AUTH_SECRET`, `TANGLE_API_KEY`, `SANDBOX_API_KEY`, and `SANDBOX_GATEWAY_URL`. Never commit credentials.
- [ ] Keep `BETTER_AUTH_URL` equal to the Worker origin. The frontend and API use the same origin and cookies.
- [ ] Run `pnpm db:migrate:local` for auth, chat, turn buffer, API keys, usage, claims, and spending reservations.
- [ ] Upgrading an existing app: apply `0002_agent_gateway.sql` and `0003_gateway_reservations.sql` as needed. Add `sandbox_prewarm_claims` in a new migration. Never edit an already-applied `0001_init.sql`.
- [ ] Keep R2 disabled unless the product needs object storage.

## ④ Build and use the workspace

Discovery: **Does the public-package frontend work on the real Worker origin?**

- [ ] Run `pnpm build`. Worker and DOM typechecks are separate; Vite emits `dist/client`.
- [ ] Run `pnpm exec wrangler deploy --dry-run` to check the Worker bundle without deploying.
- [ ] Run `pnpm dev`, open the Worker origin, sign up, open History, create a conversation, and retain its `?threadId=...` URL.
- [ ] Confirm desktop and mobile navigation, sign-out, fresh login, and reopening a saved thread after a local Worker restart.

Wrangler's custom build runs the same frontend compiler for development and
deployment. Refresh the browser after a rebuild. Do not point assets at source
TSX, add a second auth origin, or introduce an HTML fallback over `/api/*` or
`/v1/*`. `web/styles.css` imports both maintained public stylesheets and scans
the installed Agent App, sandbox-ui, and ui distributions. Keep that standalone
setup; a repository-local Tailwind alias is not a consumer proof.

## ⑤ Extend the product UI, not the primitive family

Discovery: **What product behavior belongs beside the maintained workspace?**

- [ ] Keep `AgentWorkspaceLayout` and the existing full `SessionHistoryPanel`. Do not add a second History surface or a local sidebar.
- [ ] Keep native thread links and real session/auth callbacks in `web/App.tsx`. The server remains authoritative after a reload.
- [ ] Keep the transcript full-space, with no repeated title row.
  Titles belong in History and the document title.
  The shared shell owns the mobile header, navigation drawer, and account menu.
  Do not add a second mobile bar or header inset.
- [ ] Configure `workspaceTools` in `web/workspace-tools.ts` when the product has authorized tool APIs.
  The shared companion supplies tabs, the expander, and remembered selection.
  Keep the list empty until file viewing, terminal connection, or preview is supported.
  The default conversation uses the full available space.
- [ ] Keep `settingsHref={null}` until the product provides Settings.
  Then pass its real route or `onSettingsClick` callback.
- [ ] Keep `ChatComposer`, `ChatMessages`, `streamChatTurn`, and the shared interaction cards. Their current callbacks target the existing routes.
- [ ] Keep the inline/sandbox upload adapter in `web/uploads.ts`. `ChatComposer.onSendParts` matches `/api/chat/upload`; `EntryComposer.uploadUrl` and `useComposerAttachments` expect stored attachment descriptors instead. Do not silently reinterpret those responses or change storage behavior to make a different UI fit.
- [ ] Add uploads, mentions, integrations, profiles, thread mutations, or plan controls only through real supported product contracts. No empty catalogs, placeholder URLs, or no-op callbacks.

For an integration settings surface, reuse `IntegrationsPanel`, `useIntegrations`,
and `ProviderIcon` from sandbox-ui with authorized data and real callbacks.
For a new document or workbench surface, follow the maintained default-workspace
guidance and its page/pane headers rather than creating another layout family.

## ⑥ Prove the real loop and extend through seams

Discovery: **Does a real message round-trip through a real sandbox and survive reload?**

- [ ] Complete a real model turn, inspect streamed text and tools, then reload the persisted transcript, typed parts, and usage. A second turn must continue the same session.
- [ ] Close the tab mid-turn and reopen the thread. Verify actual buffered replay and persisted results on the target deployment. Do not infer this from an empty-thread browser proof.
- [ ] Create a key through `/api/keys`, call `/v1/agents/<slug>/chat/completions`, and open the returned `X-Tangle-Thread-Url`. Finite-cap keys still require backend spending enforcement; the existing remote adapter rejects capped execution before compute.
- [ ] For saved artifacts, verify actual bytes through an authorized product reader. `/api/files` is metadata only, not a download route.

Use `onTurnComplete` in `src/chat.ts` for billing/audit/title extensions and
`transformFinalText` with `/redact` for persistence scrubbing. Structured writes
use schema-validated tools, not prose parsing. Team support uses `/teams` and
`createChatTables({ workspaceTable })` with a new migration.

## ⑦ Record verification honestly

Run `pnpm build` and `pnpm test`. The generated test suite uses real migrations,
auth, routes, persistence, and replay with one fake sandbox producer. The parent
repository's packed gate additionally exercises real local Worker/D1 auth and
thread persistence in Chromium, including a process restart, without model calls.

Record local build, injected-producer, browser/D1, hosted, live-model, and live
reconnect results separately. An unrun hosted/model proof stays unrun. Deploy
and apply remote migrations only after the product is configured and verified.
