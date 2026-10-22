/** Shared skill catalog validation and local/shared catalog composition. */

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
const MAX_MARKETPLACE_ENTRIES = 64

/** Validate one marketplace entry — fail loud on a malformed catalog rather
 *  than silently mis-mounting it. */
function validateMarketplaceSkill(entry: MarketplaceSkill): MarketplaceSkill {
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
function namespacedSkillId(entry: { product: string; id: string }): string {
  return `${entry.product}:${entry.id}`
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
