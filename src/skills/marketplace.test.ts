import { describe, expect, it } from 'vitest'
import {
  MAX_MARKETPLACE_ENTRIES,
  createInMemoryMarketplaceStore,
  createKVMarketplaceStore,
  marketplaceDiscoveryLine,
  marketplaceRowsFor,
  mergeSkillCatalogs,
  namespacedSkillId,
  parseNamespacedSkillId,
  validateMarketplaceCatalog,
  type MarketplaceSkill,
} from './marketplace'

const KICAD: MarketplaceSkill = { id: 'kicad', product: 'hardware', description: 'PCB analysis: schematics, layouts, DRC, BOM extraction' }
const ANATOMY: MarketplaceSkill = { id: 'anatomy', product: 'hardware', description: 'Crafted interactive isometric figures of real machines' }
const PATENT: MarketplaceSkill = { id: 'patent-drawings', product: 'legal', description: 'Formal patent figure conventions from rough sketches' }
const SHARED: readonly MarketplaceSkill[] = [KICAD, ANATOMY, PATENT]

describe('validateMarketplaceCatalog', () => {
  it('accepts a well-formed catalog and sorts it stably', () => {
    const validated = validateMarketplaceCatalog([PATENT, KICAD, ANATOMY])
    expect(validated.map(namespacedSkillId)).toEqual(['hardware:anatomy', 'hardware:kicad', 'legal:patent-drawings'])
  })

  it('refuses malformed ids, products, and descriptions at wiring time', () => {
    expect(() => validateMarketplaceCatalog([{ id: 'Bad_Id', product: 'hardware', description: 'x' }])).toThrow(/slug/)
    expect(() => validateMarketplaceCatalog([{ id: 'kicad', product: 'Hardware', description: 'x' }])).toThrow(/slug/)
    expect(() => validateMarketplaceCatalog([{ id: 'kicad', product: 'hardware', description: '   ' }])).toThrow(/empty description/)
    expect(() => validateMarketplaceCatalog([{
      id: 'kicad', product: 'hardware', description: 'x'.repeat(241),
    }])).toThrow(/exceeds 240 chars/)
  })

  it('refuses duplicates and over-cap catalogs', () => {
    expect(() => validateMarketplaceCatalog([KICAD, KICAD])).toThrow(/duplicate entry: hardware:kicad/)
    const many = Array.from({ length: MAX_MARKETPLACE_ENTRIES + 1 }, (_, i) => ({
      id: `s${i}`, product: 'hardware', description: `skill ${i}`,
    }))
    expect(() => validateMarketplaceCatalog(many)).toThrow(/exceeds 64 entries/)
  })
})

describe('namespacing', () => {
  it('mounts shared skills as product:id and parses back', () => {
    expect(namespacedSkillId(KICAD)).toBe('hardware:kicad')
    expect(parseNamespacedSkillId('hardware:kicad')).toEqual({ product: 'hardware', id: 'kicad' })
    expect(parseNamespacedSkillId('cad')).toEqual({ product: null, id: 'cad' })
  })
})

describe('mergeSkillCatalogs', () => {
  it('unions local and shared, namespaced, local precedence, sorted', () => {
    const merged = mergeSkillCatalogs(
      [{ id: 'cad', description: 'text-to-CAD baseline' }, { id: 'anatomy', description: 'the local anatomy kit' }],
      SHARED,
    )
    expect(merged.map((s) => s.id)).toEqual([
      'anatomy',
      'cad',
      'hardware:anatomy',
      'hardware:kicad',
      'legal:patent-drawings',
    ])
    // Local precedence: the local anatomy description is untouched.
    expect(merged.find((s) => s.id === 'anatomy')?.description).toBe('the local anatomy kit')
    // Shared entries are annotated with their owner.
    expect(merged.find((s) => s.id === 'hardware:kicad')?.description).toBe('PCB analysis: schematics, layouts, DRC, BOM extraction (shared by hardware)')
  })

  it('is idempotent (merging twice changes nothing) and empty-safe', () => {
    const once = mergeSkillCatalogs([{ id: 'cad', description: 'd' }], SHARED)
    const twice = mergeSkillCatalogs(once as { id: string; description: string }[], SHARED)
    expect(twice).toEqual(once)
    expect(mergeSkillCatalogs([], [])).toEqual([])
  })
})

describe('marketplaceDiscoveryLine', () => {
  it('names every shared skill on one sorted line', () => {
    expect(marketplaceDiscoveryLine(SHARED)).toBe(
      'Shared skills from other products, mountable by id: '
      + 'hardware:anatomy (Crafted interactive isometric figures of real machines); '
      + 'hardware:kicad (PCB analysis: schematics, layouts, DRC, BOM extraction); '
      + 'legal:patent-drawings (Formal patent figure conventions from rough sketches).',
    )
  })

  it('is null when there is nothing to share', () => {
    expect(marketplaceDiscoveryLine([])).toBeNull()
  })
})

describe('stores', () => {
  it('in-memory store validates at construction and serves the catalog', async () => {
    const store = createInMemoryMarketplaceStore(SHARED)
    expect((await store.list()).map(namespacedSkillId)).toContain('hardware:kicad')
    expect(() => createInMemoryMarketplaceStore([{ id: '', product: 'hardware', description: 'x' }])).toThrow()
  })

  it('KV store parses the catalog JSON and fails loud on garbage', async () => {
    const kv = {
      data: new Map<string, string>([['marketplace:catalog', JSON.stringify(SHARED)]]),
      async get(key: string) { return this.data.get(key) ?? null },
    }
    expect((await createKVMarketplaceStore(kv).list()).length).toBe(3)
    const broken = { data: new Map<string, string>([['marketplace:catalog', '{oops']]), async get(key: string) { return this.data.get(key) ?? null } }
    await expect(createKVMarketplaceStore(broken).list()).rejects.toThrow(/not valid JSON/)
    const empty = { async get() { return null } }
    expect(await createKVMarketplaceStore(empty).list()).toEqual([])
  })

  it('rows helper renders the standard table shape, validated', () => {
    const rows = marketplaceRowsFor(SHARED)
    expect(rows[0]).toEqual({
      id: 'hardware:anatomy',
      product: 'hardware',
      skillId: 'anatomy',
      description: ANATOMY.description,
      source: null,
    })
    expect(() => marketplaceRowsFor([{ id: 'x', product: 'p', description: '' }])).toThrow(/empty description/)
  })
})
