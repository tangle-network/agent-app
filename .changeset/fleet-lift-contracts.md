---
'@tangle-network/agent-app': minor
---

`./toolbelt` ships the toolbelt parity gate as a platform contract: `probeStdioToolProgram` spawns an embedded stdio MCP program through a minimal handshake and reads its real tool surface, `toolbeltParityDiff`/`assertToolbeltParity` diff it against the authored manifest — names, byte-identical descriptions, structurally equal schemas and annotations — and name every disagreement. Any product with an embedded tool program gets automatic drift detection (the #10155 class becomes a red build, not a production silence).

`./spend` adds the budget-derived delegated mint: `deriveChildKeyBudgetUsd` derives a child key's ask from the parent's REMAINING budget (unknown → configured ask stands; exhausted → correctable `ParentBudgetExhaustedError` before any mint; otherwise min(configured, remaining) floored to cents with the $0.50 platform minimum). The platform reserves a child's budget against its parent's remaining — a flat default silently breaks every workspace whose parent holds less.

`./model-resolution` adds live model routing by allow-list: `parseModelNotAllowed` parses the allowed-model set the router's `model_not_allowed` refusal already names, `resolveModelWithinAllowList` reroutes within the product's fallback order (or refuses loudly naming the set — a different model is a different decision-maker), and `formatModelNotAllowedRefusal` mirrors the router's refusal text.

`./skills` adds the cross-agent skill marketplace substrate: `MarketplaceSkill` entries (id, product, description), validation with caps, `mergeSkillCatalogs` (namespaced `product:id`, local precedence, idempotent), the one-line `marketplaceDiscoveryLine` fragment, and read-only store adapters (in-memory/KV here; `./skills/marketplace-drizzle` for D1). Mounting, caps and baseline protection stay in the existing self-mount verb — the marketplace only decides what may be discovered and mounted.
