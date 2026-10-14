# Policy filters — restrict which models, harnesses, and profiles a product will run

`@tangle-network/agent-app/policy-filters` is a generic admission-policy
mechanism. A product that must not run certain models (a HIPAA deployment that
may only use zero-data-retention, BAA-eligible models), certain harnesses, or
certain agent profiles expresses that as **data plus a typed predicate**; the
engine owns composition, fail-closed enforcement, and the picker-facing
catalog filter.

The engine never hardcodes policy. `ModelPolicyInfo` / `HarnessPolicyInfo` /
`ProfilePolicyInfo` are metadata the PRODUCT supplies — from its router
catalog, a compliance review, or a vendor attestation — and the filter is the
product's own function.

## The pieces

```ts
import {
  allOf, anyOf,                 // combinators
  checkModelPolicy,             // fail-closed check → { allowed, ... }
  assertPolicy,                 // throwing form → PolicyDeniedError
  filterItemsByPolicy,          // picker catalog filter (browser-safe)
  type PolicyFilter,
  type ModelPolicyInfo,
} from '@tangle-network/agent-app/policy-filters'
```

- `PolicyFilter<T, C> = (item: T, context: C) => boolean | Promise<boolean>` —
  any predicate, sync or async, over the product's metadata shape.
- `allOf(...)` / `anyOf(...)` compose filters; combinators nest.
- `checkPolicy` / `checkModelPolicy` / `checkHarnessPolicy` /
  `checkProfilePolicy` admit an id only when the product's catalog classifies
  it AND the filter accepts it. `assertPolicy` is the throwing form.
- `filterItemsByPolicy` keeps only policy-passing items, for UI pickers.

## Fail-closed, always

- **No metadata → refused.** An id the catalog does not classify is denied
  (`policy-metadata-missing`). A policy that cannot classify an item does not
  admit it.
- **A filter that throws → refused** (`policy-filter-error`). A broken
  compliance lookup fails the turn instead of waving it through.
- **A filter rejection → denied** (`policy-denied`) with a reason naming the
  kind and id.

## The enforcement seam: model resolution

`validateChatModelId` (`/model-resolution`) — the one fail-closed validator
every chat turn's model passes through — takes an optional `policy`. The policy
runs **after availability, on every admission path**: allowlist, operator-set
env model, and live catalog alike. An operator-trusted lane cannot bypass a
deployment's admission policy.

```ts
const result = await validateChatModelId(requestedModel, {
  allowlist,
  envModel,
  loadModels,
  routerBaseUrl,
  policy: { filter: hipaaModelFilter, catalog: modelPolicyCatalog },
})
```

For harnesses and profiles, call `checkHarnessPolicy` / `checkProfilePolicy`
(or `assertPolicy`) where the product resolves the turn's harness and profile,
before dispatch.

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
import { allOf, type ModelPolicyInfo, type PolicyFilter } from '@tangle-network/agent-app/policy-filters'

// Product DATA — maintained from vendor attestations / the compliance review.
export const MODEL_POLICY_CATALOG: ModelPolicyInfo[] = [
  { id: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', zeroDataRetention: true, hipaaEligible: true },
  { id: 'openai/gpt-5', provider: 'openai', zeroDataRetention: true, hipaaEligible: false },
]

export const hipaaModelFilter: PolicyFilter<ModelPolicyInfo> = allOf(
  (m) => m.zeroDataRetention === true,
  (m) => m.hipaaEligible === true,
)
```

- Server: pass `{ filter: hipaaModelFilter, catalog: MODEL_POLICY_CATALOG }` as
  `policy` to `validateChatModelId`. `openai/gpt-5` — available in the router
  catalog but not BAA-eligible — is refused; any model missing from
  `MODEL_POLICY_CATALOG` is refused.
- Browser: `filterItemsByPolicy(pickerModels, MODEL_POLICY_CATALOG, hipaaModelFilter)`
  before `ModelPicker`, so the picker never offers a model a turn would refuse.

The same shapes cover harnesses (`HarnessPolicyInfo`) and profiles
(`ProfilePolicyInfo`) with the product's own filters.
