/**
 * Drizzle/D1 adapter for the cross-agent skill marketplace — the durable
 * store shape shared by every product that publishes or reads a shared
 * catalog (see `./skills` for the entry format and merge contract).
 *
 * Kept on its own subpath so `./skills` stays substrate-free: this is the
 * only marketplace entry that touches the drizzle peer, mirroring
 * `./agent-profiles/drizzle`.
 */
import type { MarketplaceSkill, MarketplaceStore } from './marketplace'
import { validateMarketplaceCatalog } from './marketplace'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Any drizzle database instance (structural — the adapter only uses select
 *  over the standard table shape). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleLike = any

/** The standard marketplace table: one row per namespaced `product:id`.
 *  Create it in a drizzle/D1 database, publish rows via
 *  `marketplaceRowsFor`, read via {@link createDrizzleMarketplaceStore}. */
export function marketplaceSkillTable(tableName = 'skill_marketplace') {
  return sqliteTable(tableName, {
    id: text('id').primaryKey(), // namespaced `product:id`
    product: text('product').notNull(),
    skillId: text('skill_id').notNull(),
    description: text('description').notNull(),
    source: text('source'),
  })
}

/** A drizzle-backed read-only MarketplaceStore over the standard table. */
export function createDrizzleMarketplaceStore(
  db: DrizzleLike,
  table: ReturnType<typeof marketplaceSkillTable>,
): MarketplaceStore {
  return {
    async list(): Promise<readonly MarketplaceSkill[]> {
      const rows: Array<{ id: string; product: string; skillId: string; description: string; source: string | null }>
        = await db.select().from(table)
      return validateMarketplaceCatalog(rows.map((row) => ({
        id: row.skillId,
        product: row.product,
        description: row.description,
        ...(row.source !== null && row.source !== undefined ? { source: row.source } : {}),
      })))
    },
  }
}
