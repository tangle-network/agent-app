/**
 * The cross-agent skill marketplace — a shared catalog contract on top of the
 * self-mount verb.
 *
 * Every product with the self-improve verb carries its own skill catalog
 * (8–12 skills each, fleet-wide), mounting them through
 * `createMountProfileChangeTool`, which already validates ids, caps mounts
 * and protects the baseline. What the fleet lacks is SHARING: a kicad skill
 * proven on hardware-agent should mount on the legal agent (patent drawings)
 * or the creative agent (product CAD) without a copy in every repo.
 *
 * This module is the marketplace's substrate: the catalog ENTRY format, a
 * read-only store port with the standard adapters, the merge that unions a
 * product's local catalog with shared entries (namespaced `product:id`,
 * local precedence, deduped, capped), and the one-line discovery fragment
 * products surface next to the verb's catalog. Mounting, validation, caps
 * and baseline protection stay exactly where they were proven — in the
 * verb. The marketplace only decides what MAY be discovered and mounted.
 *
 * An entry advertises the skill's identity, not its content: the owning
 * product ships SKILL.md bodies and executable companions in its own repo
 * (and its own profile mounts), so sharing is opt-in per product and the
 * entry is honest about what a foreign mount means — the description and
 * the owning product, nothing hidden.
 */

/** A shareable skill as the owning product publishes it. */
export interface MarketplaceSkill {
  /** Registry-unique skill id WITHIN the owning product (slug: lowercase
   *  letters, digits, hyphens). Mounted cross-product as `product:id`. */
  readonly id: string
  /** The owning product's slug (same alphabet). */
  readonly product: string
  /** One-line description surfaced in discovery and the verb's catalog. */
  readonly description: string
  /** Optional pointer to where the skill's content lives (repo path, url).
   *  Provenance only — never fetched by this module. */
  readonly source?: string
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/
const MAX_DESCRIPTION_CHARS = 240
/** Bound on a shared catalog so discovery text stays a prompt-sized line,
 *  not a dump. */
export const MAX_MARKETPLACE_ENTRIES = 64

/** Validate one marketplace entry — fail loud on a malformed catalog rather
 *  than silently mis-mounting it. */
export function validateMarketplaceSkill(entry: MarketplaceSkill): MarketplaceSkill {
  if (!SLUG.test(entry.id)) throw new Error(`marketplace skill id "${entry.id}" must be a slug ([a-z0-9-])`)
  if (!SLUG.test(entry.product)) throw new Error(`marketplace skill product "${entry.product}" must be a slug ([a-z0-9-])`)
  const description = entry.description.trim()
  if (!description) throw new Error(`marketplace skill ${entry.product}:${entry.id} has an empty description`)
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(
      `marketplace skill ${entry.product}:${entry.id} description exceeds ${MAX_DESCRIPTION_CHARS} chars ` +
      `(got ${description.length}) — discovery must stay one line`,
    )
  }
  return { ...entry, description }
}

/** The mounted id for a shared skill: `product:id` (namespaced so a foreign
 *  skill can never shadow a local one). */
export function namespacedSkillId(entry: { product: string; id: string }): string {
  return `${entry.product}:${entry.id}`
}

/** Split a namespaced id back into `{ product, id }`; a bare id resolves to
 *  product `null` (a local skill). */
export function parseNamespacedSkillId(mountedId: string): { product: string | null; id: string } {
  const colon = mountedId.indexOf(':')
  if (colon <= 0) return { product: null, id: mountedId }
  return { product: mountedId.slice(0, colon), id: mountedId.slice(colon + 1) }
}

/** Validate a whole shared catalog: entries well-formed, ids unique, size
 *  capped. Returns the validated entries in stable (product, id) order. */
export function validateMarketplaceCatalog(entries: readonly MarketplaceSkill[]): readonly MarketplaceSkill[] {
  if (entries.length > MAX_MARKETPLACE_ENTRIES) {
    throw new Error(`marketplace catalog exceeds ${MAX_MARKETPLACE_ENTRIES} entries (got ${entries.length})`)
  }
  const seen = new Set<string>()
  const validated = entries.map((entry) => {
    const clean = validateMarketplaceSkill(entry)
    const key = namespacedSkillId(clean)
    if (seen.has(key)) throw new Error(`marketplace catalog has a duplicate entry: ${key}`)
    seen.add(key)
    return clean
  })
  return validated.sort((a, b) => (a.product === b.product
    ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    : (a.product < b.product ? -1 : 1)))
}

