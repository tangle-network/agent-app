import { describe, expect, it } from 'vitest'

import { assertGateDiscriminates, calibrateGate, measureWithControl } from './calibration'

/**
 * Every case here is a real failure this package shipped, reduced to its
 * mechanism. If a change makes one of these pass when it should fail, the
 * gate has become self-confirming again.
 */
describe('calibrateGate', () => {
  it('refuses a gate that accepts everything — the shape behind `quote_verification 16/16`', async () => {
    const alwaysPasses = () => true
    const report = await calibrateGate(alwaysPasses, [
      { label: 'quote that occurs in the source', input: 'Box 1 Wages 128,450.00', expect: 'accept' },
      { label: 'quote the source never contains', input: 'Retirement distributions: none', expect: 'reject' },
    ])
    expect(report.discriminates).toBe(false)
    expect(report.failures).toHaveLength(1)
    expect(report.reason).toContain('quote the source never contains')
  })

  it('passes a gate that actually refuses the bad case', async () => {
    const source = 'Box 1   Wages, tips, other compensation ......... 128,450.00'
    const quoteOccurs = (quote: string) => source.includes(quote)
    const report = await calibrateGate(quoteOccurs, [
      { label: 'quote that occurs in the source', input: 'Wages, tips, other compensation', expect: 'accept' },
      { label: 'quote the source never contains', input: 'Retirement distributions: none', expect: 'reject' },
    ])
    expect(report.discriminates).toBe(true)
    expect(report.failures).toEqual([])
  })

  it('refuses a suite with no negative control — an untested gate is not evidence', async () => {
    const report = await calibrateGate(() => true, [
      { label: 'a good case', input: 1, expect: 'accept' },
      { label: 'another good case', input: 2, expect: 'accept' },
    ])
    expect(report.discriminates).toBe(false)
    expect(report.reason).toContain('no negative control')
  })

  it('refuses a suite with no positive control — an unsatisfiable gate selects for invented work', async () => {
    const report = await calibrateGate(() => false, [
      { label: 'a bad case', input: 1, expect: 'reject' },
      { label: 'another bad case', input: 2, expect: 'reject' },
    ])
    expect(report.discriminates).toBe(false)
    expect(report.reason).toContain('no positive control')
  })

  it('counts a throw as a rejection, so a fail-loud gate calibrates too', async () => {
    const failsLoud = (n: number) => {
      if (n < 0) throw new Error('negative amounts are not a claim')
      return true
    }
    const report = await calibrateGate(failsLoud, [
      { label: 'a real amount', input: 128450, expect: 'accept' },
      { label: 'a negative amount', input: -1, expect: 'reject' },
    ])
    expect(report.discriminates).toBe(true)
    expect(report.outcomes[1]?.threw).toBe('negative amounts are not a claim')
  })

  it('catches the self-confirming audit: re-reading the path you wrote cannot fail', async () => {
    // `audit_form` read back the widget names the writer had chosen, so a
    // value in "Combat zone" audited 3 passed / 0 failed.
    const written = new Map<string, string>()
    const selfConfirmingAudit = (field: { path: string; value: string }) => {
      written.set(field.path, field.value)
      return written.get(field.path) === field.value
    }
    const report = await calibrateGate(selfConfirmingAudit, [
      { label: 'value written to the wages widget', input: { path: 'f1_47[0]', value: '92,000' }, expect: 'accept' },
      { label: 'value written to a widget that is not the wages line', input: { path: 'f1_04[0]', value: '92,000' }, expect: 'reject' },
    ])
    expect(report.discriminates).toBe(false)
    expect(report.reason).toContain('not the wages line')
  })

  it('assertGateDiscriminates throws with the gate named', async () => {
    await expect(
      assertGateDiscriminates('quote_verification', () => true, [
        { label: 'good', input: 1, expect: 'accept' },
        { label: 'bad', input: 2, expect: 'reject' },
      ]),
    ).rejects.toThrow(/gate "quote_verification" is not evidence/)
  })
})

describe('measureWithControl', () => {
  it('reports a blind probe rather than a zero — the encrypted-column case', async () => {
    // `LIKE '%"type":"tool"%'` returned 0 of 332 because the column is
    // encrypted. The tell: the same probe returned 0 for `"type":"text"`,
    // which every assistant row must contain.
    const rows = ['__encrypted_parts__:a1b2', '__encrypted_parts__:c3d4']
    const report = await measureWithControl({
      measure: () => rows.filter((r) => r.includes('"type":"tool"')),
      control: () => rows.filter((r) => r.includes('"type":"text"')),
      count: (v) => v.length,
      controlLabel: 'assistant rows containing a text part',
    })
    expect(report.canSee).toBe(false)
    expect(report.measured).toBe(0)
    expect(report.reason).toContain('probe is blind')
  })

  it('believes a zero once the control registers', async () => {
    const rows = ['{"type":"text"}', '{"type":"text"}']
    const report = await measureWithControl({
      measure: () => rows.filter((r) => r.includes('"type":"tool"')),
      control: () => rows.filter((r) => r.includes('"type":"text"')),
      count: (v) => v.length,
      controlLabel: 'assistant rows containing a text part',
    })
    expect(report.canSee).toBe(true)
    expect(report.measured).toBe(0)
    expect(report.control).toBe(2)
  })
})
