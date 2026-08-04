import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PROVENANCE_CONFIDENCE_POLICY,
  PROVENANCE_BASES,
  describeProvenance,
  describeProvenanceSourceStatus,
  loadingProvenanceSources,
  provenanceBasisMeta,
  provenanceGaps,
  provenanceNextMove,
  provenanceStandingMeta,
  provenanceTriggerLabel,
  resolveProvenanceStanding,
  rollUpProvenanceStanding,
  standingFromConfidence,
  weakerProvenanceStanding,
  type ProvenanceRecord,
} from './provenance-model'

const W2: ProvenanceRecord = {
  label: 'Wages',
  display: '$128,450.00',
  basis: 'extracted',
  sources: [{ label: 'Form W-2 (Acme Corp)', locator: 'box 1', quote: '128,450.00', href: '/docs/w2' }],
}

describe('the four bases', () => {
  it('carry distinct words, so the distinction survives greyscale and a screen reader', () => {
    const labels = PROVENANCE_BASES.map((basis) => provenanceBasisMeta(basis).label)
    const meanings = PROVENANCE_BASES.map((basis) => provenanceBasisMeta(basis).meaning)
    expect(new Set(labels).size).toBe(4)
    expect(new Set(meanings).size).toBe(4)
    // The trust spine: a person's entry and a model's assertion are the two
    // that must never read alike.
    expect(provenanceBasisMeta('entered').label).not.toBe(provenanceBasisMeta('asserted').label)
  })

  it('names what each can be checked against, and admits that an assertion cannot be', () => {
    expect(provenanceBasisMeta('extracted').checkableAgainst).toBe('the document it was read from')
    expect(provenanceBasisMeta('entered').checkableAgainst).toBe('the person who entered it')
    expect(provenanceBasisMeta('computed').checkableAgainst).toBe('the values it was computed from')
    expect(provenanceBasisMeta('asserted').checkableAgainst).toBeNull()
  })
})

describe('confidence becomes a next move, never a number', () => {
  it('maps a confidence to a standing under the default policy', () => {
    expect(standingFromConfidence(0.95)).toBe('settled')
    expect(standingFromConfidence(0.89)).toBe('check')
    expect(standingFromConfidence(0.4)).toBe('confirm')
  })

  it('takes the thresholds a product supplies — the policy is a parameter, not a truth', () => {
    const strict = { settledAtOrAbove: 0.99, checkAtOrAbove: 0.95 }
    expect(standingFromConfidence(0.96, strict)).toBe('check')
    expect(standingFromConfidence(0.96, DEFAULT_PROVENANCE_CONFIDENCE_POLICY)).toBe('settled')
  })

  it('states an action for every standing, and no standing copy carries a number', () => {
    for (const standing of ['settled', 'check', 'confirm'] as const) {
      const meta = provenanceStandingMeta(standing)
      expect(meta.action.length).toBeGreaterThan(20)
      expect(`${meta.label} ${meta.action}`).not.toMatch(/\d|%/)
    }
  })
})

describe('resolveProvenanceStanding floors', () => {
  it('settles a document-backed value', () => {
    expect(resolveProvenanceStanding(W2)).toBe('settled')
  })

  it('never settles an agent assertion, whatever confidence it reports about itself', () => {
    expect(resolveProvenanceStanding({ display: '3', basis: 'asserted', confidence: 1 })).toBe('check')
  })

  it('forces confirmation when a value claims a document and names none', () => {
    expect(resolveProvenanceStanding({ display: '3', basis: 'extracted' })).toBe('confirm')
  })

  it('forces confirmation when a computed value records no inputs', () => {
    expect(resolveProvenanceStanding({ display: '3', basis: 'computed' })).toBe('confirm')
  })

  it('forces a check when a named source cannot be opened', () => {
    const record: ProvenanceRecord = {
      display: '$10',
      basis: 'extracted',
      sources: [{ label: 'Receipt 4471', status: 'unavailable', unavailableReason: 'the file was removed' }],
    }
    expect(resolveProvenanceStanding(record)).toBe('check')
  })

  it('leaves a still-loading source alone — a load in flight is not a missing source', () => {
    const record: ProvenanceRecord = {
      display: '$10',
      basis: 'extracted',
      sources: [{ label: 'Receipt 4471', status: 'loading' }],
    }
    expect(resolveProvenanceStanding(record)).toBe('settled')
    expect(provenanceGaps(record)).toEqual([])
    expect(loadingProvenanceSources(record)).toHaveLength(1)
  })

  it('lets an explicit standing weaken a value but never strengthen it past a floor', () => {
    expect(resolveProvenanceStanding({ ...W2, standing: 'confirm' })).toBe('confirm')
    expect(resolveProvenanceStanding({ display: '3', basis: 'extracted', standing: 'settled' })).toBe('confirm')
  })
})

