# Policy filters — restrict which models a product will run

`@tangle-network/agent-app/policy-filters` is a generic admission-policy
mechanism. A product that must not run certain models (a HIPAA deployment that
may only use zero-data-retention, BAA-eligible models) expresses that as
**data plus a typed predicate**; the engine owns composition, fail-closed
enforcement, and the picker-facing catalog filter.

The engine never hardcodes policy. `ModelPolicyInfo` is metadata the PRODUCT
supplies — from its router catalog, a compliance review, or a vendor
attestation — and the filter is the product's own function.

## The pieces

```ts
import {
  allOf, anyOf, allowAll,       // combinators (+ the explicit no-restriction filter)
  checkModelPolicy,             // fail-closed check → { allowed, ... }
  assertPolicy,                 // throwing form → PolicyDeniedError
  filterItemsByPolicy,          // picker catalog filter (browser-safe)
  indexPolicyCatalog,           // iterable → Map, for repeated lookups
  type PolicyFilter,
  type ModelPolicy,
  type ModelPolicyInfo,
} from '@tangle-network/agent-app/policy-filters'
```

- `PolicyFilter<T, C> = (item: T, context: C) => boolean | Promise<boolean>` —
  any predicate, sync or async, over the product's metadata shape.
- `allOf(...)` / `anyOf(...)` compose filters; combinators nest. An **empty
  `allOf()` throws at composition time** — an empty conjunction would admit
  everything, which reads as a policy that was never wired. Say "no
  restriction" out loud with `allowAll()` instead. An empty `anyOf()` admits
  nothing (already fail-closed, so it is allowed).
- `checkPolicy` / `checkModelPolicy` admit an id only when the product's
  catalog classifies it AND the filter accepts it. `assertPolicy` is the
  throwing form. `checkPolicy` takes the admitted `kind` (`'model'`,
  `'harness'`, …) as data, so the same mechanism serves any domain without a
  wrapper per kind.
- `ModelPolicy` — `{ filter, catalog, context? }` — is the one shape every
  model-enforcement seam below takes, so a product states its policy once and
  threads it to all of them.
- `filterItemsByPolicy` keeps only policy-passing items, for UI pickers.
- `PolicyCatalog` is an iterable, a `ReadonlyMap` keyed by id, or a sync/async
  lookup function. Hold the Map form (`indexPolicyCatalog`) when one catalog
  answers many lookups.

## Fail-closed, always

- **No metadata → refused.** An id the catalog does not classify is denied
  (`policy-metadata-missing`). A policy that cannot classify an item does not
  admit it.
- **A filter that throws → refused** (`policy-filter-error`). A broken
  compliance lookup fails the turn instead of waving it through.
- **A filter rejection → denied** (`policy-denied`) with a reason naming the
  kind and id.

## Ids are exact strings

Catalog lookups never normalize. The id a turn carries —
`anthropic/claude-sonnet-4-6`, `claude-sonnet-4-6`, and
`CLAUDE-SONNET-4-6` are three different ids — must match a catalog key
byte-for-byte or the model fails closed. So **key the catalog exactly the way
your allowlist, env values, and fallback chains spell ids**: if the
deployment's `MODEL_NAME` is bare (`claude-sonnet-4-6`) but the catalog only
keys the canonical form, every turn is refused; the dangerous mirror image is
a catalog keyed one way and a fallback chain spelled another, where the
fallback *passes* a check that was never looking at real metadata.
`modelPolicyCatalogFromRouter` (below) emits every spelling the validator can
admit; hand-built catalogs should spell ids the same way the deployment does,
and a refusal that surprises you is almost always a spelling mismatch.

## The enforcement seams

Policy is enforced at three seams; wire the SAME `ModelPolicy` object to each
that applies. No single seam covers the whole path alone:

1. **Model admission — `validateChatModelId` (`/model-resolution`).** The
   fail-closed validator products call when admitting a model id. It takes an
   optional `policy`, evaluated **after availability, on every admission
   path**: allowlist, operator-set env model, and live catalog alike. An
   operator-trusted lane cannot bypass a deployment's admission policy.

   ```ts
   const result = await validateChatModelId(requestedModel, {
     allowlist,
     envModel,
     loadModels,
     routerBaseUrl,
     policy: hipaaModelPolicy,
   })
   ```

2. **Turn admission — `createChatTurnRoutes`' `modelPolicy`
   (`/chat-routes`).** When the request body NAMES a model, the route checks
   it after `authorize` and before any side effect (no row, no lock, no
   producer); a refusal answers 403 with the policy's reason. A turn that
   names no model resolves its model inside `produce`, which this seam never
   sees — that half belongs to seam 3.

