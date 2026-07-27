import {
  interactionToPersistedPart,
  parseInteractionCancel,
  parseInteractionRequest,
  type InteractionCancelData,
  type InteractionPersistedPart,
  type InteractionRequestWire,
} from '../interactions/contract'
import { DurableChatConflictError } from './errors'
import type {
  DurableInteractionRouteArgs,
  DurableInteractionRoutePersistence,
} from '../interactions/route'
import {
  createDurableInteractionSettlement,
  recordDurableInteractionCancel,
  upsertDurableInteractionAsk,
} from './interactions'
import type {
  DurableAnswerIntentRecord,
  DurableChatScope,
  DurableInteractionAcknowledgement,
  DurableInteractionGuarantee,
  DurableInteractionSettlement,
  DurableChatStore,
  DurableInteractionStore,
} from './types'
import {
  parsePlanSubmittedEvent,
  persistedPartToPlan,
  planToPersistedPart,
} from '../plans/index'

/** Define methods to manage durable interaction projections including upsert, cancel, and materialize operations */
export interface DurableInteractionProjectionAdapter {
  upsertAsk(request: InteractionRequestWire): Promise<void>
  cancel(cancel: InteractionCancelData): Promise<void>
  materialize(): Promise<InteractionPersistedPart[]>
}

/** Binds an authorized durable scope/store to interaction lifecycle events. */
export function createDurableInteractionProjectionAdapter(options: {
  store: DurableInteractionStore
  scope: DurableChatScope
  now?: () => string
}): DurableInteractionProjectionAdapter {
  const observed = new Set<string>()
  return {
    async upsertAsk(request) {
      observed.add(request.id)
      await upsertDurableInteractionAsk(options.store, options.scope, request, { now: options.now })
    },
    async cancel(cancel) {
      observed.add(cancel.id)
      await recordDurableInteractionCancel(
        options.store,
        options.scope,
        cancel.id,
        cancel.reason,
        { now: options.now },
      )
    },
    async materialize() {
      const projections = await Promise.all(
        [...observed].map((id) => options.store.getInteractionProjection(options.scope, id)),
      )
      const canonical = new Map(projections.filter((item) => item !== null).map((item) => [item.id, item]))
      return [...canonical.values()]
        .filter((projection) => projection.kind !== 'unknown')
        .map((projection) => interactionToPersistedPart(
          {
            id: projection.id,
            kind: projection.kind,
            title: projection.title,
            ...(projection.body ? { body: projection.body } : {}),
            answerSpec: { fields: projection.fields },
          },
          projection.status,
          projection.cancelReason,
          projection.answers,
        ))
    },
  }
}

/** Resolve chat events and materialize their state into durable records */
export interface DurableChatEventProjection {
  observe(event: unknown): void | Promise<void>
  materialize(): Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>
}

function eventRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.kind === 'event' && record.event && typeof record.event === 'object') {
    return record.event as Record<string, unknown>
  }
  return record
}

/** Event projector usable with any `ChatTurnRouteProducer` through
 * `withDurableChatProjection`. It tracks this turn's identities so older
 * thread state is not copied into every assistant message. */
export function createDurableChatEventProjection(options: {
  store: DurableChatStore
  scope: DurableChatScope
  now?: () => string
}): DurableChatEventProjection {
  const interactions = createDurableInteractionProjectionAdapter(options)
  const plans = new Set<string>()
  return {
    async observe(value) {
      const event = eventRecord(value)
      if (!event || typeof event.type !== 'string') return
      const data = eventRecord(event.data)
      if (event.type === 'interaction') {
        const parsed = parseInteractionRequest(data ?? undefined)
        if (parsed.succeeded) await interactions.upsertAsk(parsed.value)
        return
      }
      if (event.type === 'interaction.cancel') {
        const parsed = parseInteractionCancel(data ?? undefined)
        if (parsed.succeeded) {
          try {
            await interactions.cancel(parsed.value)
          } catch (error) {
            if (!(error instanceof DurableChatConflictError)) throw error
          }
        }
        return
      }
      if (!event.type.startsWith('plan.')) return
      const submitted = parsePlanSubmittedEvent(event)
      const planRecord = eventRecord(data?.plan) ?? eventRecord(eventRecord(event.properties)?.plan)
      const plan = submitted.succeeded
        ? submitted.value
        : planRecord ? persistedPartToPlan({ type: 'plan', ...planRecord }) : null
      if (!plan) return
      plans.add(`${plan.planId}\u0000${plan.revision}`)
      try {
        await options.store.putPlanProjection(options.scope, plan)
      } catch (error) {
        if (!(error instanceof DurableChatConflictError)) throw error
      }
    },
    async materialize() {
      const interactionParts = await interactions.materialize()
      const planParts = await Promise.all([...plans].map(async (key) => {
        const [planId, rawRevision] = key.split('\u0000')
        const plan = await options.store.getPlanProjection(options.scope, planId!, Number(rawRevision))
        return plan ? planToPersistedPart(plan) : null
      }))
      return [...interactionParts, ...planParts.filter((part) => part !== null)]
    },
  }
}

