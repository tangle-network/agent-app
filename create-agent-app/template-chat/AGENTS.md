# Customize a chat agent-app

This project composes the shared chat application shell from `@tangle-network/agent-app`.
Read [CUSTOMIZE.md](CUSTOMIZE.md) for required configuration and deployment setup.

## DATA vs CODE

- `agent.config.ts` contains identity, prompt, model, backend, and renderable interaction choices as plain values.
- `prompts/system.md` supplies domain intent and evidence requirements.
  State desired behavior; let the executing agent choose tools instead of embedding command or installation scripts.
- `src/chat.ts` composes the shell's authentication, persistence, streaming, upload, and interaction factories.
- `src/sandbox.ts` resolves sandbox access and profiles; domain reasoning belongs in the agent.
- `src/worker.ts` routes requests to those handlers.
- `migrations/` must match the persisted schema; the generated application's tests execute the real migration.

Extend supported configuration and callbacks before duplicating a shell mechanism or forking the package.

## Required boundaries

Derive user and workspace identity from the authenticated session, never request bodies or model output.
An inaccessible thread returns 404 without disclosing that it exists.
Missing sandbox credentials produce an explicit failure, never a canned agent response.
Agents own reasoning and tools; the application owns durable records, billing, and approval enforcement.
Agent writes use schema-validated tools rather than records parsed from prose.
Preserve the persona's fabrication rule: a real record or an explicit "NOT ON FILE" outcome.

## Verification

Run the package's typecheck and test scripts.
The turn test uses real migrations and shell factories with a fake sandbox event feed; it does not prove live sandbox access.
For deployment, complete environment configuration, apply the required database migrations, and exercise the actual page and turn flow.
Fix failures without weakening the protected behavior.