3. **Execution, including failover — `createSandboxChatProducer`'s
   `modelPolicy`, `streamWithModelFailover`'s `policy`, and
   `runWithModelFailover`'s `policy`.** Every failover-chain member — the
   resolved preferred model AND every fallback — is checked **before it
   runs**. This is the seam that stops a compliant model 502ing mid-turn from
   silently re-running the turn's data through a non-compliant fallback. A
   refused member is skipped (the refusal is recorded in the attempt trail)
   and the walk continues; a chain with no admitted member exhausts like any
   all-dead chain.

```ts
createSandboxChatProducer({
  model,
  fallbackModels,
  modelPolicy: hipaaModelPolicy, // covers the resolved model AND every fallback
  openEvents: ({ model: attemptModel, signal }) => /* … */,
})
```

## The router mapper

`modelPolicyCatalogFromRouter` (`/model-resolution`, which owns the router
`ModelInfo` shape) maps router `/api/models` rows to a `ModelPolicyInfo`
catalog: snake_case `zdr` / `hipaa_eligible` become
`zeroDataRetention` / `hipaaEligible`, `provider` comes from the row's
`_provider`/`provider`, and one entry is emitted per spelling the validator
can admit (bare id AND provider-prefixed canonical form).

**Granularity:** the flags are trusted verbatim, per row, at whatever
granularity the router publishes them. A ZDR/BAA attestation is commonly a
provider-wide vendor fact, but the mapper never infers one model's
eligibility from a sibling's — a row that omits a flag yields `undefined` for
it, and a filter reading `=== true` refuses that row (fail closed). Publish a
provider-wide attestation on every row upstream rather than asking the mapper
to guess.

```ts
const catalog = modelPolicyCatalogFromRouter(routerModels)
const policy = { catalog, filter: hipaaModelFilter }
```

## Pickers show only what a turn may run

Filter the catalog BEFORE handing it to `ModelPicker`
(docs/ui-picker-canon.md — the picker's contract is unchanged; it renders the
host-supplied list):

```ts
const models = await filterItemsByPolicy(catalogModels, modelPolicyCatalog, hipaaModelFilter)
```

Unclassified and policy-failing entries are dropped from the offered list. The
picker still reconciles an absent SAVED value under its own name — this filter
shapes the offered list, never the persisted selection.

## Example: health-agent (HIPAA)

Only zero-data-retention, BAA-eligible models may run:

```ts
import { allOf, type ModelPolicy, type ModelPolicyInfo, type PolicyFilter } from '@tangle-network/agent-app/policy-filters'

// Product DATA — maintained from vendor attestations / the compliance review,
// or mapped from the router with modelPolicyCatalogFromRouter.
export const MODEL_POLICY_CATALOG: ModelPolicyInfo[] = [
  { id: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', zeroDataRetention: true, hipaaEligible: true },
  { id: 'openai/gpt-5', provider: 'openai', zeroDataRetention: true, hipaaEligible: false },
]

export const hipaaModelFilter: PolicyFilter<ModelPolicyInfo> = allOf(
  (m) => m.zeroDataRetention === true,
  (m) => m.hipaaEligible === true,
)

export const hipaaModelPolicy: ModelPolicy = { catalog: MODEL_POLICY_CATALOG, filter: hipaaModelFilter }
```

- Route: pass `modelPolicy: hipaaModelPolicy` to `createChatTurnRoutes` —
  a turn naming `openai/gpt-5` is refused with 403 before any side effect.
- Producer: pass `modelPolicy: hipaaModelPolicy` to
  `createSandboxChatProducer` — the resolved model and every fallback are
  checked at execution, so a mid-turn failover can never land on a
  non-compliant model.
- Admission: pass `policy: hipaaModelPolicy` to `validateChatModelId` —
  `openai/gpt-5`, available in the router catalog but not BAA-eligible, is
  refused; any model missing from `MODEL_POLICY_CATALOG` is refused.
- Browser: `filterItemsByPolicy(pickerModels, MODEL_POLICY_CATALOG, hipaaModelFilter)`
  before `ModelPicker`, so the picker never offers a model a turn would refuse.

For kinds other than models (harnesses, profiles), call the generic
`checkPolicy({ kind: 'harness', id, catalog, filter })` / `assertPolicy` where
the product resolves that value, with the product's own metadata shape.
