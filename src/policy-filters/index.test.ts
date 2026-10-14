import { describe, it, expect } from 'vitest'
import {
  allOf,
  allowAll,
  anyOf,
  assertPolicy,
  checkModelPolicy,
  checkPolicy,
  filterItemsByPolicy,
  indexPolicyCatalog,
  PolicyDeniedError,
  type ModelPolicyInfo,
  type PolicyFilter,
} from './index'

const ZDR_ONLY: PolicyFilter<ModelPolicyInfo> = (m) => m.zeroDataRetention === true
const HIPAA: PolicyFilter<ModelPolicyInfo> = (m) => m.hipaaEligible === true

const MODELS: ModelPolicyInfo[] = [
  { id: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', zeroDataRetention: true, hipaaEligible: true },
  { id: 'openai/gpt-5', provider: 'openai', zeroDataRetention: true, hipaaEligible: false },
  { id: 'acme/retained-logs', provider: 'acme', zeroDataRetention: false, hipaaEligible: false },
]

describe('allOf / anyOf combinators', () => {
  it('allOf admits only when every filter admits', async () => {
    const zdrAndHipaa = allOf(ZDR_ONLY, HIPAA)
    expect(await zdrAndHipaa(MODELS[0]!, {})).toBe(true)
    expect(await zdrAndHipaa(MODELS[1]!, {})).toBe(false)
    expect(await zdrAndHipaa(MODELS[2]!, {})).toBe(false)
  })

  it('anyOf admits when at least one filter admits', async () => {
    const zdrOrHipaa = anyOf(ZDR_ONLY, HIPAA)
    expect(await zdrOrHipaa(MODELS[0]!, {})).toBe(true)
    expect(await zdrOrHipaa(MODELS[1]!, {})).toBe(true)
    expect(await zdrOrHipaa(MODELS[2]!, {})).toBe(false)
  })

  it('combinators compose and support async filters', async () => {
    const fromUsEast: PolicyFilter<ModelPolicyInfo> = async (m) => m.region === 'us-east'
    const composed = allOf(ZDR_ONLY, anyOf(HIPAA, fromUsEast))
    expect(await composed({ id: 'x', zeroDataRetention: true, hipaaEligible: true }, {})).toBe(true)
    expect(await composed({ id: 'y', zeroDataRetention: true, hipaaEligible: false, region: 'us-east' }, {})).toBe(true)
    expect(await composed({ id: 'z', zeroDataRetention: true, hipaaEligible: false }, {})).toBe(false)
  })

  it('threads the context to every filter', async () => {
    const seen: unknown[] = []
    const probe: PolicyFilter<ModelPolicyInfo, { workspaceId: string }> = (_m, ctx) => {
      seen.push(ctx.workspaceId)
      return true
    }
    await allOf(probe, probe)(MODELS[0]!, { workspaceId: 'w-1' })
    expect(seen).toEqual(['w-1', 'w-1'])
  })

  it('allOf() with zero filters THROWS at composition time — no silent admit-everything', () => {
    // Pinned semantics: an empty conjunction is a policy that was never wired.
    // Composition-time, not first-use: the bug fails the moment it is written,
    // not the first turn that depends on it.
    expect(() => allOf<ModelPolicyInfo>()).toThrow(/empty allOf admits everything/)
  })

  it('allowAll() is the explicit no-restriction filter, and the catalog still gates', async () => {
    expect(await allowAll<ModelPolicyInfo>()(MODELS[2]!, {})).toBe(true)
    // allowAll admits what the catalog CLASSIFIES; an unclassified id still
    // fails closed — "no restriction" is not "no catalog".
    const result = await checkModelPolicy('mystery/model', MODELS, allowAll())
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.code).toBe('policy-metadata-missing')
  })

  it('an empty anyOf admits nothing (fail-closed, so it stays allowed)', async () => {
    expect(await anyOf<ModelPolicyInfo>()(MODELS[0]!, {})).toBe(false)
  })
})

