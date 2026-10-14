import { describe, it, expect } from 'vitest'
import { allOf, type ModelPolicyInfo, type PolicyFilter } from '../policy-filters/index'
import {
  resolveChatModel,
  validateChatModelId,
  cleanModelId,
  isWellFormedModelId,
  catalogIdsForModel,
  type LoadModels,
  type ModelInfo,
} from './index'

const DEFAULT = 'gemini-2.5-flash-lite'

describe('resolveChatModel — one canonical precedence', () => {
  it('request beats workspace and env', () => {
    expect(
      resolveChatModel({ requestModel: 'r', workspaceModel: 'w', envModel: 'e', defaultModel: DEFAULT }),
    ).toEqual({ model: 'r', source: 'request' })
  })

  it('falls back to the workspace-pinned model', () => {
    expect(resolveChatModel({ workspaceModel: 'w', envModel: 'e', defaultModel: DEFAULT })).toEqual({
      model: 'w',
      source: 'workspace',
    })
  })

  it('falls back to the env model value', () => {
    expect(resolveChatModel({ envModel: 'e', defaultModel: DEFAULT })).toEqual({ model: 'e', source: 'env' })
  })

  it('falls back to the default', () => {
    expect(resolveChatModel({ defaultModel: DEFAULT })).toEqual({ model: DEFAULT, source: 'default' })
  })

  it('treats blank request/workspace/env as absent', () => {
    expect(
      resolveChatModel({ requestModel: '  ', workspaceModel: '', envModel: 'e', defaultModel: DEFAULT }),
    ).toEqual({ model: 'e', source: 'env' })
  })
})

const CATALOG: ModelInfo[] = [
  { id: 'anthropic/claude-sonnet-4-6' },
  { id: 'openai/gpt-5' }, // prefixed only → bare 'gpt-5' resolves via unique-suffix
  { id: 'openai/x' },
  { id: 'vertex/x' }, // suffix 'x' appears under two providers → ambiguous
]
const loadModels: LoadModels = async () => CATALOG
const ROUTER = 'https://router.tangle.tools'

describe('validateChatModelId — fail-closed admission', () => {
  it('rejects non-string, blank, and malformed ids', async () => {
    expect((await validateChatModelId(42, { loadModels, routerBaseUrl: ROUTER })).succeeded).toBe(false)
    expect((await validateChatModelId('   ', { loadModels, routerBaseUrl: ROUTER })).succeeded).toBe(false)
    expect((await validateChatModelId('bad model!!', { loadModels, routerBaseUrl: ROUTER })).succeeded).toBe(false)
  })

  it('admits an allowlisted id WITHOUT a catalog fetch', async () => {
    let fetched = false
    const spyLoad: LoadModels = async (u) => { fetched = true; return loadModels(u) }
    const r = await validateChatModelId(DEFAULT, { allowlist: [DEFAULT], loadModels: spyLoad, routerBaseUrl: ROUTER })
    expect(r).toEqual({ succeeded: true, value: DEFAULT })
    expect(fetched).toBe(false)
  })

  it('admits the operator-set env model (trusted, no fetch needed)', async () => {
    expect(await validateChatModelId('custom/env-model', { envModel: 'custom/env-model' })).toEqual({
      succeeded: true,
      value: 'custom/env-model',
    })
  })

  it('admits an exact catalog id', async () => {
    expect(await validateChatModelId('anthropic/claude-sonnet-4-6', { loadModels, routerBaseUrl: ROUTER })).toEqual({
      succeeded: true,
      value: 'anthropic/claude-sonnet-4-6',
    })
  })

  it('resolves a bare id to its canonical id when the suffix is unique', async () => {
    expect(await validateChatModelId('gpt-5', { loadModels, routerBaseUrl: ROUTER })).toEqual({
      succeeded: true,
      value: 'openai/gpt-5',
    })
  })

  it('rejects a bare id whose suffix is ambiguous across providers', async () => {
    expect((await validateChatModelId('x', { loadModels, routerBaseUrl: ROUTER })).succeeded).toBe(false)
  })

  it('rejects an unknown id', async () => {
    expect((await validateChatModelId('ghost-model', { loadModels, routerBaseUrl: ROUTER })).succeeded).toBe(false)
  })

  it('fails closed when the catalog path is needed but no loader is provided', async () => {
    expect((await validateChatModelId('mystery/model', {})).succeeded).toBe(false)
  })
})

