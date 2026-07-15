# CUSTOMIZE.md — fill this project, in order

This is the trail. Walk it top to bottom. Each step is a checklist item paired
with the DISCOVERY QUESTION it answers — answer the question, then make the
edit. The whole job is filling `agent.config.ts` + `prompts/system.md` (DATA)
and wiring credentials; the chat vertical itself is already assembled and
proven by the e2e test.

When every box is checked and `pnpm typecheck && pnpm test` are green and a
message round-trips on `pnpm dev`, the app is customized.

---

## ① Identity — `agent.config.ts` + `prompts/system.md`

Discovery: **Whose job does this agent do, in whose voice, under what hard rules?**

- [ ] Set `name` in `agent.config.ts` to the product/agent name.
- [ ] Rewrite `prompts/system.md` as the real persona: role + voice + remit +
      hard rules. State intents, never implementations (no commands, no tool
      scripts — the sandboxed agent picks its own tools).
- [ ] Keep the grounding rule (never fabricate; cite a record or NOT ON FILE).

## ② Model + harness — `agent.config.ts` → `model`, `harness`

Discovery: **Which model answers by default, at what effort, on which harness?**

- [ ] Set `model.default` to a model your Tangle Router key can reach.
- [ ] Pick `harness` (`opencode` default; vendor-locked harnesses like
      `claude-code` must pair with their own provider's models).
- [ ] Leave per-turn overrides alone — the client can send `model`/`effort`
      per request and `MODEL_NAME` overrides without a redeploy.

## ③ Infrastructure — `wrangler.toml` + `.dev.vars` + `migrations/`

Discovery: **Where does this app live and what may it spend?**

- [ ] `wrangler d1 create <name>` → paste `database_id` into `wrangler.toml`.
- [ ] Copy `.dev.vars.example` → `.dev.vars`; fill `BETTER_AUTH_SECRET`,
      `TANGLE_API_KEY`, `SANDBOX_API_KEY`, `SANDBOX_GATEWAY_URL`.
- [ ] `pnpm db:migrate:local` — applies `migrations/0001_init.sql` (auth +
      chat + turn buffer). The e2e test executes this same file, so it cannot
      silently drift from the schema.
- [ ] R2 stays commented out unless the product stores artifacts.

## ④ Prove the loop — `pnpm dev`

Discovery: **Does a real message round-trip through a real box?**

- [ ] `pnpm dev`, open http://localhost:8787, sign up, send a message.
- [ ] Confirm: streamed text renders live, the transcript reloads with parts
      and a usage receipt, and a second turn continues the same agent session.
- [ ] Kill the tab mid-turn, reopen the thread — the persisted row is intact
      (the turn keeps running server-side and buffers for replay).

## ⑤ The product UI — replace the dev page

Discovery: **What does the real surface look like?**

- [ ] `public/index.html` is the dev harness, not the product. Build the real
      surface in React on `@tangle-network/agent-app/web-react`:
      `ChatComposer` (`onSendParts` + `onAttach`), `ChatMessages`,
      `streamChatTurn` (start + resume against `/api/chat/replay/:turnId`),
      `useChatInteractions` + `InteractionQuestionCard`/`InteractionPlanCard`
      for the ask channel this server already exposes.
- [ ] Keep the wire contract: `chatTurnRequestInit` from web-react serializes
      exactly what `createChatTurnRoutes` parses.

## ⑥ Extend, don't fork

Discovery: **What does this product add beyond the vertical?**

- [ ] Billing/audit/titles → `onTurnComplete` seam in `src/chat.ts`.
- [ ] PII scrubbing before persistence → `transformFinalText` +
      `@tangle-network/agent-app/redact`.
- [ ] Structured agent writes (proposals, records) → the shell's `/tools`
      side channel, never prose parsing.
- [ ] Multi-user teams → `@tangle-network/agent-app/teams` and pass your
      workspace table to `createChatTables({ workspaceTable })` (new migration).

## ⑦ Verify

Discovery: **Does the customized app hold its contract?**

- [ ] `pnpm typecheck` — clean.
- [ ] `pnpm test` — green (the e2e turn gate + fail-closed auth).
- [ ] `pnpm dev` — a real turn round-trips end to end.
- [ ] `pnpm deploy` + `pnpm db:migrate` when it's real.
