# Customize a chat agent-app

This project composes the shared chat application shell from `@tangle-network/agent-app`.
Read [CUSTOMIZE.md](CUSTOMIZE.md) for required configuration and deployment setup.

For UI changes, read the canonical [product surfaces guide](https://github.com/tangle-network/agent-app/blob/main/docs/product-surfaces.md).
Reports, dashboards, admin pages, and record lists start with its [operational-page compositions](https://github.com/tangle-network/agent-app/blob/main/docs/product-surfaces.md#operational-pages).

## DATA vs CODE

- `agent.config.ts` contains identity, prompt, model, backend, and renderable interaction choices as plain values.
- `prompts/system.md` supplies domain intent and evidence requirements.
  State desired behavior; let the executing agent choose tools instead of embedding command or installation scripts.
- `src/chat.ts` composes the shell's authentication, persistence, streaming, upload, and interaction factories.
- `src/sandbox.ts` resolves sandbox access and profiles; domain reasoning belongs in the agent.
- `src/worker.ts` routes requests to those handlers.
- `migrations/` must match the persisted schema; the generated application's tests execute the real migration.
- `web/` composes the maintained React workspace from public package paths, with real auth, navigation, History, and chat callbacks.

Extend supported configuration and callbacks before duplicating a shell mechanism or forking the package.

## Required boundaries

Derive user and workspace identity from the authenticated session, never request bodies or model output.
An inaccessible thread returns 404 without disclosing that it exists.
Missing sandbox credentials produce an explicit failure, never a canned agent response.
Agents own reasoning and tools; the application owns durable records, billing, and approval enforcement.
Agent writes use schema-validated tools rather than records parsed from prose.
Preserve the persona's fabrication rule: a real record or an explicit "NOT ON FILE" outcome.

Keep the maintained `AgentWorkspaceLayout`, session rail, History, composer, and message surfaces.
Do not add a parallel primitive library, token palette, sidebar, or picker.
Use only public package imports in `web/`; never import the server config or a repository source alias.
Keep `/?threadId=...` links and `/api/*` and `/v1/*` routes stable.
Do not add a transcript title row or a fabricated connection indicator.
Omit controls without real product data and callbacks.
The upload adapter preserves inline/sandbox `parts`; it is not the store-backed attachment contract.
Keep browser DOM types separate from Worker types and scan installed UI package classes in the CSS build.

## Verification

Run `pnpm build` and `pnpm test`.
The turn test uses real migrations and shell factories with a fake sandbox event feed; it does not prove live sandbox access.
The parent repository's fresh packed-generation gate also runs a local Worker/D1 browser proof.
That proof checks real auth and thread persistence across a Worker restart, but makes no model request.
For deployment, complete environment configuration, apply the required database migrations, and exercise the actual page and turn flow.
Record hosted/model/disconnect proofs separately; do not claim them from compilation or an injected producer.
Fix failures without weakening the protected behavior.