describe('gaps say what is missing', () => {
  it('names an absent document', () => {
    const [gap] = provenanceGaps({ display: '3', basis: 'extracted' })
    expect(gap?.kind).toBe('no-source')
    expect(gap?.message).toContain('no document is on file')
  })

  it('names absent inputs', () => {
    const [gap] = provenanceGaps({ display: '3', basis: 'computed' })
    expect(gap?.kind).toBe('no-inputs')
  })

  it('carries the reason a source could not be opened', () => {
    const source = { label: 'Receipt 4471', status: 'unavailable' as const, unavailableReason: 'the file was removed' }
    const [gap] = provenanceGaps({ display: '3', basis: 'extracted', sources: [source] })
    expect(gap?.kind).toBe('unavailable-source')
    expect(gap?.message).toBe('Receipt 4471 could not be opened — the file was removed')
    expect(gap?.source).toBe(source)
  })

  it('still says a source could not be opened when no reason was supplied', () => {
    expect(describeProvenanceSourceStatus({ label: 'Receipt 4471', status: 'unavailable' })).toBe(
      'Receipt 4471 could not be opened.',
    )
    expect(describeProvenanceSourceStatus({ label: 'Receipt 4471' })).toBeNull()
  })
})

describe('composition — a total is only as strong as its weakest input', () => {
  const total: ProvenanceRecord = {
    label: 'Total income',
    display: '$131,450.00',
    basis: 'computed',
    derivation: 'wages + interest',
    inputs: [W2, { label: 'Interest', display: '$3,000.00', basis: 'asserted', confidence: 0.97 }],
  }

  it('weakens a computed value to its weakest input', () => {
    expect(resolveProvenanceStanding(total)).toBe('settled')
    expect(rollUpProvenanceStanding(total)).toBe('check')
  })

  it('carries the floor of a nested input all the way up', () => {
    const nested: ProvenanceRecord = {
      display: '$1',
      basis: 'computed',
      inputs: [{ display: '$1', basis: 'computed', inputs: [{ display: '$1', basis: 'extracted' }] }],
    }
    expect(rollUpProvenanceStanding(nested)).toBe('confirm')
  })

  it('terminates on a record that reaches itself', () => {
    const inputs: ProvenanceRecord[] = []
    const cyclic: ProvenanceRecord = { display: '$1', basis: 'computed', inputs }
    inputs.push(cyclic)
    expect(rollUpProvenanceStanding(cyclic)).toBe('settled')
  })

  it('orders standings by severity', () => {
    expect(weakerProvenanceStanding('settled', 'check')).toBe('check')
    expect(weakerProvenanceStanding('confirm', 'check')).toBe('confirm')
    expect(weakerProvenanceStanding('settled', 'settled')).toBe('settled')
  })
})

