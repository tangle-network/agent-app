/**
 * knip's entries must cover every `tsup.config.ts` entry.
 *
 * Why this test exists: knip treats an entry's exports as public API and only
 * reports dead code BELOW an entry. A subpath that is built and published but
 * missing from knip's entries is invisible to the dead-surface gate. knip.ts now
 * derives the built entries from tsup, so this guards the derivation itself:
 * the parser must find the entry map, and every built entry must reach knip.
 */
import { describe, expect, it } from 'vitest'
import config, { tsupEntries, UNBUILT_ENTRIES } from '../knip'

describe('knip entry coverage', () => {
  it('names every built entry, so no published subpath escapes the dead-surface gate', () => {
    const built = tsupEntries()
    const declared = new Set(config.entry)
    expect(built.length).toBeGreaterThan(50)
    expect(built.filter((entry) => !declared.has(entry))).toEqual([])
  })

  it('adds only unbuilt globs by hand', () => {
    const built = new Set(tsupEntries())
    expect(config.entry.filter((entry) => !built.has(entry))).toEqual(UNBUILT_ENTRIES)
  })
})
