/**
 * Live profile self-mounting — the safe, immediate subset of agent
 * self-improvement.
 *
 * The revision system ({@link ProfileRevision}, `PROFILE_CHANGE_POLICY`) owns
 * durable profile evolution: authority edits need editor consent, optimizer
 * revisions promote through eval. Self-mounting is the complementary
 * LIVE dimension — the sandboxed agent adjusts its own mounted context
 * (skills today) within a permitted, idempotent, catalog-validated delta.
 * Nothing here touches authority: model, permissions, tools denials and
 * billing identity are not agent-changeable dimensions, and every refusal
 * names the permitted set.
 *
 * One audited verb, not a family: `mount_profile_change` applies a validated
 * delta against a permitted-dimensions allowlist; re-applying the same delta
 * is a no-op; the baseline skill cannot be removed; the mount count is capped
 * because context is a budget.
 *
 * Products wire their own catalog and persistence:
 *
 * ```ts
 * import { createMountProfileChangeTool, createInMemorySelfMountStorage } from '@tangle-network/agent-app/agent-profiles'
 *
 * const mountProfileChange = createMountProfileChangeTool({
 *   skills: mySkillRegistry,                          // { id, description }[]
 *   storage: createD1SelfMountStorage(env.DB),        // or any { get, set }
 *   scopeKey: (ctx) => ctx.threadId ?? ctx.userId,    // product's persistence scope
 *   baseline: 'cad',
 * })
 * ```
 */
import { defineAppTool, type AppToolDefinition } from '../tools/registry'
import { ToolInputError } from '../tools/errors'
import type { AppToolContext } from '../tools/types'

/** The only profile dimensions an agent may change on its own mounted state.
 *  Anything else in a delta is refused with this list — the boundary is the
 *  schema, not the verb count. */
export const PERMITTED_SELF_MOUNT_DIMENSIONS = ['skills'] as const

export interface SelfMountSkillEntry {
  /** Registry-unique skill id. */
  id: string
  /** One-line description, surfaced in the tool's catalog. */
  description: string
}

/** Durable mounted-skill state, keyed by the product's scope. */
export interface SelfMountStorage {
  get(scope: string): Promise<readonly string[]>
  set(scope: string, ids: readonly string[]): Promise<void>
}

/** Non-durable default for tests and single-instance products. */
export function createInMemorySelfMountStorage(): SelfMountStorage {
  const state = new Map<string, string[]>()
  return {
    async get(scope) {
      return state.get(scope) ?? []
    },
    async set(scope, ids) {
      state.set(scope, [...new Set(ids)].sort())
    },
  }
}

export interface MountProfileChangeDeps {
  /** The product's skill catalog — the only mountable ids. */
  skills: readonly SelfMountSkillEntry[]
  /** Where mounted ids persist, keyed by the product's scope. */
  storage: SelfMountStorage
  /** The persistence scope for a call (project id, thread id, …). */
  scopeKey: (ctx: AppToolContext) => string
  /** Always-mounted skill id that cannot be removed. Default: none. */
  baseline?: string
  /** Upper bound on total mounted skills. Default 12; context is a budget. */
  maxMounted?: number
  /** Tool name override when a product needs a distinct verb. */
  name?: string
}

interface SkillsDelta {
  add?: string[]
  remove?: string[]
}

export interface MountProfileChangeResult {
  ok: true
  mounted: string[]
  removed: string[]
  effective: string[]
  note: string
}

function catalogLine(skills: readonly SelfMountSkillEntry[]): string {
  return skills.map((s) => `${s.id} (${s.description})`).join('; ')
}

/**
 * The permitted, idempotent self-mount verb as an app tool. Register it with
 * the product's tool set; the sandboxed agent calls it through the per-turn
 * MCP surface like any other app tool.
 */