describe('describeProvenance', () => {
  it('names the document and the place in it', () => {
    expect(describeProvenance(W2)).toBe('Read from Form W-2 (Acme Corp), box 1.')
  })

  it('counts the sources past the first', () => {
    expect(
      describeProvenance({ ...W2, sources: [...(W2.sources ?? []), { label: 'Payroll export' }] }),
    ).toBe('Read from Form W-2 (Acme Corp), box 1 and 1 more source.')
  })

  it('names the person', () => {
    expect(describeProvenance({ display: 'Married filing jointly', basis: 'entered', sources: [{ label: 'Dana Whitfield' }] })).toBe(
      'Entered by Dana Whitfield.',
    )
  })

  it('prefers the words the caller supplied for a computation, else names the inputs', () => {
    expect(describeProvenance({ display: '$4', basis: 'computed', derivation: 'wages + interest', inputs: [W2] })).toBe(
      'Computed from wages + interest.',
    )
    expect(
      describeProvenance({
        display: '$4',
        basis: 'computed',
        inputs: [W2, { label: 'Interest', display: '$3', basis: 'entered' }],
      }),
    ).toBe('Computed from Wages, Interest.')
  })

  it('says an assertion has nothing behind it', () => {
    expect(describeProvenance({ display: '3', basis: 'asserted' })).toBe(
      'Stated by the agent, with no source to check it against.',
    )
    expect(describeProvenance({ display: '3', basis: 'asserted', sources: [{ label: 'IRS Pub 17' }] })).toBe(
      'Stated by the agent, pointing at IRS Pub 17 — not verified against it.',
    )
  })

  it('states the absence rather than going quiet', () => {
    expect(describeProvenance({ display: '3', basis: 'extracted' })).toBe(
      'Read from a document, but no document is on file.',
    )
    expect(describeProvenance({ display: '3', basis: 'computed' })).toBe(
      'Computed, but the values it was computed from are not recorded.',
    )
  })
})

describe('provenanceNextMove — the move this reader can actually make', () => {
  it('never tells a reader to open a source that is not on file', () => {
    const move = provenanceNextMove({ display: '3', basis: 'extracted' }, 'confirm')
    expect(move).not.toContain('Open the source')
    expect(move).toBe('Nobody recorded where this came from. Confirm the value and record its source before it is used.')
  })

  it('names recording the inputs when a computation recorded none', () => {
    expect(provenanceNextMove({ display: '3', basis: 'computed' }, 'confirm')).toContain('record its inputs')
  })

  it('offers the retry when the source exists but would not open', () => {
    const record: ProvenanceRecord = {
      display: '$10',
      basis: 'extracted',
      sources: [{ label: 'Receipt 4471', status: 'unavailable', unavailableReason: 'the file was removed' }],
    }
    expect(provenanceNextMove(record, 'check')).toContain('Try again')
  })

  it('sends the reader to the real document when the agent cited nothing', () => {
    expect(provenanceNextMove({ display: '3', basis: 'asserted' }, 'check')).toBe(
      'The agent gave no source. Check this against the real document before you rely on it.',
    )
  })

  it('points one level down when only an input weakened the total', () => {
    const total: ProvenanceRecord = {
      display: '$4',
      basis: 'computed',
      inputs: [W2, { display: '$3', basis: 'asserted' }],
    }
    expect(provenanceNextMove(total, rollUpProvenanceStanding(total))).toContain('computed from still needs checking')
  })

  it('falls back to the generic words for the standing when there is a source to open', () => {
    expect(provenanceNextMove({ ...W2, confidence: 0.7 }, 'check')).toBe(provenanceStandingMeta('check').action)
  })
})

describe('provenanceTriggerLabel', () => {
  it('announces the value, its basis, and the next move', () => {
    expect(provenanceTriggerLabel(W2, 'settled')).toBe('Where Wages “$128,450.00” came from — From document.')
    expect(provenanceTriggerLabel(W2, 'check')).toBe(
      'Where Wages “$128,450.00” came from — From document. Check the source.',
    )
  })

  it('names a missing value as missing', () => {
    expect(provenanceTriggerLabel({ display: '   ', basis: 'asserted' }, 'confirm')).toBe(
      'Where this missing value came from — Agent, unverified. Needs a person.',
    )
  })
})
