import { describe, it, expect } from 'vitest'
import {
  allOf,
  anyOf,
  assertPolicy,
  checkHarnessPolicy,
  checkModelPolicy,
  checkPolicy,
  checkProfilePolicy,
  filterItemsByPolicy,
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

describe('typed wrappers name the refused kind', () => {
  it('harness and profile checks carry their kind in the reason', async () => {
    const harness = await checkHarnessPolicy('opencode', [], () => true)
    const profile = await checkProfilePolicy('default', [], () => true)
    if (!harness.allowed) expect(harness.reason).toContain('harness "opencode"')
    if (!profile.allowed) expect(profile.reason).toContain('profile "default"')
    expect(harness.allowed).toBe(false)
    expect(profile.allowed).toBe(false)
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
})
