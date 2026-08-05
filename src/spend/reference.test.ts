/**
 * The settlement reference id is the ONLY place a consumer can read the billed
 * interval's start — the ledger row stores no duration. Misparsing it silently
 * turns every duration check into a no-op, so these pin the exact grammar the
 * platform mints (`sandbox:<kind>:<resourceId>:<intervalStart>`).
 */
import { describe, expect, it } from 'vitest'
import {
  chargeNanoUsd,
  isCharge,
  parseSandboxGroupKey,
  parseSettlementReference,
  settlementSandboxId,
} from './reference'
import type { SettlementRow } from './types'

function row(over: Partial<SettlementRow> = {}): SettlementRow {
  return {
    id: 'tx_1',
    referenceId: 'sandbox:stop:sb_abc:1753900000000',
    amountNanoUsd: -1_000_000_000,
    type: 'compute',
    product: 'sandbox',
    groupKey: 'sandbox:sb_abc',
    createdAt: 1_754_000_000_000,
    description: null,
    costBasisNanoUsd: null,
    billedMs: null,
    ...over,
  }
}

describe('parseSettlementReference', () => {
  it('reads the kind, the sandbox, and the interval cursor off a stop settlement', () => {
    expect(parseSettlementReference('sandbox:stop:sb_abc:1753900000000')).toEqual({
      kind: 'stop',
      resourceId: 'sb_abc',
      intervalStartMs: 1_753_900_000_000,
    })
  })

  it('reads a heartbeat claim, which carries the same interval cursor', () => {
    expect(parseSettlementReference('sandbox:compute:sb_abc:1753900000000')?.kind).toBe('compute')
  })

  it('reports no cursor for a kind that has none, rather than eating the id', () => {
    expect(parseSettlementReference('sandbox:gpu-lease:lease_77')).toEqual({
      kind: 'gpu-lease',
      resourceId: 'lease_77',
      intervalStartMs: null,
    })
  })

  it('keeps a colon inside a resource id instead of treating its tail as a cursor', () => {
    expect(parseSettlementReference('sandbox:stop:sb:with:colons')).toEqual({
      kind: 'stop',
      resourceId: 'sb:with:colons',
      intervalStartMs: null,
    })
  })

  it('returns null for references that are not sandbox settlements', () => {
    expect(parseSettlementReference('refund:sandbox-settlement:incident-20260805')).toBeNull()
    expect(parseSettlementReference('router:inference:abc')).toBeNull()
    expect(parseSettlementReference(null)).toBeNull()
    expect(parseSettlementReference('')).toBeNull()
    expect(parseSettlementReference('sandbox:stop')).toBeNull()
  })
})

describe('parseSandboxGroupKey', () => {
  it('reads the sandbox id off the aggregation key', () => {
    expect(parseSandboxGroupKey('sandbox:sb_abc')).toBe('sb_abc')
  })

  it('treats a null group key as "do not aggregate", not an error', () => {
    expect(parseSandboxGroupKey(null)).toBeNull()
    expect(parseSandboxGroupKey('other:thing')).toBeNull()
  })
})

describe('settlementSandboxId', () => {
  it('prefers the reference id, which is the field the platform dedups on', () => {
    expect(settlementSandboxId(row({ groupKey: 'sandbox:sb_stale' }))).toBe('sb_abc')
  })

  it('falls back to the group key when the reference carries no interval', () => {
    expect(settlementSandboxId(row({ referenceId: null }))).toBe('sb_abc')
  })

  it('is null for a row that names no sandbox at all', () => {
    expect(settlementSandboxId(row({ referenceId: null, groupKey: null }))).toBeNull()
  })
})

describe('charge sign', () => {
  it('reads a negative amount as a charge and a positive one as a credit', () => {
    expect(isCharge(row())).toBe(true)
    expect(chargeNanoUsd(row())).toBe(1_000_000_000)
    expect(isCharge(row({ amountNanoUsd: 500 }))).toBe(false)
    expect(chargeNanoUsd(row({ amountNanoUsd: 500 }))).toBe(0)
  })
})
