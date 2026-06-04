import { describe, it, expect, expectTypeOf } from 'vitest'
import {
  defineAgentApp,
  agentAppConfigJsonSchema,
  type AgentAppConfig,
  type KnowledgeRequirementSpec,
  type TangleModelConfig,
} from '../src/config/index'
import type { KnowledgeRequirementSpec as KnowledgeSpecSource } from '../src/knowledge/index'
import type { TangleModelConfig as ModelConfigSource } from '../src/runtime/index'

const minimal: AgentAppConfig = {
  identity: { name: 'WinFinance Ops Partner', persona: 'A licensed agency ops partner.' },
  taxonomy: { proposalTypes: ['propose_swap', 'contact_lead'], regulatedTypes: ['propose_swap'] },
  knowledge: { sources: [], requirements: [] },
  integrations: { enabled: ['shurens'] },
}

describe('AgentAppConfig contract', () => {
  it('a valid minimal config typechecks and defineAgentApp round-trips it', () => {
    const cfg = defineAgentApp(minimal)
    expect(cfg).toBe(minimal)
    expect(cfg).toEqual(minimal)
  })

  it('defineAgentApp preserves a fully-populated config including reused types', () => {
    const requirement: KnowledgeRequirementSpec = {
      id: 'policy_on_file',
      description: 'A real policy record exists for the workspace.',
      category: 'domain_specific',
      acquisitionMode: 'query_connector',
      satisfiedBy: { table: 'policies', minRows: 1 },
    }
    const model: TangleModelConfig = {
      provider: 'openai-compat',
      model: 'deepseek/deepseek-chat',
      apiKey: 'sk-tan-x',
      baseUrl: 'https://router.tangle.tools/v1',
    }
    const cfg = defineAgentApp({
      identity: {
        name: 'WinFinance',
        persona: 'persona',
        systemPromptFragments: ['workflow A', 'hard rule B'],
        disclaimers: { compliance: 'A certified human approves every regulated step.' },
      },
      taxonomy: { proposalTypes: ['propose_swap'], regulatedTypes: ['propose_swap'] },
      knowledge: {
        sources: [{ uri: 'vault://regulation', kind: 'regulation' }, { uri: 'https://example.com' }],
        requirements: [requirement],
        loop: { goal: 'ground every premium', minConfidence: 0.8, freshness: '7d' },
      },
      integrations: { enabled: ['shurens', 'lead-crm'] },
      ui: { generatedUi: true },
      delegation: { enabled: true },
      model,
    })

    expect(cfg.delegation?.enabled).toBe(true)
    expect(cfg.knowledge.requirements[0]).toBe(requirement)
    expect(cfg.knowledge.loop?.minConfidence).toBe(0.8)
    expect(cfg.model?.provider).toBe('openai-compat')
    expect(cfg.identity.systemPromptFragments).toEqual(['workflow A', 'hard rule B'])
    expect(cfg.identity.disclaimers?.compliance).toContain('certified human')
    expect(cfg.ui?.generatedUi).toBe(true)
    expect(cfg.integrations.enabled).toEqual(['shurens', 'lead-crm'])
    expect(cfg.knowledge.sources.map((s) => s.uri)).toEqual(['vault://regulation', 'https://example.com'])
  })

  it('reuses (does not redefine) KnowledgeRequirementSpec and TangleModelConfig', () => {
    // Structural identity: the re-exported types are the SAME declarations the
    // knowledge gate and runtime resolver consume — a mismatch fails to compile.
    expectTypeOf<KnowledgeRequirementSpec>().toEqualTypeOf<KnowledgeSpecSource>()
    expectTypeOf<TangleModelConfig>().toEqualTypeOf<ModelConfigSource>()
  })

  it('enforces required vs optional fields at the type level', () => {
    // Required fields present, optionals omitted → valid.
    expectTypeOf(minimal).toMatchTypeOf<AgentAppConfig>()
    // Optional sections are genuinely optional on the type.
    expectTypeOf<AgentAppConfig['ui']>().toEqualTypeOf<import('../src/config/index').AgentUiConfig | undefined>()
    expectTypeOf<AgentAppConfig['model']>().toEqualTypeOf<TangleModelConfig | undefined>()
    expectTypeOf<AgentAppConfig['identity']['name']>().toEqualTypeOf<string>()
    expectTypeOf<AgentAppConfig['identity']['systemPromptFragments']>().toEqualTypeOf<string[] | undefined>()
  })

  it('exposes a JSON-schema floor that pins the documented field names', () => {
    const s = agentAppConfigJsonSchema
    expect(s.type).toBe('object')
    expect(s.required).toEqual(['identity', 'taxonomy', 'knowledge', 'integrations'])
    expect(Object.keys(s.properties)).toEqual([
      'identity',
      'taxonomy',
      'knowledge',
      'integrations',
      'ui',
      'delegation',
      'model',
    ])
    expect(s.properties.identity.required).toEqual(['name', 'persona'])
    expect(s.properties.taxonomy.required).toEqual(['proposalTypes', 'regulatedTypes'])
    expect(s.properties.knowledge.required).toEqual(['sources', 'requirements'])
    expect(s.properties.integrations.required).toEqual(['enabled'])
    expect(s.properties.model.properties.provider.enum).toEqual(['openai-compat', 'anthropic'])
  })

  it('schema required set matches the interface required sections', () => {
    // Every schema-required top-level key is a non-optional field a minimal
    // config must supply; the optionals (ui, model) are absent from required.
    const required = agentAppConfigJsonSchema.required as readonly string[]
    expect(required).not.toContain('ui')
    expect(required).not.toContain('model')
    for (const key of required) expect(key in minimal).toBe(true)
  })
})
