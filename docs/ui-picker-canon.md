# UI picker canon — one model/effort/harness picker for the ecosystem

Model/effort/harness picking has exactly one canonical implementation:
`ModelPicker`, `EffortPicker`, and `AgentSessionControls` from
`@tangle-network/agent-app/web-react`.

sandbox-ui's `dashboard/ModelPicker` and the model menu in
`chat/AgentSessionControls` are **legacy** — deprecated, frozen, and removed at
sandbox-ui's next major. agent-app's `/chat-react` `ComposerAgentControls`
adapter over that legacy strip is **removed**: it no longer exists, and
`EntryComposer`'s `agent` prop now takes the canonical
`AgentSessionControlsProps` directly. The props mapping below is the migration
path for any product still holding the old nested selection shape.

## Boundary

- **sandbox-ui owns rendering primitives** — terminal, code surface, session
  chrome primitives.
- **agent-app owns composed, seam-driven app-shell surfaces** — transcript,
  composer controls, pickers, assistant.

If you are about to add a picker/menu/control to sandbox-ui, stop — it belongs
in agent-app. Note the one deliberate asymmetry: the assistant dock composer
renders a **bare `ModelPicker`** by design — the assistant wire has no harness
field, so no harness or effort control belongs there.

## Migration: sandbox-ui → agent-app canon

### `ModelPicker` (sandbox-ui `dashboard/ModelPicker` → `agent-app/web-react` `ModelPicker`)

| sandbox-ui prop | agent-app prop | Notes |
| --- | --- | --- |
| `value: string` | `value: string` | Same contract: the canonical provider-prefixed id (`anthropic/claude-…`). |
| `onChange(modelId)` | `onChange(id)` | Same — the canonical id comes back. |
| `models: ModelInfo[]` | `models: CatalogModel[]` | Shape change, see below. Build it with `/runtime`'s `fetchModelCatalog` / `buildCatalog`, which emit `CatalogModel[]` directly. |
| `loading?: boolean` | `loading?: boolean` | Same. |
| `recents`, `popular` | `priorityGroup: { label, match }` | The pinned top section is predicate-based instead of id-list-based; `recommendedLabel` renames the featured section. |
| `excludeProviders`, `modalities` | — | Filter the `models` array before passing it (`/runtime` exports `isChatCapableModel` for the chat-surface trim). |
| `variant: "field" \| "pill"` | — | The canon is the pill. There is no form-field variant; compose one in the product if a form genuinely needs it. |
| `side`, `avoidCollisions`, `label`, `placeholder`, `triggerClassName`, `disabled` | — | No equivalents. The canonical popover opens upward from the composer and clamps itself inside the viewport. |
| — | `renderProviderBadge(provider)` | agent-app-only hook: override the provider logo/badge (defaults to `/web-react`'s `ProviderLogo`). |

`ModelInfo` → `CatalogModel` field mapping:

| `ModelInfo` (router wire format) | `CatalogModel` (canon) |
| --- | --- |
| `id` (possibly bare) | `id` — **canonical** `provider/model` (use `canonicalModelId` / `/runtime`'s `normalizeModelId`) |
| `name?` | `name` (required) |
| `_provider` / `provider` | `provider` (required) |
| `pricing.prompt/completion` | `pricing.prompt/completion` (same decimal-string shape) |
| `context_length` | `contextLength` |
| `description` | `description` |
| `featured` | `featured` |
| `supportsReasoning` | `supportsReasoning` (required) |
| — | `supportsTools` (required; drives the "no tools" badge) |
| `architecture`, `logos`, `hostProvider`, `modelLab`, `maxReasoningEffort` | — (not carried; provider branding is derived from `provider`) |

### `AgentSessionControls` (sandbox-ui `chat/AgentSessionControls`, or the removed `/chat-react` `ComposerAgentControls` adapter → `agent-app/web-react` `AgentSessionControls`)

| legacy prop | canonical prop | Notes |
| --- | --- | --- |
| `model: { value, onChange, models, loading, … }` | `model`, `onModelChange`, `models: CatalogModel[]`, `modelsLoading` | Flattened onto the top level. `value` must be the canonical id. `model.disabled`, `model.recents`, `model.popular`, `model.modalities`, `model.excludeProviders` have no equivalent — trim the array before passing. |
| `harness: { value, onChange, available, locked, lockReason, onNewChat, disabled }` | `harness`, `onHarnessChange`, `availableHarnesses` | `Harness` is `/harness`'s union, not sandbox-ui's `HarnessType`. The locked/fork affordance (session pinning) is product state: render the canonical control only while unpinned, or render your own locked chip — the canonical control keeps harness switching live. |
| `reasoning: { value, onChange, available }` | `effort`, `onEffortChange` | `effort` is a plain engine-id string (`off`/`low`/`medium`/`high` by default — see `DEFAULT_EFFORT_LEVELS`). sandbox-ui's `auto` sentinel has no equivalent; map it to your product's default level. |
| `layout: "inline" \| "gear" \| "combined"` | `layout: "inline" \| "compact"` | `gear`/`combined` both become `compact` (model inline, harness + effort behind a gear popover with plain-English copy). |
| `context: "chat" \| "all"` | — | No flag: offer only what the surface supports (`availableHarnesses`, pre-filtered `models`). |
| `filterModelsToHarness` | — | No equivalent. The canonical control always enforces coherence both ways via `/harness`'s `snapModelToHarness` / `snapHarnessToModel`. |
| `profile` | — | Agent-profile picking is not part of the canon cluster. |
| `menuPlacement`, `trailing` | — | Menus open upward; extras dock beside the control in your own row. |
| `className` | `className` | Same. |

The `ComposerAgentControls` adapter's wiring that products relied on —
canonical-id boundary, harness-snap suppression for per-harness remembered
picks, and the chat-context trim (`cli-base` / non-chat models never offered) —
becomes product-side state when migrating: store per-harness picks yourself and
filter the catalog before passing it. The coherence grammar itself (harness
change snaps the model, model change snaps the harness) is identical in the
canonical component.

## Products still on legacy pickers

Bump to current sandbox-ui, adopt the canon per the mapping above, and delete
the local picker if the product hand-rolled one. The legacy sandbox-ui pickers
receive no further features — frozen means frozen.