/** Define a structured response containing scope, settlement, and intent for durable interactions */
export interface PreparedDurableInteractionAnswer {
  scope: DurableChatScope
  settlement: DurableInteractionSettlement
  intent: DurableAnswerIntentRecord
}

interface DurableInteractionRoutePersistenceBase {
  store: DurableInteractionStore
  scope(args: DurableInteractionRouteArgs): DurableChatScope | Promise<DurableChatScope>
  now?: () => string
}

/**
 * Options for durable interaction route persistence.
 *
 * Prefer `'best-effort'`: it is the honest default and still gives full crash
 * recovery through the intent journal. `'reconciled'` is for a product that owns
 * an authority able to confirm a specific answer committed — it structurally
 * requires that lookup, because the guarantee names evidence, not intent.
 */
export type CreateDurableInteractionRoutePersistenceOptions =
  | (DurableInteractionRoutePersistenceBase & {
      /**
       * Requires `reconcileAuthority`. The sidecar cannot currently satisfy this
       * on its own — see `DurableInteractionGuarantee`.
       */
      guarantee: 'reconciled'
      reconcileAuthority(args: {
        scope: DurableChatScope
        intent: DurableAnswerIntentRecord
        route: DurableInteractionRouteArgs
      }): Promise<DurableInteractionAcknowledgement | null>
    })
  | (DurableInteractionRoutePersistenceBase & {
      guarantee: 'best-effort'
      reconcileAuthority?: (args: {
        scope: DurableChatScope
        intent: DurableAnswerIntentRecord
        route: DurableInteractionRouteArgs
      }) => Promise<DurableInteractionAcknowledgement | null>
    })

/**
 * Ready-to-use bridge from `/interactions` to the durable interaction port.
 *
 * **Crash recovery is automatic and does not depend on the guarantee level.**
 * `reconcile` below resolves an ambiguous retry from the durable journal alone:
 * an intent that a previous attempt left `acknowledged` is finished and reported
 * settled, and one already `finalized` reports settled directly. Because the
 * settlement only reaches those states after a successful answer POST, that is
 * real proof of delivery — no upstream lookup, no product code, every adopter.
 *
 * `reconcileAuthority` covers only what local state cannot: an attempt that died
 * between the successful POST and its acknowledgement, leaving the intent at
 * `prepared`. See `DurableInteractionGuarantee` for why the sidecar cannot
 * currently answer that, and `./reconcile` for the partial signal that exists.
 */
export function createDurableInteractionRoutePersistence(
  options: CreateDurableInteractionRoutePersistenceOptions,
): DurableInteractionRoutePersistence<PreparedDurableInteractionAnswer> {
  const guarantee: DurableInteractionGuarantee = options.guarantee
  // The union type already forbids this, but the guard defends JavaScript
  // callers and re-exports — a persisted `reconciled` with nothing reconciling
  // is precisely the dishonest record this module is meant to stop producing.
  if (guarantee === 'reconciled' && typeof options.reconcileAuthority !== 'function') {
    throw new TypeError(
      "durable interaction persistence: guarantee 'reconciled' requires a reconcileAuthority. " +
      "Use 'best-effort' (crash recovery from the intent journal still applies), or supply an authority lookup.",
    )
  }
  return {
    guarantee,
    async prepare(args) {
      const scope = await options.scope(args)
      const settlement = createDurableInteractionSettlement({
        store: options.store,
        attemptKey: args.attemptKey,
        guarantee,
        now: options.now,
        ...(options.reconcileAuthority
          ? { reconcileAuthority: ({ intent }) => options.reconcileAuthority!({ scope, intent, route: args }) }
          : {}),
      })
      const intent = await settlement.prepare(
        scope,
        args.answer.id,
        args.answer.outcome,
        args.answer.data,
      )
      return { scope, settlement, intent }
    },
    async reconcile({ prepared }) {
      let intent = await prepared.settlement.reconcile(prepared.scope, prepared.intent.intentKey)
      if (intent?.state === 'acknowledged') {
        intent = await prepared.settlement.finalize(prepared.scope, prepared.intent.intentKey)
      }
      return { settled: intent?.state === 'finalized' }
    },
    async acknowledge({ prepared }) {
      await prepared.settlement.acknowledge(prepared.scope, prepared.intent.intentKey, {
        status: prepared.intent.outcome,
      })
    },
    async finalize({ prepared }) {
      await prepared.settlement.finalize(prepared.scope, prepared.intent.intentKey)
    },
    async fail({ prepared, error }) {
      await prepared.settlement.abort(
        prepared.scope,
        prepared.intent.intentKey,
        error instanceof Error ? error.message : String(error),
      )
    },
  }
}
