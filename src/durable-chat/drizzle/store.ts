/**
 * The production durable-chat store: a SQLite/drizzle implementation of the
 * plan and interaction ports, with compare-and-set claims and lease-matched
 * settlement so two workers cannot drive the same decision or the same answer.
 *
 * Three factories matching the three ports — `createDrizzlePlanStore`,
 * `createDrizzleInteractionStore`, `createDrizzleDurableChatStore` — so a
 * plan-only adopter creates no answer-intent journal.
 *
 * ## Driver portability
 *
 * Typed against `BaseSQLiteDatabase<'sync' | 'async', …>`, so one implementation
 * serves D1, better-sqlite3 and libsql. Query builders are always `await`ed and
 * never `.run()`/`.all()`, which is what makes sync and async drivers behave
 * identically. Cloudflare's `D1Database` is reached structurally through drizzle;
 * this module imports no Cloudflare types.
 *
 * ## How a claim is decided without an affected-rows count
 *
 * drizzle exposes no portable "rows changed" (`RunResult` on better-sqlite3,
 * `D1Result` on D1), so the claim cannot branch on it. Instead every claim
 * writes a random `lease_token` and then re-reads the row: the insert path sets
 * the token, a stale-claim takeover sets it from `excluded`, and a refused guard
 * leaves the incumbent's token in place. So `row.leaseToken === ourToken` means
 * — exactly, on every driver — that we own the claim. The re-read is mandatory,
 * not defensive: it is both the classification oracle and the record returned
 * for `existing`/`conflict`.
 *
 * Settlement passes that token back. `WHERE lease_token = ?` means a worker that
 * stalled past its lease and then woke up cannot settle behind whoever took
 * over. Omitting the lease settles unconditionally, which is what every
 * pre-lease caller does and why wiring this store changes no existing behavior.
 *
 * ## Atomicity
 *
 * `finalizeAnswerIntent` moves the ask projection and the intent together and is
 * the one place needing multi-row atomicity. It uses `db.batch` (one implicit
 * transaction on D1 and libsql). It deliberately does NOT use `db.transaction`:
 * drizzle's D1 session issues literal `begin`/`commit` statements, which D1
 * rejects at runtime. On a driver with neither, statement ORDER carries the
 * integrity contract — see the comment on that method.
 *
 * Imports `drizzle-orm`, so this is subpath-only and never enters the root barrel.
 */

import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'

import { DurableChatConflictError } from '../errors'
import {
  durableChatScopeKey,
  type DurableAnswerIntentClaim,
  type DurableAnswerIntentRecord,
  type DurableChatScope,
  type DurableChatStore,
  type DurableFollowUpReceipt,
  type DurableInteractionAcknowledgement,
  type DurableInteractionGuarantee,
  type DurableInteractionProjection,
  type DurableInteractionStore,
  type DurablePlanAuthorityResult,
  type DurablePlanCommandClaim,
  type DurablePlanCommandKey,
  type DurablePlanCommandRecord,
  type DurablePlanEffectClaim,
  type DurablePlanEffectRecord,
  type DurablePlanProjection,
  type DurablePlanStore,
} from '../types'
import { canTransitionPlanStatus } from '../../plans/index'
import type {
  DurableChatTables,
  DurableInteractionTables,
  DurablePlanTables,
} from './schema'

/** Any SQLite drizzle database — `any` erases driver-specific generics so
 *  better-sqlite3, D1 and libsql handles all fit. */
export type DurableChatDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any>

/** Shared construction options. */
export interface DurableChatStoreOptions {
  db: DurableChatDatabase
  /**
   * How long a claim may go unsettled before another worker may take it over.
   * Defaults to one hour. Set it above the longest a claimant could legitimately
   * stall: too low and a slow-but-alive worker gets its claim stolen.
   */
  staleAfterMs?: number
  /** Epoch-millisecond clock. Injectable so lease-expiry tests are deterministic. */
  now?: () => number
  /** Lease-token source. Injectable for the same reason. */
  newLease?: () => string
}

/** Options for the plan-only store. */
export interface CreateDrizzlePlanStoreOptions extends DurableChatStoreOptions {
  tables: DurablePlanTables
}

/** Options for the interaction-only store. */
export interface CreateDrizzleInteractionStoreOptions extends DurableChatStoreOptions {
  tables: DurableInteractionTables
}

/** Options for the composed store. */
export interface CreateDrizzleDurableChatStoreOptions extends DurableChatStoreOptions {
  tables: DurableChatTables
}