describe('validateChatModelId — policy enforcement on the admission seam', () => {
  // A HIPAA posture: zero-data-retention AND BAA-eligible models only.
  const POLICY_META = [
    { id: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', zeroDataRetention: true, hipaaEligible: true },
    { id: 'openai/gpt-5', provider: 'openai', zeroDataRetention: true, hipaaEligible: false },
    { id: DEFAULT, zeroDataRetention: true, hipaaEligible: true },
  ]
  const zdrHipaaOnly: PolicyFilter<ModelPolicyInfo> = allOf(
    (m) => m.zeroDataRetention === true,
    (m) => m.hipaaEligible === true,
  )
  const policy = { filter: zdrHipaaOnly, catalog: POLICY_META }

  it('admits an available model whose metadata passes the policy', async () => {
    expect(
      await validateChatModelId('anthropic/claude-sonnet-4-6', { loadModels, routerBaseUrl: ROUTER, policy }),
    ).toEqual({ succeeded: true, value: 'anthropic/claude-sonnet-4-6' })
  })

  it('refuses an AVAILABLE model the policy rejects — availability is not eligibility', async () => {
    const r = await validateChatModelId('openai/gpt-5', { loadModels, routerBaseUrl: ROUTER, policy })
    expect(r.succeeded).toBe(false)
    if (!r.succeeded) expect(r.error).toContain('not admitted by policy')
  })

  it('refuses an ALLOWLISTED model carrying no policy metadata (fail-closed on the operator-trusted lane)', async () => {
    const r = await validateChatModelId(DEFAULT, { allowlist: [DEFAULT], policy: { ...policy, catalog: [] } })
    expect(r.succeeded).toBe(false)
    if (!r.succeeded) expect(r.error).toContain('no policy metadata')
  })

  it('refuses the operator-set env model when the policy rejects it', async () => {
    const r = await validateChatModelId('openai/gpt-5', { envModel: 'openai/gpt-5', policy })
    expect(r.succeeded).toBe(false)
  })

  it('fails closed when the policy filter throws', async () => {
    const r = await validateChatModelId('anthropic/claude-sonnet-4-6', {
      loadModels,
      routerBaseUrl: ROUTER,
      policy: {
        catalog: POLICY_META,
        filter: () => {
          throw new Error('compliance store unreachable')
        },
      },
    })
    expect(r.succeeded).toBe(false)
    if (!r.succeeded) expect(r.error).toContain('compliance store unreachable')
  })

  it('applies the policy to the canonicalized id a bare request resolves to', async () => {
    // 'gpt-5' resolves to 'openai/gpt-5', which the policy rejects.
    const r = await validateChatModelId('gpt-5', { loadModels, routerBaseUrl: ROUTER, policy })
    expect(r.succeeded).toBe(false)
  })
})

describe('helpers', () => {
  it('cleanModelId trims and rejects blank/non-string', () => {
    expect(cleanModelId('  a  ')).toBe('a')
    expect(cleanModelId('')).toBeUndefined()
    expect(cleanModelId(7)).toBeUndefined()
  })
  it('isWellFormedModelId rejects spaces and over-long ids', () => {
    expect(isWellFormedModelId('openai/gpt-5')).toBe(true)
    expect(isWellFormedModelId('has space')).toBe(false)
    expect(isWellFormedModelId('a'.repeat(201))).toBe(false)
  })
  it('catalogIdsForModel yields bare + canonical for a provider-tagged bare id', () => {
    expect(catalogIdsForModel({ id: 'gpt-5', _provider: 'openai' }).sort()).toEqual(['gpt-5', 'openai/gpt-5'])
  })
})
