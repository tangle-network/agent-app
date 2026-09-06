# Customize an agent-app

This project supplies domain configuration and application wiring around `@tangle-network/agent-app`.
Read [CUSTOMIZE.md](CUSTOMIZE.md) for the customization checklist.
For knowledge ingestion or proposal checks, read [KNOWLEDGE.md](KNOWLEDGE.md).

## DATA vs CODE

- `agent.config.ts` contains identity, taxonomy, sources, integrations, UI, and model configuration as plain values.
- `knowledge/` contains domain documents, never secrets.
- `src/agent-app.ts` composes configuration and bindings through the shell's supported interfaces.
  Prefer the maintained preset; override a handler only when the preset cannot express required persistence.
- `src/worker.ts` owns routing and recovers trusted context from authentication.

Reuse the shell's mechanisms and its engine peers rather than forking them into this product.
Keep domain values in configuration and behavior in the composer.
Use `AgentAppConfig` and its exported JSON Schema from `@tangle-network/agent-app/config` as the configuration contract.

## Required boundaries

Regulated proposal types require a named human and cannot execute automatically.
Keep `regulatedTypes` a subset of `proposalTypes`; never downgrade a regulated action to an immediate tool.
Derive user, workspace, and thread identity from the server session, never model arguments.
Keep source attribution in the knowledge loop; low-confidence proposals remain proposals rather than applied changes.
Domain figures require a real record or an explicit "NOT ON FILE" outcome.

## Verification

Use the package's typecheck and test scripts to verify configuration, composer behavior, and these boundaries.
Run `pnpm knowledge:ingest` to check source enumeration without applying changes.
Before deployment, complete the required environment configuration and exercise the actual user flow.
Fix a failed check without weakening the behavior it protects.