/** A shared-skill entry as it joins a product's local catalog: the
 *  namespaced mount id plus the description (annotated with the owner). */
export interface CatalogSkillEntry {
  readonly id: string
  readonly description: string
}

/** Union a product's local catalog with shared marketplace entries.
 *
 * Precedence: LOCAL WINS — a namespaced shared id can never collide with a
 * bare local one, and if a product ever adopts its own shared entry, the
 * local description stays authoritative. Output is deduped, sorted, and
 * safe to hand straight to `createMountProfileChangeTool`'s `skills`. */
export function mergeSkillCatalogs(
  local: readonly CatalogSkillEntry[],
  shared: readonly MarketplaceSkill[],
): readonly CatalogSkillEntry[] {
  const byId = new Map<string, CatalogSkillEntry>()
  for (const entry of local) byId.set(entry.id, entry)
  for (const entry of shared) {
    const id = namespacedSkillId(entry)
    if (byId.has(id)) continue
    byId.set(id, { id, description: `${entry.description} (shared by ${entry.product})` })
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The discovery fragment: one line naming every shared skill a foreign
 *  agent can mount, for system prompts and tool descriptions. Returns null
 *  when there is nothing to share (no line, no prompt cost). */
export function marketplaceDiscoveryLine(shared: readonly MarketplaceSkill[]): string | null {
  if (shared.length === 0) return null
  const entries = shared
    .map((entry) => `${namespacedSkillId(entry)} (${entry.description})`)
    .sort()
    .join('; ')
  return `Shared skills from other products, mountable by id: ${entries}.`
}

/** Read-only view over a shared catalog. Products source it from their own
 *  D1/KV, a platform registry, or a pinned static list — the port stays the
 *  same. */
export interface MarketplaceStore {
  list(): Promise<readonly MarketplaceSkill[]>
}

/** Non-durable default for tests and single-instance products. Validates on
 *  construction so a malformed catalog fails at wiring, not at mount. */
export function createInMemoryMarketplaceStore(entries: readonly MarketplaceSkill[]): MarketplaceStore {
  const validated = validateMarketplaceCatalog(entries)
  return { async list() { return validated } }
}

/** Static-list store over a product-pinned catalog (checked into the
 *  product repo). Same validation guarantees, no async source. */
export const createStaticMarketplaceStore = createInMemoryMarketplaceStore

/** A KV-backed read-only MarketplaceStore (Cloudflare KV or any lookalike).
 *  The whole catalog is one JSON value at `prefix:catalog`. */
export function createKVMarketplaceStore(
  kv: { get(key: string): Promise<string | null> },
  prefix = 'marketplace',
): MarketplaceStore {
  return {
    async list(): Promise<readonly MarketplaceSkill[]> {
      const raw = await kv.get(`${prefix}:catalog`)
      if (!raw) return []
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { throw new Error(`marketplace catalog at ${prefix}:catalog is not valid JSON`) }
      if (!Array.isArray(parsed)) throw new Error(`marketplace catalog at ${prefix}:catalog is not a JSON array`)
      return validateMarketplaceCatalog(parsed as MarketplaceSkill[])
    },
  }
}

/** Publish helper for the write side (products/platform own the writer):
 *  render validated rows for the standard table (see
 *  `./skills/marketplace-drizzle` for the table itself). */
export interface MarketplaceRow {
  readonly id: string
  readonly product: string
  readonly skillId: string
  readonly description: string
  readonly source: string | null
}

export function marketplaceRowsFor(entries: readonly MarketplaceSkill[]): readonly MarketplaceRow[] {
  return validateMarketplaceCatalog(entries).map((entry) => ({
    id: namespacedSkillId(entry),
    product: entry.product,
    skillId: entry.id,
    description: entry.description,
    source: entry.source ?? null,
  }))
}
