import { describe, expect, it } from 'vitest'
import {
  buildContextGatherPrompt,
  computeContextSufficiency,
  type ContextFactSpec,
  type ResolvedContextSignals,
} from './context-sufficiency'

const SPEC: ContextFactSpec = {
  facts: [
    { key: 'product', label: 'Product', required: true, gatherHint: 'what they are taking to market' },
    { key: 'goal', label: 'Primary goal', required: true, gatherHint: 'the goal this quarter' },
    { key: 'icp', label: 'Ideal customer', gatherHint: 'a specific role, not a market' },
    { key: 'website', label: 'Website' },
  ],
  toolHints: ['When they name a site, run `brand-intake <url>` to extract their kit.'],
}

const signals = (
  facts: Record<string, string | undefined>,
  substrate: Record<string, boolean>,
): ResolvedContextSignals => ({ facts, substrate })

describe('computeContextSufficiency', () => {
  it('required facts missing → not ready, missing list populated', () => {
    const s = computeContextSufficiency(SPEC, signals({}, { brandConfirmed: true }))
    expect(s.ready).toBe(false)
    expect(s.hasScope).toBe(false)
    expect(s.missingFacts.map((f) => f.key)).toEqual(['product', 'goal'])
    expect(s.missingFacts[0]?.gatherHint).toBe('what they are taking to market')
  })

  it('all required facts + a substrate flag → ready', () => {
    const s = computeContextSufficiency(
      SPEC,
      signals({ product: 'Acme', goal: 'sign 10 design partners' }, { configHasContext: true }),
    )
    expect(s.ready).toBe(true)
    expect(s.hasScope).toBe(true)
    expect(s.hasSubstrate).toBe(true)
    expect(s.missingFacts).toEqual([])
    expect(s.knownFacts.map((f) => f.key)).toEqual(['product', 'goal'])
  })

  it('facts present but no substrate → not ready', () => {
    const s = computeContextSufficiency(
      SPEC,
      signals({ product: 'Acme', goal: 'launch' }, { brandConfirmed: false, configHasContext: false }),
    )
    expect(s.hasScope).toBe(true)
    expect(s.hasSubstrate).toBe(false)
    expect(s.ready).toBe(false)
    expect(s.missingFacts).toEqual([])
  })

  it('substrate present but a required fact missing → not ready', () => {
    const s = computeContextSufficiency(
      SPEC,
      signals({ product: 'Acme' }, { coreKnowledgePresent: true }),
    )
    expect(s.hasSubstrate).toBe(true)
    expect(s.hasScope).toBe(false)
    expect(s.ready).toBe(false)
    expect(s.missingFacts.map((f) => f.key)).toEqual(['goal'])
  })

  it('optional facts with values appear as known but never as missing', () => {
    const s = computeContextSufficiency(
      SPEC,
      signals({ product: 'Acme', goal: 'launch', website: 'https://acme.dev' }, { configHasContext: true }),
    )
    expect(s.knownFacts.map((f) => f.key)).toEqual(['product', 'goal', 'website'])
    expect(s.missingFacts).toEqual([])
  })

  it('blank / whitespace-only fact values do not count as present', () => {
    const s = computeContextSufficiency(
      SPEC,
      signals({ product: '   ', goal: '' }, { configHasContext: true }),
    )
    expect(s.hasScope).toBe(false)
    expect(s.knownFacts).toEqual([])
    expect(s.missingFacts.map((f) => f.key)).toEqual(['product', 'goal'])
  })

  it('empty spec + empty signals → not ready, no throw', () => {
    const s = computeContextSufficiency({ facts: [] }, signals({}, {}))
    expect(s.ready).toBe(false)
    // No required facts → scope vacuously met; no substrate flag → still not ready.
    expect(s.hasScope).toBe(true)
    expect(s.hasSubstrate).toBe(false)
    expect(s.knownFacts).toEqual([])
    expect(s.missingFacts).toEqual([])
  })

  it('tolerates malformed signal maps without throwing', () => {
    const loose = { facts: undefined, substrate: undefined } as unknown as ResolvedContextSignals
    expect(() => computeContextSufficiency(SPEC, loose)).not.toThrow()
    const s = computeContextSufficiency(SPEC, loose)
    expect(s.ready).toBe(false)
    expect(s.missingFacts.map((f) => f.key)).toEqual(['product', 'goal'])
  })
})

describe('buildContextGatherPrompt', () => {
  it('lists known facts, missing facts with hints, the no-form directive, and tool hints', () => {
    const s = computeContextSufficiency(
      SPEC,
      signals({ product: 'Acme' }, { brandConfirmed: false }),
    )
    const prompt = buildContextGatherPrompt(SPEC, s)
    expect(prompt).toContain('### Context you already have')
    expect(prompt).toContain('- Product: Acme')
    expect(prompt).toContain('### Context still missing')
    expect(prompt).toContain('Primary goal — the goal this quarter')
    expect(prompt).toContain('Do not run an interview')
    expect(prompt).toContain('Never present a form')
    expect(prompt).toContain('brand-intake')
  })

  it('emits the substrate directive when scope is met but no substrate exists', () => {
    const s = computeContextSufficiency(
      SPEC,
      signals({ product: 'Acme', goal: 'launch' }, { configHasContext: false }),
    )
    const prompt = buildContextGatherPrompt(SPEC, s)
    expect(prompt).toContain('### Context you already have')
    expect(prompt).toContain('no durable substrate')
    expect(prompt).not.toContain('### Context still missing')
  })

  it('returns "" when ready with nothing to surface', () => {
    // A spec whose only fact is required-and-resolved leaves no known optional
    // facts and no gaps; with substrate met there is nothing to say.
    const spec: ContextFactSpec = { facts: [{ key: 'product', label: 'Product', required: true }] }
    const s = computeContextSufficiency(spec, signals({ product: 'Acme' }, { configHasContext: true }))
    expect(s.ready).toBe(true)
    // Known facts ARE surfaced (Product: Acme); the "nothing to surface" case is
    // an empty spec resolved against empty signals with substrate met.
    const emptySpec: ContextFactSpec = { facts: [] }
    const emptyReady = computeContextSufficiency(emptySpec, signals({}, { configHasContext: true }))
    expect(emptyReady.ready).toBe(true)
    expect(buildContextGatherPrompt(emptySpec, emptyReady)).toBe('')
  })

  it('renders only known facts when ready but optional facts are present', () => {
    const s = computeContextSufficiency(
      SPEC,
      signals({ product: 'Acme', goal: 'launch', website: 'https://acme.dev' }, { configHasContext: true }),
    )
    const prompt = buildContextGatherPrompt(SPEC, s)
    expect(prompt).toContain('- Website: https://acme.dev')
    expect(prompt).not.toContain('### Context still missing')
    expect(prompt).not.toContain('no durable substrate')
  })

  it('empty inputs → "" with no throw', () => {
    const s = computeContextSufficiency({ facts: [] }, signals({}, { ready: true }))
    expect(buildContextGatherPrompt({ facts: [] }, s)).toBe('')
  })
})
