import { describe, it, expect } from 'vitest'
import {
  resolveToolCapabilities,
  restrictTaxonomy,
  type ToolCapability,
} from '../src/tools/gating'

const taxonomy = {
  proposalTypes: ['generate_dataset', 'train_model', 'deploy_model', 'contact', 'risk_assessment'],
  regulatedTypes: ['train_model', 'deploy_model', 'risk_assessment'],
}

const capabilities: ToolCapability[] = [
  { id: 'datasets', label: 'Datasets', description: '', proposalTypes: ['generate_dataset'] },
  { id: 'training', label: 'Training', description: '', proposalTypes: ['train_model'] },
  { id: 'deploy', label: 'Deploy', description: '', proposalTypes: ['deploy_model'] },
  { id: 'outreach', label: 'Outreach', description: '', proposalTypes: ['contact'] },
  { id: 'domain_actions', label: 'Domain actions', description: '', domainActions: true },
  { id: 'sandbox', label: 'Sandbox', description: '', toolGroups: ['sandbox'] },
]

describe('resolveToolCapabilities', () => {
  it('undefined = full access (back-compat), including every declared tool group', () => {
    const r = resolveToolCapabilities({ taxonomy, capabilities, enabled: undefined })
    expect([...r.proposalTypes].sort()).toEqual([...taxonomy.proposalTypes].sort())
    expect(r.toolGroups).toEqual(['sandbox'])
  })

  it('empty set = a pure chat agent (no tools)', () => {
    const r = resolveToolCapabilities({ taxonomy, capabilities, enabled: [] })
    expect(r.proposalTypes).toEqual([])
    expect(r.toolGroups).toEqual([])
  })

  it('maps capability ids to their proposal types', () => {
    const r = resolveToolCapabilities({ taxonomy, capabilities, enabled: ['datasets', 'training'] })
    expect([...r.proposalTypes].sort()).toEqual(['generate_dataset', 'train_model'])
    expect(r.toolGroups).toEqual([])
  })

  it('drops proposal types absent from the taxonomy (fail-closed)', () => {
    const caps: ToolCapability[] = [
      { id: 'x', label: 'X', description: '', proposalTypes: ['not_in_taxonomy', 'contact'] },
    ]
    const r = resolveToolCapabilities({ taxonomy, capabilities: caps, enabled: ['x'] })
    expect(r.proposalTypes).toEqual(['contact'])
  })

  it('domainActions expands to taxonomy types no capability names explicitly', () => {
    const r = resolveToolCapabilities({ taxonomy, capabilities, enabled: ['domain_actions'] })
    expect(r.proposalTypes).toEqual(['risk_assessment'])
  })

  it('honors an explicit baseProposalTypes override for domainActions', () => {
    const r = resolveToolCapabilities({
      taxonomy,
      capabilities,
      enabled: ['domain_actions'],
      baseProposalTypes: ['generate_dataset', 'train_model', 'deploy_model'],
    })
    expect([...r.proposalTypes].sort()).toEqual(['contact', 'risk_assessment'])
  })

  it('unions tool groups across enabled capabilities, deduped', () => {
    const caps: ToolCapability[] = [
      { id: 'a', label: 'A', description: '', toolGroups: ['sandbox', 'integrations'] },
      { id: 'b', label: 'B', description: '', toolGroups: ['sandbox'] },
    ]
    const r = resolveToolCapabilities({ taxonomy, capabilities: caps, enabled: ['a', 'b'] })
    expect([...r.toolGroups].sort()).toEqual(['integrations', 'sandbox'])
  })

  it('ignores unknown capability ids', () => {
    const r = resolveToolCapabilities({ taxonomy, capabilities, enabled: ['nope'] })
    expect(r.proposalTypes).toEqual([])
    expect(r.toolGroups).toEqual([])
  })
})

describe('restrictTaxonomy', () => {
  it('intersects proposal AND regulated types', () => {
    const t = restrictTaxonomy(taxonomy, ['train_model', 'generate_dataset'])
    expect([...t.proposalTypes].sort()).toEqual(['generate_dataset', 'train_model'])
    expect(t.regulatedTypes).toEqual(['train_model'])
  })

  it('empty allowlist yields an empty taxonomy', () => {
    const t = restrictTaxonomy(taxonomy, [])
    expect(t.proposalTypes).toEqual([])
    expect(t.regulatedTypes).toEqual([])
  })
})
