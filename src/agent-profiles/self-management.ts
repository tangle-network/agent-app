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