export function createMountProfileChangeTool(deps: MountProfileChangeDeps): AppToolDefinition<Record<string, unknown>> {
  const { skills, storage, scopeKey } = deps
  const baseline = deps.baseline?.trim() || undefined
  const maxMounted = deps.maxMounted ?? 12
  const known = new Set(skills.map((s) => s.id))
  if (known.size !== skills.length) throw new Error('createMountProfileChangeTool: duplicate skill ids in the catalog')
  if (baseline && !known.has(baseline)) throw new Error(`createMountProfileChangeTool: baseline "${baseline}" is not in the catalog`)

  return defineAppTool({
    name: deps.name ?? 'mount_profile_change',
    description:
      `Apply a permitted, idempotent change to the mounted skills on this profile. ` +
      `Permitted dimension: skills ({ add: [ids], remove: [ids] }) — anything else is refused. ` +
      `Re-applying the same change is a no-op. Takes effect the next time the profile renders. ` +
      `Catalog: ${catalogLine(skills)}.`,
    parameters: {
      type: 'object',
      properties: {
        changes: {
          type: 'object',
          description: `The profile delta. Permitted dimensions: ${PERMITTED_SELF_MOUNT_DIMENSIONS.join(', ')}.`,
          properties: {
            skills: {
              type: 'object',
              description: 'Skill mounts: catalog ids to add or remove.',
              properties: {
                add: { type: 'array', items: { type: 'string' }, description: 'Catalog skill ids to mount.' },
                remove: { type: 'array', items: { type: 'string' }, description: 'Mounted skill ids to unmount.' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
      required: ['changes'],
      additionalProperties: false,
    },
    async execute(args: unknown, ctx: AppToolContext): Promise<MountProfileChangeResult | { ok: false; error: string }> {
      const changes = (args as { changes?: Record<string, unknown> }).changes ?? {}
      const unknownDimensions = Object.keys(changes).filter(
        (d) => !(PERMITTED_SELF_MOUNT_DIMENSIONS as readonly string[]).includes(d),
      )
      if (unknownDimensions.length > 0) {
        throw new ToolInputError(
          'mount_profile_change',
          `dimensions [${unknownDimensions.join(', ')}] are not agent-changeable. Permitted dimensions: ${PERMITTED_SELF_MOUNT_DIMENSIONS.join(', ')}.`,
        )
      }
      const delta = (changes.skills ?? {}) as SkillsDelta
      const add = [...new Set((delta.add ?? []).map((s) => s.trim()).filter(Boolean))]
      const remove = [...new Set((delta.remove ?? []).map((s) => s.trim()).filter(Boolean))]
      if (add.length === 0 && remove.length === 0) {
        throw new ToolInputError('mount_profile_change', 'empty delta: provide skills.add and/or skills.remove')
      }
      const invalid = [...add, ...remove].filter((id) => !known.has(id))
      if (invalid.length > 0) {
        throw new ToolInputError(
          'mount_profile_change',
          `unknown skill ids: ${invalid.join(', ')}. Catalog: ${[...known].sort().join(', ')}.`)
      }
      if (baseline && remove.includes(baseline)) {
        throw new ToolInputError(
          'mount_profile_change',
          `refused: "${baseline}" is the always-on baseline and cannot be removed`)
      }

      const scope = scopeKey(ctx)
      const stored = await storage.get(scope)
      const before = [...new Set([...stored, ...(baseline ? [baseline] : [])])].sort()
      const mounted = new Set(before)
      for (const id of add) mounted.add(id)
      for (const id of remove) mounted.delete(id)
      if (baseline) mounted.add(baseline)
      const effective = [...mounted].sort()
      if (effective.length > maxMounted) {
        throw new ToolInputError(
          'mount_profile_change',
          `refused: ${effective.length} skills exceeds the ${maxMounted}-skill mount limit`)
      }
      if (JSON.stringify(before) === JSON.stringify(effective)) {
        return { ok: true, mounted: [], removed: [], effective, note: 'no change (already in that state) — idempotent no-op' }
      }
      await storage.set(scope, effective)
      return {
        ok: true,
        mounted: effective.filter((id) => !before.includes(id)),
        removed: before.filter((id) => !effective.includes(id)),
        effective,
        note: 'applied — takes effect the next time the profile renders',
      }
    },
  })
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Any drizzle database instance (structural — the adapters only use
 *  select/insert with the standard builder chain). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleLike = any

// ── Shared storage adapters ────────────────────────────────────────────────
//
// Every product's self-mount storage is the same shape: a scope key and a
// JSON list of mounted skill ids. These adapters mean each product wires
// the verb in 3 lines instead of hand-writing a drizzle query.

import type { drizzle as drizzleD1 } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Create (or use) the standard self-mount table in a drizzle/D1 database. */
export function selfMountTable(tableName: string) {
  return sqliteTable(tableName, {
    scope: text('scope').primaryKey(),
    mounted: text('mounted').notNull(),
  })
}

/** A drizzle-backed SelfMountStorage against any table with the standard
 *  shape (scope primary key + mounted JSON text column). Works with the
 *  tables every product creates via {@link selfMountTable}. */
export function createDrizzleSelfMountStorage(
  db: DrizzleLike,
  table: ReturnType<typeof selfMountTable>,
  baseline: string,
): SelfMountStorage {
  return {
    async get(scope: string): Promise<readonly string[]> {
      const rows = await db
        .select({ mounted: table.mounted })
        .from(table)
        .where(eq(table.scope, scope))
        .limit(1)
      try {
        return rows[0] ? (JSON.parse(rows[0].mounted) as string[]) : [baseline]
      } catch {
        return [baseline]
      }
    },
    async set(scope: string, ids: readonly string[]): Promise<void> {
      await db
        .insert(table)
        .values({ scope, mounted: JSON.stringify(ids) })
        .onConflictDoUpdate({
          target: table.scope,
          set: { mounted: JSON.stringify(ids) },
        })
    },
  }
}

/** A KV-backed SelfMountStorage (Cloudflare KV, any namespace). */
export function createKVSelfMountStorage(
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> },
  prefix: string,
  baseline: string,
): SelfMountStorage {
  const key = (scope: string) => `${prefix}:${scope}`
  return {
    async get(scope: string): Promise<readonly string[]> {
      const raw = await kv.get(key(scope))
      try { return raw ? (JSON.parse(raw) as string[]) : [baseline] } catch { return [baseline] }
    },
    async set(scope: string, ids: readonly string[]): Promise<void> {
      await kv.put(key(scope), JSON.stringify(ids))
    },
  }
}

/** The one-call product wiring: catalog + storage + baseline + cap. */
export interface ProductSelfMountConfig {
  /** The product's skill catalog (id + description per skill). */
  skills: ReadonlyArray<{ id: string; description: string }>
  /** A drizzle/D1 database (uses a self-mount table) or a KV namespace. */
  db?: DrizzleLike
  kv?: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> }
  /** The table name for drizzle storage (default: 'agent_self_mounts'). */
  tableName?: string
  /** KV prefix (default: 'self-mount'). */
  kvPrefix?: string
  /** The skill id that can never be removed. */
  baseline: string
  /** Max simultaneous mounts (default: 12). */
  maxMounted?: number
}

export function createProductSelfMount(config: ProductSelfMountConfig) {
  const storage = config.db
    ? createDrizzleSelfMountStorage(config.db, selfMountTable(config.tableName ?? 'agent_self_mounts'), config.baseline)
    : config.kv
      ? createKVSelfMountStorage(config.kv, config.kvPrefix ?? 'self-mount', config.baseline)
      : undefined
  if (!storage) throw new Error('createProductSelfMount needs db or kv')
  return createMountProfileChangeTool({
    skills: config.skills,
    storage,
    scopeKey: (ctx) => ctx.workspaceId ?? ctx.threadId ?? '',
    baseline: config.baseline,
    maxMounted: config.maxMounted ?? 12,
  })
}