describe('checkPolicy — pass / deny / fail-closed', () => {
  const zdrHipaa = allOf(ZDR_ONLY, HIPAA)

  it('admits a classified model the filter accepts, returning its metadata', async () => {
    const result = await checkModelPolicy('anthropic/claude-sonnet-4-6', MODELS, zdrHipaa)
    expect(result).toEqual({ allowed: true, info: MODELS[0] })
  })

  it('denies a classified model the filter rejects', async () => {
    const result = await checkModelPolicy('openai/gpt-5', MODELS, zdrHipaa)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.code).toBe('policy-denied')
      expect(result.reason).toContain('openai/gpt-5')
    }
  })

  it('fails closed when the catalog carries no metadata for the id', async () => {
    const result = await checkModelPolicy('mystery/model', MODELS, zdrHipaa)
    expect(result).toEqual({
      allowed: false,
      code: 'policy-metadata-missing',
      reason: 'model "mystery/model" is not admitted by policy: no policy metadata classifies it',
    })
  })

  it('fails closed when the filter throws', async () => {
    const broken: PolicyFilter<ModelPolicyInfo> = () => {
      throw new Error('compliance store unreachable')
    }
    const result = await checkModelPolicy('anthropic/claude-sonnet-4-6', MODELS, broken)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.code).toBe('policy-filter-error')
      expect(result.reason).toContain('compliance store unreachable')
    }
  })

  it('fails closed when the catalog lookup throws', async () => {
    const catalog = () => {
      throw new Error('db down')
    }
    const result = await checkPolicy({ kind: 'model', id: 'x', catalog, filter: ZDR_ONLY })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.code).toBe('policy-filter-error')
  })

  it('accepts a lookup function as the catalog, sync or async', async () => {
    const sync = (id: string) => MODELS.find((m) => m.id === id)
    const async_ = async (id: string) => MODELS.find((m) => m.id === id)
    expect((await checkModelPolicy('openai/gpt-5', sync, ZDR_ONLY)).allowed).toBe(true)
    expect((await checkModelPolicy('openai/gpt-5', async_, ZDR_ONLY)).allowed).toBe(true)
    expect((await checkModelPolicy('absent', async_, ZDR_ONLY)).allowed).toBe(false)
  })

  it('accepts a ReadonlyMap catalog keyed by exact id', async () => {
    const catalog = indexPolicyCatalog(MODELS)
    const readonlyCatalog: ReadonlyMap<string, ModelPolicyInfo> = catalog
    expect((await checkModelPolicy('anthropic/claude-sonnet-4-6', readonlyCatalog, zdrHipaa)).allowed).toBe(true)
    expect((await checkModelPolicy('openai/gpt-5', readonlyCatalog, zdrHipaa)).allowed).toBe(false)
    expect((await checkModelPolicy('absent', readonlyCatalog, zdrHipaa)).allowed).toBe(false)
  })

  it('generic kinds name the refused item — one mechanism serves any domain', async () => {
    // Harnesses, profiles, anything else: `checkPolicy` takes the kind as data.
    const harness = await checkPolicy({ kind: 'harness', id: 'opencode', catalog: [], filter: () => true })
    const profile = await checkPolicy({ kind: 'profile', id: 'default', catalog: [], filter: () => true })
    expect(harness.allowed).toBe(false)
    expect(profile.allowed).toBe(false)
    if (!harness.allowed) expect(harness.reason).toContain('harness "opencode"')
    if (!profile.allowed) expect(profile.reason).toContain('profile "default"')
  })
})

describe('assertPolicy — throwing enforcement form', () => {
  it('resolves with the metadata on admission', async () => {
    await expect(
      assertPolicy({ kind: 'model', id: 'openai/gpt-5', catalog: MODELS, filter: ZDR_ONLY }),
    ).resolves.toBe(MODELS[1])
  })

  it('throws PolicyDeniedError with the refusal code on denial', async () => {
    const err = await assertPolicy({
      kind: 'model',
      id: 'acme/retained-logs',
      catalog: MODELS,
      filter: ZDR_ONLY,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PolicyDeniedError)
    expect((err as PolicyDeniedError).code).toBe('policy-denied')
    expect((err as PolicyDeniedError).kind).toBe('model')
    expect((err as PolicyDeniedError).id).toBe('acme/retained-logs')
  })

  it('throws policy-metadata-missing for an unclassified id', async () => {
    const err = await assertPolicy({ kind: 'harness', id: 'ghost', catalog: [], filter: () => true }).catch(
      (e: unknown) => e,
    )
    expect((err as PolicyDeniedError).code).toBe('policy-metadata-missing')
  })
})

describe('filterItemsByPolicy — picker catalog filter', () => {
  it('keeps only classified, policy-passing items', async () => {
    const pickerCatalog = [
      { id: 'anthropic/claude-sonnet-4-6', name: 'Sonnet' },
      { id: 'openai/gpt-5', name: 'GPT-5' },
      { id: 'acme/retained-logs', name: 'Retained' },
      { id: 'new/unclassified', name: 'Unclassified' },
    ]
    const admitted = await filterItemsByPolicy(pickerCatalog, MODELS, allOf(ZDR_ONLY, HIPAA))
    expect(admitted.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4-6'])
  })

  it('an empty result is honest — the picker renders its empty-catalogue state', async () => {
    const admitted = await filterItemsByPolicy([{ id: 'acme/retained-logs' }], MODELS, ZDR_ONLY)
    expect(admitted).toEqual([])
  })

  it('consumes an iterable catalog ONCE — a one-shot generator still classifies every item', async () => {
    // A per-item rescan is O(items x catalog) AND silently wrong on a one-shot
    // iterable: the second item's scan would see an exhausted generator and
    // fail closed. One hoisted index answers every lookup.
    function* once() {
      yield* MODELS
    }
    const items = MODELS.map((m) => ({ id: m.id, name: m.id }))
    const admitted = await filterItemsByPolicy(items, once(), ZDR_ONLY)
    expect(admitted.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4-6', 'openai/gpt-5'])
  })

  it('accepts a ReadonlyMap catalog without rescanning', async () => {
    const items = MODELS.map((m) => ({ id: m.id }))
    const admitted = await filterItemsByPolicy(items, indexPolicyCatalog(MODELS), ZDR_ONLY)
    expect(admitted.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4-6', 'openai/gpt-5'])
  })
})

describe('indexPolicyCatalog', () => {
  it('indexes entries by exact id', () => {
    const index = indexPolicyCatalog(MODELS)
    expect(index.get('openai/gpt-5')).toBe(MODELS[1])
    expect(index.get('OPENAI/GPT-5')).toBeUndefined()
    expect(index.size).toBe(MODELS.length)
  })
})