const HOUR_MS = 60 * 60 * 1000
/** Bounds the optimistic-concurrency retry on projection writes. */
const MAX_PROJECTION_ATTEMPTS = 3

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortDeep((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/**
 * Recursively key-sorted JSON. Payload equality must not depend on the key order
 * a client happened to send, and the reference store's `JSON.stringify` compare
 * is order-sensitive — this is strictly more permissive and never accepts a
 * semantically different payload as identical.
 */
function canonicalJson(value: unknown): string {
  return value === undefined ? 'null' : JSON.stringify(sortDeep(value))
}

/** One driver round trip when `db.batch` exists; sequential awaits otherwise.
 *  Statement order is the caller's integrity contract. */
async function runStatements(db: DurableChatDatabase, statements: [unknown, ...unknown[]]): Promise<void> {
  const batch = (db as { batch?: (s: [unknown, ...unknown[]]) => Promise<unknown[]> }).batch
  if (typeof batch === 'function') {
    await batch.call(db, statements)
    return
  }
  for (const statement of statements) await statement
}

function defaultLease(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID()
  return `lease-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

interface Clock {
  now: () => number
  newLease: () => string
  staleAfterMs: number
}

function clockFrom(options: DurableChatStoreOptions): Clock {
  return {
    now: options.now ?? (() => Date.now()),
    newLease: options.newLease ?? defaultLease,
    staleAfterMs: options.staleAfterMs ?? HOUR_MS,
  }
}

// ─── plan store ──────────────────────────────────────────────────────────────

/** Build the plan-side store: projections, the command journal, the effect journal. */
export function createDrizzlePlanStore(options: CreateDrizzlePlanStoreOptions): DurablePlanStore {
  const { db, tables } = options
  const clock = clockFrom(options)
  const projections = tables.planProjection
  const commands = tables.planCommand
  const effects = tables.planEffect

  async function readProjectionRow(scopeKey: string, planId: string, revision: number) {
    const [row] = await db.select().from(projections as any)
      .where(and(eq(projections.scope, scopeKey), eq(projections.planId, planId), eq(projections.revision, revision)))
      .limit(1)
    return (row ?? null) as { projection: DurablePlanProjection; status: string } | null
  }

  async function readCommandRow(scopeKey: string, commandKey: string) {
    const [row] = await db.select().from(commands as any)
      .where(and(eq(commands.scope, scopeKey), eq(commands.commandKey, commandKey)))
      .limit(1)
    return (row ?? null) as CommandRow | null
  }

  async function readCommandRowByRevision(scopeKey: string, planId: string, revision: number) {
    const [row] = await db.select().from(commands as any)
      .where(and(eq(commands.scope, scopeKey), eq(commands.planId, planId), eq(commands.revision, revision)))
      .limit(1)
    return (row ?? null) as CommandRow | null
  }

  async function readEffectRow(scopeKey: string, effectKey: string) {
    const [row] = await db.select().from(effects as any)
      .where(and(eq(effects.scope, scopeKey), eq(effects.effectKey, effectKey)))
      .limit(1)
    return (row ?? null) as EffectRow | null
  }

  return {
    async getPlanProjection(scope, planId, revision) {
      const scopeKey = durableChatScopeKey(scope)
      if (revision !== undefined) {
        const row = await readProjectionRow(scopeKey, planId, revision)
        return row?.projection ?? null
      }
      // No revision means the CURRENT one — the highest revision on record,
      // which is what the reference store's pointer table always resolves to
      // because it only ever advances.
      const [row] = await db.select().from(projections as any)
        .where(and(eq(projections.scope, scopeKey), eq(projections.planId, planId)))
        .orderBy(desc(projections.revision))
        .limit(1)
      return (row as { projection: DurablePlanProjection } | undefined)?.projection ?? null
    },

    async listPlanProjections(scope, planId) {
      const scopeKey = durableChatScopeKey(scope)
      const where = planId
        ? and(eq(projections.scope, scopeKey), eq(projections.planId, planId))
        : eq(projections.scope, scopeKey)
      const rows = await db.select().from(projections as any).where(where).orderBy(asc(projections.revision))
      return (rows as Array<{ projection: DurablePlanProjection }>).map((row) => row.projection)
    },

    async putPlanProjection(scope, projection) {
      if (!projection.planId || !Number.isInteger(projection.revision) || projection.revision < 1) {
        throw new TypeError('plan projection requires planId and positive integer revision')
      }
      const scopeKey = durableChatScopeKey(scope)
      const incoming = canonicalJson(projection)

      // Optimistic concurrency: classify against the row we read, then write with
      // that read pinned in the WHERE. A racing writer makes the guarded write a
      // no-op, which the re-read detects and we re-classify against the winner.
      for (let attempt = 0; attempt < MAX_PROJECTION_ATTEMPTS; attempt++) {
        const prior = await readProjectionRow(scopeKey, projection.planId, projection.revision)

        if (!prior) {
          await db.insert(projections as any).values({
            scope: scopeKey,
            planId: projection.planId,
            revision: projection.revision,
            status: projection.status,
            title: projection.title ?? null,
            body: projection.body,
            submittedAt: projection.submittedAt,
            projection,
            updatedAt: clock.now(),
          }).onConflictDoNothing({
            target: [projections.scope, projections.planId, projections.revision],
          })
          const after = await readProjectionRow(scopeKey, projection.planId, projection.revision)
          if (after && canonicalJson(after.projection) === incoming) return
          continue
        }

        // An identical re-write is a no-op, exactly as the reference store's
        // whole-record equality short-circuit makes it.
        if (canonicalJson(prior.projection) === incoming) return

        const priorProjection = prior.projection
        if (
          priorProjection.body !== projection.body ||
          priorProjection.title !== projection.title ||
          priorProjection.submittedAt !== projection.submittedAt
        ) {
          throw new DurableChatConflictError('plan content changed without a new revision')
        }
        if (priorProjection.status === projection.status && !['preparing', 'pending'].includes(priorProjection.status)) {
          throw new DurableChatConflictError('terminal plan projection cannot be rewritten')
        }
        if (!canTransitionPlanStatus(priorProjection.status, projection.status)) {
          throw new DurableChatConflictError('conflicting plan projection for the same revision')
        }

        await db.update(projections as any).set({
          status: projection.status,
          title: projection.title ?? null,
          body: projection.body,
          submittedAt: projection.submittedAt,
          projection,
          updatedAt: clock.now(),
        }).where(and(
          eq(projections.scope, scopeKey),
          eq(projections.planId, projection.planId),
          eq(projections.revision, projection.revision),
          // Pin the state we classified against.
          eq(projections.status, priorProjection.status),
        ))

        const after = await readProjectionRow(scopeKey, projection.planId, projection.revision)
        if (after && canonicalJson(after.projection) === incoming) return
      }
      throw new DurableChatConflictError('conflicting plan projection for the same revision')
    },

    async getPlanCommand(scope, commandKey) {
      const row = await readCommandRow(durableChatScopeKey(scope), commandKey)
      return row ? toCommandRecord(row, scope) : null
    },

    async claimPlanCommand(scope, command): Promise<DurablePlanCommandClaim> {
      const scopeKey = durableChatScopeKey(scope)
      const lease = clock.newLease()
      const now = clock.now()
      const staleBefore = now - clock.staleAfterMs

      // Same precedence as the reference store: the key is checked first, so a
      // reused key reports as a key conflict rather than a revision conflict.
      const existingByKey = await readCommandRow(scopeKey, command.commandKey)
      if (existingByKey) {
        if (
          existingByKey.planId !== command.planId ||
          existingByKey.revision !== command.revision ||
          existingByKey.decision !== command.decision
        ) {
          return {
            status: 'conflict',
            record: toCommandRecord(existingByKey, scope),
            reason: 'command key is already used by another decision',
          }
        }
        // Only report `existing` for a claim that is still LIVE. A stale one has
        // to fall through to the compare-and-set below, or a crashed claimant
        // would wedge this decision forever — returning early here was exactly
        // that bug. The condition mirrors the statement's `setWhere` so the
        // database, not this read, remains the arbiter of who wins.
        const takeable = existingByKey.state === 'conflicted' ||
          (existingByKey.state === 'claimed' && existingByKey.leaseAt < staleBefore)
        if (!takeable) return { status: 'existing', record: toCommandRecord(existingByKey, scope) }
      }

      const competing = await readCommandRowByRevision(scopeKey, command.planId, command.revision)
      if (competing && competing.decision !== command.decision) {
        return {
          status: 'conflict',
          record: toCommandRecord(competing, scope),
          reason: 'competing decision for plan revision',
        }
      }

      await db.insert(commands as any).values({
        scope: scopeKey,
        planId: command.planId,
        revision: command.revision,
        decision: command.decision,
        commandKey: command.commandKey,
        authorityIdempotencyKey: command.authorityIdempotencyKey,
        state: 'claimed',
        claimedAt: command.claimedAt,
        leaseToken: lease,
        leaseAt: now,
        attempt: 1,
      }).onConflictDoUpdate({
        target: [commands.scope, commands.planId, commands.revision],
        set: {
          state: 'claimed',
          claimedAt: sql`excluded.claimed_at`,
          authorityIdempotencyKey: sql`excluded.authority_idempotency_key`,
          leaseToken: sql`excluded.lease_token`,
          leaseAt: sql`excluded.lease_at`,
          attempt: sql`${commands.attempt} + 1`,
        },
        // Never take over a row that decided the other way, and only take over a
        // claim whose holder has gone stale (or already errored out).
        setWhere: and(
          sql`${commands.decision} = excluded.decision`,
          sql`${commands.commandKey} = excluded.command_key`,
          or(eq(commands.state, 'conflicted'), and(eq(commands.state, 'claimed'), lt(commands.leaseAt, staleBefore))),
        ),
      })

      const row = await readCommandRowByRevision(scopeKey, command.planId, command.revision)
      if (!row) throw new DurableChatConflictError('plan command vanished during claim')
      if (row.leaseToken === lease) {
        return { status: 'claimed', record: toCommandRecord(row, scope), lease, takenOver: row.attempt > 1 }
      }
      if (row.decision !== command.decision) {
        return { status: 'conflict', record: toCommandRecord(row, scope), reason: 'competing decision for plan revision' }
      }
      if (row.commandKey !== command.commandKey) {
        return { status: 'conflict', record: toCommandRecord(row, scope), reason: 'command key is already used by another decision' }
      }
      return { status: 'existing', record: toCommandRecord(row, scope) }
    },

    async recordPlanAuthorityResult(scope, commandKey, result, receipt, lease) {
      await settleCommand(scope, commandKey, lease, {
        state: 'authority_committed',
        authorityResult: result,
        receipt,
      }, 'cannot record authority result before claiming command', ['authority_committed', 'finalized'])
    },

    async finalizePlanCommand(scope, commandKey, lease) {
      await settleCommand(scope, commandKey, lease, { state: 'finalized' },
        'cannot finalize unknown plan command', ['finalized'])
    },

    async getPlanEffect(scope, effectKey) {
      const row = await readEffectRow(durableChatScopeKey(scope), effectKey)
      return row ? toEffectRecord(row, scope) : null
    },

    async claimPlanEffect(scope, effect): Promise<DurablePlanEffectClaim> {
      const scopeKey = durableChatScopeKey(scope)
      const lease = clock.newLease()
      const now = clock.now()
      const staleBefore = now - clock.staleAfterMs

      await db.insert(effects as any).values({
        scope: scopeKey,
        effectKey: effect.effectKey,
        planId: effect.planId,
        revision: effect.revision,
        decision: effect.decision,
        state: 'claimed',
        claimedAt: effect.claimedAt,
        leaseToken: lease,
        leaseAt: now,
        attempt: 1,
      }).onConflictDoUpdate({
        target: [effects.scope, effects.effectKey],
        set: {
          state: 'claimed',
          claimedAt: sql`excluded.claimed_at`,
          error: null,
          completedAt: null,
          leaseToken: sql`excluded.lease_token`,
          leaseAt: sql`excluded.lease_at`,
          attempt: sql`${effects.attempt} + 1`,
        },
        // A failed effect is retryable, and a claim whose holder went stale is
        // recoverable. A completed one is never re-claimed.
        setWhere: or(
          eq(effects.state, 'error'),
          and(eq(effects.state, 'claimed'), lt(effects.leaseAt, staleBefore)),
        ),
      })

      const row = await readEffectRow(scopeKey, effect.effectKey)
      if (!row) throw new DurableChatConflictError('plan effect vanished during claim')
      if (row.leaseToken === lease) {
        return { status: 'claimed', record: toEffectRecord(row, scope), lease, takenOver: row.attempt > 1 }
      }
      return { status: 'existing', record: toEffectRecord(row, scope) }
    },

    async completePlanEffect(scope, effectKey, lease) {
      await settleEffect(scope, effectKey, lease,
        { state: 'completed', completedAt: new Date(clock.now()).toISOString(), error: null },
        'cannot complete unknown plan effect', ['completed'])
    },

    async failPlanEffect(scope, effectKey, error, lease) {
      await settleEffect(scope, effectKey, lease, { state: 'error', error },
        'cannot fail unknown plan effect', ['error'])
    },
  }

  async function settleCommand(
    scope: DurableChatScope,
    commandKey: DurablePlanCommandKey,
    lease: string | undefined,
    patch: Record<string, unknown>,
    missingMessage: string,
    tolerableStates: string[],
  ): Promise<void> {
    const scopeKey = durableChatScopeKey(scope)
    await db.update(commands as any).set({ ...patch, leaseAt: clock.now() }).where(and(
      eq(commands.scope, scopeKey),
      eq(commands.commandKey, commandKey),
      ...(lease ? [eq(commands.leaseToken, lease)] : []),
    ))
    const row = await readCommandRow(scopeKey, commandKey)
    if (!row) throw new DurableChatConflictError(missingMessage)
    if (lease && row.leaseToken !== lease) {
      // Another worker took the lease over. Tolerate it only when they already
      // reached the state we were trying to reach — otherwise we lost, and
      // overwriting their work is exactly what the lease exists to prevent.
      if (tolerableStates.includes(row.state)) return
      throw new DurableChatConflictError('plan command lease was taken over')
    }
  }

  async function settleEffect(
    scope: DurableChatScope,
    effectKey: string,
    lease: string | undefined,
    patch: Record<string, unknown>,
    missingMessage: string,
    tolerableStates: string[],
  ): Promise<void> {
    const scopeKey = durableChatScopeKey(scope)
    await db.update(effects as any).set(patch).where(and(
      eq(effects.scope, scopeKey),
      eq(effects.effectKey, effectKey),
      ...(lease ? [eq(effects.leaseToken, lease)] : []),
    ))
    const row = await readEffectRow(scopeKey, effectKey)
    if (!row) throw new DurableChatConflictError(missingMessage)
    if (lease && row.leaseToken !== lease) {
      if (tolerableStates.includes(row.state)) return
      throw new DurableChatConflictError('plan effect lease was taken over')
    }
  }
}

// ─── interaction store ───────────────────────────────────────────────────────

/** Build the interaction-side store: ask projections and the answer-intent journal. */
export function createDrizzleInteractionStore(
  options: CreateDrizzleInteractionStoreOptions,
): DurableInteractionStore {
  const { db, tables } = options
  const clock = clockFrom(options)
  const asks = tables.interactionProjection
  const aliases = tables.interactionAlias
  const semantics = tables.interactionSemantic
  const intents = tables.answerIntent

  async function readAskRow(scopeKey: string, interactionId: string) {
    const [row] = await db.select().from(asks as any)
      .where(and(eq(asks.scope, scopeKey), eq(asks.interactionId, interactionId)))
      .limit(1)
    return (row ?? null) as AskRow | null
  }

  async function readAlias(scopeKey: string, aliasId: string): Promise<string | null> {
    const [row] = await db.select().from(aliases as any)
      .where(and(eq(aliases.scope, scopeKey), eq(aliases.aliasId, aliasId)))
      .limit(1)
    return (row as { interactionId: string } | undefined)?.interactionId ?? null
  }

  /** Resolve a possibly-aliased id to the canonical row. */
  async function resolveAsk(scopeKey: string, interactionId: string) {
    const direct = await readAskRow(scopeKey, interactionId)
    if (direct) return { row: direct, viaAlias: false as const }
    const canonicalId = await readAlias(scopeKey, interactionId)
    if (!canonicalId) return { row: null, viaAlias: false as const }
    return { row: await readAskRow(scopeKey, canonicalId), viaAlias: true as const }
  }

  async function readIntentRow(scopeKey: string, intentKey: string) {
    const [row] = await db.select().from(intents as any)
      .where(and(eq(intents.scope, scopeKey), eq(intents.intentKey, intentKey)))
      .limit(1)
    return (row ?? null) as IntentRow | null
  }

  async function writeAsk(scopeKey: string, projection: DurableInteractionProjection, priorStatus?: string) {
    const values = {
      scope: scopeKey,
      interactionId: projection.id,
      status: projection.status,
      eventId: projection.eventId ?? null,
      semanticKey: projection.semanticKey ?? null,
      tombstone: projection.tombstone ?? false,
      projection,
      updatedAt: clock.now(),
    }
    if (priorStatus === undefined) {
      await db.insert(asks as any).values(values)
        .onConflictDoNothing({ target: [asks.scope, asks.interactionId] })
      return
    }
    await db.update(asks as any).set(values).where(and(
      eq(asks.scope, scopeKey),
      eq(asks.interactionId, projection.id),
      // Pin the state we classified against, so a racing writer is detected.
      eq(asks.status, priorStatus),
    ))
  }

  const store: DurableInteractionStore = {
    async getInteractionProjection(scope, interactionId) {
      const { row } = await resolveAsk(durableChatScopeKey(scope), interactionId)
      return row?.projection ?? null
    },

    async listInteractionProjections(scope) {
      const rows = await db.select().from(asks as any).where(eq(asks.scope, durableChatScopeKey(scope)))
      return (rows as AskRow[]).map((row) => row.projection)
    },

    async upsertInteractionProjection(scope, projection) {
      if (!projection.id) throw new TypeError('interaction projection requires id')
      const scopeKey = durableChatScopeKey(scope)

      for (let attempt = 0; attempt < MAX_PROJECTION_ATTEMPTS; attempt++) {
        const { row: prior, viaAlias } = await resolveAsk(scopeKey, projection.id)

        // A duplicate id that already resolves through an alias keeps pointing
        // at the canonical row.
        if (prior && viaAlias) {
          await db.insert(aliases as any)
            .values({ scope: scopeKey, aliasId: projection.id, interactionId: prior.interactionId })
            .onConflictDoNothing({ target: [aliases.scope, aliases.aliasId] })
        }

        if (prior) {
          const priorProjection = prior.projection

          // A repeated event id is a replay of a message we already applied.
          if (projection.eventId && priorProjection.eventId === projection.eventId) return priorProjection

          if (priorProjection.status !== 'pending') {
            // A cancel that arrived before its ask left a content-less
            // tombstone; the real ask may still fill in its content, but the
            // terminal state holds.
            if (priorProjection.tombstone && priorProjection.kind === 'unknown' && projection.status === priorProjection.status) {
              const enriched: DurableInteractionProjection = {
                ...projection,
                id: priorProjection.id,
                status: priorProjection.status,
                tombstone: true,
                ...(priorProjection.cancelReason ? { cancelReason: priorProjection.cancelReason } : {}),
              }
              await writeAsk(scopeKey, enriched, priorProjection.status)
              const after = await readAskRow(scopeKey, priorProjection.id)
              if (after && canonicalJson(after.projection) === canonicalJson(enriched)) return enriched
              continue
            }
            if (
              priorProjection.status === projection.status &&
              canonicalJson(priorProjection.answers) === canonicalJson(projection.answers)
            ) return priorProjection
            throw new DurableChatConflictError('interaction already has a conflicting terminal outcome')
          }

          // A terminal event wins over pending. A second terminal event was
          // caught above; this is the accepted-answer/cancel ordering rule.
          if (projection.status !== 'pending') {
            const canonical = priorProjection.id === projection.id
              ? projection
              : { ...projection, id: priorProjection.id }
            const statements: [unknown, ...unknown[]] = [
              db.update(asks as any).set({
                status: canonical.status,
                eventId: canonical.eventId ?? null,
                semanticKey: canonical.semanticKey ?? null,
                tombstone: canonical.tombstone ?? false,
                projection: canonical,
                updatedAt: clock.now(),
              }).where(and(
                eq(asks.scope, scopeKey),
                eq(asks.interactionId, canonical.id),
                eq(asks.status, 'pending'),
              )),
            ]
            // Settling frees the content signature so a later turn may ask the
            // same question again.
            if (priorProjection.semanticKey) {
              statements.push(db.delete(semantics as any).where(and(
                eq(semantics.scope, scopeKey),
                eq(semantics.semanticKey, priorProjection.semanticKey),
              )))
            }
            await runStatements(db, statements)
            const after = await readAskRow(scopeKey, canonical.id)
            if (after && after.projection.status !== 'pending') return after.projection
            continue
          }
          return priorProjection
        }

        // No prior row. Reserve the content signature first: whoever wins the
        // reservation owns the canonical id, and everyone else becomes an alias.
        if (projection.semanticKey) {
          await db.insert(semantics as any)
            .values({ scope: scopeKey, semanticKey: projection.semanticKey, interactionId: projection.id })
            .onConflictDoNothing({ target: [semantics.scope, semantics.semanticKey] })
          const [reservation] = await db.select().from(semantics as any).where(and(
            eq(semantics.scope, scopeKey),
            eq(semantics.semanticKey, projection.semanticKey),
          )).limit(1)
          const holder = (reservation as { interactionId: string } | undefined)?.interactionId
          if (holder && holder !== projection.id) {
            await db.insert(aliases as any)
              .values({ scope: scopeKey, aliasId: projection.id, interactionId: holder })
              .onConflictDoNothing({ target: [aliases.scope, aliases.aliasId] })
            const canonicalRow = await readAskRow(scopeKey, holder)
            return canonicalRow?.projection ?? projection
          }
        }

        await writeAsk(scopeKey, projection)
        const after = await readAskRow(scopeKey, projection.id)
        if (after && canonicalJson(after.projection) === canonicalJson(projection)) return projection
        // Someone raced us to this id; re-classify against whatever they wrote.
      }
      throw new DurableChatConflictError('interaction projection could not be settled')
    },

    async getAnswerIntent(scope, intentKey) {
      const row = await readIntentRow(durableChatScopeKey(scope), intentKey)
      return row ? toIntentRecord(row, scope) : null
    },

    async claimAnswerIntent(scope, intent): Promise<DurableAnswerIntentClaim> {
      const scopeKey = durableChatScopeKey(scope)
      const lease = clock.newLease()
      const now = clock.now()
      const staleBefore = now - clock.staleAfterMs
      const data = intent.data === undefined ? null : canonicalJson(intent.data)

      await db.insert(intents as any).values({
        scope: scopeKey,
        intentKey: intent.intentKey,
        interactionId: intent.interactionId,
        attemptKey: intent.attemptKey,
        outcome: intent.outcome,
        data,
        state: 'prepared',
        guarantee: intent.guarantee ?? null,
        createdAt: intent.createdAt,
        leaseToken: lease,
        leaseAt: now,
        attempt: 1,
      }).onConflictDoUpdate({
        target: [intents.scope, intents.intentKey],
        set: {
          state: 'prepared',
          error: null,
          createdAt: sql`excluded.created_at`,
          leaseToken: sql`excluded.lease_token`,
          leaseAt: sql`excluded.lease_at`,
          attempt: sql`${intents.attempt} + 1`,
        },
        // Only take over an identical answer: a different payload under the same
        // key is a conflict, never a takeover.
        setWhere: and(
          sql`${intents.interactionId} = excluded.interaction_id`,
          sql`${intents.attemptKey} = excluded.attempt_key`,
          sql`${intents.outcome} = excluded.outcome`,
          sql`${intents.data} IS excluded.data`,
          or(eq(intents.state, 'aborted'), and(eq(intents.state, 'prepared'), lt(intents.leaseAt, staleBefore))),
        ),
      })

      const row = await readIntentRow(scopeKey, intent.intentKey)
      if (!row) throw new DurableChatConflictError('answer intent vanished during claim')
      if (row.leaseToken === lease) {
        return { status: 'claimed', record: toIntentRecord(row, scope), lease, takenOver: row.attempt > 1 }
      }
      if (
        row.interactionId === intent.interactionId &&
        row.attemptKey === intent.attemptKey &&
        row.outcome === intent.outcome &&
        (row.data ?? null) === data
      ) {
        return { status: 'existing', record: toIntentRecord(row, scope) }
      }
      return {
        status: 'conflict',
        record: toIntentRecord(row, scope),
        reason: 'answer intent key is already used by another answer',
      }
    },

    async acknowledgeAnswerIntent(scope, intentKey, acknowledgement, lease) {
      const scopeKey = durableChatScopeKey(scope)
      const existing = await readIntentRow(scopeKey, intentKey)
      if (!existing) throw new DurableChatConflictError('cannot acknowledge unknown answer intent')
      if (existing.state === 'finalized') return

      await db.update(intents as any)
        .set({ state: 'acknowledged', acknowledgement, leaseAt: clock.now() })
        .where(and(
          eq(intents.scope, scopeKey),
          eq(intents.intentKey, intentKey),
          // Never regress a finalized intent.
          inArray(intents.state, ['prepared', 'acknowledged', 'aborted']),
          ...(lease ? [eq(intents.leaseToken, lease)] : []),
        ))

      if (lease) {
        const row = await readIntentRow(scopeKey, intentKey)
        if (row && row.leaseToken !== lease && row.state !== 'acknowledged' && row.state !== 'finalized') {
          throw new DurableChatConflictError('answer intent lease was taken over')
        }
      }
    },

    /**
     * Settle the ask projection and the intent together.
     *
     * Statement ORDER is the integrity contract: the projection moves first, so
     * a crash between the two writes leaves a settled ask beside an
     * `acknowledged` intent — which the retry resolves through the
     * already-terminal branch below and completes. The reverse order would
     * report an intent as `finalized` while the ask it answers still reads as
     * pending, which is a lie no retry can detect.
     *
     * On D1 and libsql `runStatements` puts both writes in one implicit
     * transaction and the ordering never comes into play.
     */
    async finalizeAnswerIntent(scope, intentKey, guarantee, lease) {
      const scopeKey = durableChatScopeKey(scope)
      const intent = await readIntentRow(scopeKey, intentKey)
      if (!intent) throw new DurableChatConflictError('cannot finalize unknown answer intent')
      if (intent.state === 'finalized') return
      if (!intent.acknowledgement?.acknowledged) {
        throw new DurableChatConflictError('cannot finalize an answer before authority acknowledgement')
      }
      const { row: askRow } = await resolveAsk(scopeKey, intent.interactionId)
      if (!askRow) throw new DurableChatConflictError('cannot finalize an answer before its ask projection')

      const status = intent.outcome === 'accepted' ? 'answered' : 'declined'
      const answers = intent.data === null || intent.data === undefined
        ? undefined
        : JSON.parse(intent.data) as DurableInteractionProjection['answers']
      const prior = askRow.projection

      if (prior.status !== 'pending') {
        // Already terminal. Same outcome means a prior attempt got there first
        // and we only need to catch the intent up; a different outcome is a
        // genuine conflict and must leave the intent retryable.
        if (prior.status !== status || canonicalJson(prior.answers) !== canonicalJson(answers)) {
          throw new DurableChatConflictError('interaction already has a conflicting terminal outcome')
        }
        await markIntentFinalized(scopeKey, intentKey, guarantee, lease)
        return
      }

      const settled: DurableInteractionProjection = {
        ...prior,
        status,
        ...(answers ? { answers } : {}),
        updatedAt: intent.acknowledgement.at ?? new Date(clock.now()).toISOString(),
      }

      const statements: [unknown, ...unknown[]] = [
        db.update(asks as any).set({
          status,
          projection: settled,
          updatedAt: clock.now(),
        }).where(and(
          eq(asks.scope, scopeKey),
          eq(asks.interactionId, prior.id),
          eq(asks.status, 'pending'),
        )),
        db.update(intents as any).set({
          state: 'finalized',
          guarantee: guarantee ?? 'best-effort',
          finalizedAt: new Date(clock.now()).toISOString(),
          leaseAt: clock.now(),
        }).where(and(
          eq(intents.scope, scopeKey),
          eq(intents.intentKey, intentKey),
          eq(intents.state, 'acknowledged'),
          ...(lease ? [eq(intents.leaseToken, lease)] : []),
        )),
      ]
      if (prior.semanticKey) {
        statements.push(db.delete(semantics as any).where(and(
          eq(semantics.scope, scopeKey),
          eq(semantics.semanticKey, prior.semanticKey),
        )))
      }
      await runStatements(db, statements)

      const after = await readIntentRow(scopeKey, intentKey)
      if (after?.state !== 'finalized') {
        const askAfter = await readAskRow(scopeKey, prior.id)
        if (askAfter && askAfter.projection.status === status) {
          await markIntentFinalized(scopeKey, intentKey, guarantee, lease)
          return
        }
        throw new DurableChatConflictError('answer intent could not be finalized')
      }
    },

    async abortAnswerIntent(scope, intentKey, error, lease) {
      const scopeKey = durableChatScopeKey(scope)
      const existing = await readIntentRow(scopeKey, intentKey)
      if (!existing) throw new DurableChatConflictError('cannot abort unknown answer intent')
      if (existing.state === 'finalized') return

      await db.update(intents as any).set({ state: 'aborted', error, leaseAt: clock.now() }).where(and(
        eq(intents.scope, scopeKey),
        eq(intents.intentKey, intentKey),
        inArray(intents.state, ['prepared', 'acknowledged']),
        ...(lease ? [eq(intents.leaseToken, lease)] : []),
      ))
    },
  }

  async function markIntentFinalized(
    scopeKey: string,
    intentKey: string,
    guarantee: DurableInteractionGuarantee | undefined,
    lease: string | undefined,
  ): Promise<void> {
    await db.update(intents as any).set({
      state: 'finalized',
      guarantee: guarantee ?? 'best-effort',
      finalizedAt: new Date(clock.now()).toISOString(),
    }).where(and(
      eq(intents.scope, scopeKey),
      eq(intents.intentKey, intentKey),
      ...(lease ? [eq(intents.leaseToken, lease)] : []),
    ))
  }

  return store
}

/** Build the composed store: both ports over all seven tables. */
export function createDrizzleDurableChatStore(
  options: CreateDrizzleDurableChatStoreOptions,
): DurableChatStore {
  return {
    ...createDrizzlePlanStore(options),
    ...createDrizzleInteractionStore(options),
  }
}

// ─── row mapping ─────────────────────────────────────────────────────────────

interface CommandRow {
  planId: string
  revision: number
  decision: 'approved' | 'rejected'
  commandKey: string
  authorityIdempotencyKey: string
  state: DurablePlanCommandRecord['state']
  claimedAt: string
  leaseToken: string
  leaseAt: number
  attempt: number
  authorityResult: DurablePlanAuthorityResult | null
  receipt: DurableFollowUpReceipt | null
  conflict: string | null
}

interface EffectRow {
  effectKey: string
  planId: string
  revision: number
  decision: 'approved' | 'rejected'
  state: DurablePlanEffectRecord['state']
  claimedAt: string
  completedAt: string | null
  error: string | null
  leaseToken: string
  attempt: number
}

interface AskRow {
  interactionId: string
  projection: DurableInteractionProjection
}

interface IntentRow {
  intentKey: string
  interactionId: string
  attemptKey: string
  outcome: 'accepted' | 'declined'
  data: string | null
  state: DurableAnswerIntentRecord['state']
  guarantee: DurableInteractionGuarantee | null
  acknowledgement: DurableInteractionAcknowledgement | null
  createdAt: string
  finalizedAt: string | null
  error: string | null
  leaseToken: string
  attempt: number
}

function toCommandRecord(row: CommandRow, scope: DurableChatScope): DurablePlanCommandRecord {
  return {
    scope,
    planId: row.planId,
    revision: row.revision,
    decision: row.decision,
    commandKey: row.commandKey,
    authorityIdempotencyKey: row.authorityIdempotencyKey,
    state: row.state,
    claimedAt: row.claimedAt,
    ...(row.authorityResult ? { authorityResult: row.authorityResult } : {}),
    ...(row.receipt ? { receipt: row.receipt } : {}),
    ...(row.conflict ? { conflict: row.conflict } : {}),
  }
}

function toEffectRecord(row: EffectRow, scope: DurableChatScope): DurablePlanEffectRecord {
  return {
    effectKey: row.effectKey,
    scope,
    planId: row.planId,
    revision: row.revision,
    decision: row.decision,
    state: row.state,
    claimedAt: row.claimedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.error ? { error: row.error } : {}),
  }
}

function toIntentRecord(row: IntentRow, scope: DurableChatScope): DurableAnswerIntentRecord {
  return {
    scope,
    interactionId: row.interactionId,
    attemptKey: row.attemptKey,
    intentKey: row.intentKey,
    outcome: row.outcome,
    ...(row.data !== null && row.data !== undefined
      ? { data: JSON.parse(row.data) as DurableAnswerIntentRecord['data'] }
      : {}),
    state: row.state,
    ...(row.guarantee ? { guarantee: row.guarantee } : {}),
    ...(row.acknowledgement ? { acknowledgement: row.acknowledgement } : {}),
    createdAt: row.createdAt,
    ...(row.finalizedAt ? { finalizedAt: row.finalizedAt } : {}),
    ...(row.error ? { error: row.error } : {}),
  }
}
