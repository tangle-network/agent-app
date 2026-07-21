import {
  durableChatScopeKey,
  type DurableAnswerIntentRecord,
  type DurableChatScope,
  type DurableInteractionProjection,
  type DurablePlanAuthorityResult,
  type DurablePlanCommandRecord,
  type DurablePlanCommandKey,
  type DurablePlanEffectRecord,
  type DurablePlanProjection,
  type DurablePlanStore,
} from './types'
import { DurableChatConflictError } from './errors'
import { canTransitionPlanStatus } from '../plans/index'

/**
 * Reference adapter for tests and local development. It is intentionally
 * process-local and non-production: there is no locking across processes,
 * transaction, or crash recovery. Production adapters should implement the
 * same port with a database/Workflow primitive and CAS at every claim.
 */
export class InMemoryDurableChatStateStore implements DurablePlanStore {
  private readonly plans = new Map<string, DurablePlanProjection>()
  private readonly currentPlans = new Map<string, string>()
  private readonly commands = new Map<string, DurablePlanCommandRecord>()
  private readonly effects = new Map<string, DurablePlanEffectRecord>()
  private readonly interactions = new Map<string, DurableInteractionProjection>()
  private readonly interactionSemantic = new Map<string, string>()
  /** Duplicate event ids point at the canonical semantic interaction so all
   * duplicate asks settle through one terminal row/attempt. */
  private readonly interactionAliases = new Map<string, string>()
  private readonly answerIntents = new Map<string, DurableAnswerIntentRecord>()

  private scopePrefix(scope: DurableChatScope): string {
    return `${encodeURIComponent(durableChatScopeKey(scope))}\u0000`
  }
  private scopedKey(scope: DurableChatScope, ...parts: Array<string | number>): string {
    return `${this.scopePrefix(scope)}${parts.map((part) => encodeURIComponent(String(part))).join('\u0000')}`
  }
  private planKey(scope: DurableChatScope, planId: string, revision: number): string {
    return this.scopedKey(scope, planId, revision)
  }
  private currentKey(scope: DurableChatScope, planId: string): string {
    return this.scopedKey(scope, planId)
  }
  private commandKey(scope: DurableChatScope, key: string): string {
    return this.scopedKey(scope, key)
  }
  private interactionKey(scope: DurableChatScope, id: string): string {
    return this.scopedKey(scope, id)
  }
  private intentKey(scope: DurableChatScope, key: string): string {
    return this.scopedKey(scope, key)
  }
  private effectKey(scope: DurableChatScope, key: string): string {
    return this.scopedKey(scope, key)
  }

  async getPlanProjection(scope: DurableChatScope, planId: string, revision?: number): Promise<DurablePlanProjection | null> {
    const current = revision === undefined ? this.currentPlans.get(this.currentKey(scope, planId)) : undefined
    const key = revision === undefined
      ? current
      : this.planKey(scope, planId, revision)
    return key ? this.plans.get(key) ?? null : null
  }

  async listPlanProjections(scope: DurableChatScope, planId?: string): Promise<DurablePlanProjection[]> {
    const prefix = this.scopePrefix(scope)
    return [...this.plans.entries()]
      .filter(([key, projection]) => key.startsWith(prefix) && (!planId || projection.planId === planId))
      .map(([, projection]) => projection)
      .sort((a, b) => a.revision - b.revision)
  }

  async putPlanProjection(scope: DurableChatScope, projection: DurablePlanProjection): Promise<void> {
    if (!projection.planId || !Number.isInteger(projection.revision) || projection.revision < 1) {
      throw new TypeError('plan projection requires planId and positive integer revision')
    }
    const key = this.planKey(scope, projection.planId, projection.revision)
    const prior = this.plans.get(key)
    if (prior && JSON.stringify(prior) !== JSON.stringify(projection)) {
      if (
        prior.body !== projection.body ||
        prior.title !== projection.title ||
        prior.submittedAt !== projection.submittedAt
      ) {
        throw new DurableChatConflictError('plan content changed without a new revision')
      }
      if (prior.status === projection.status && !['preparing', 'pending'].includes(prior.status)) {
        throw new DurableChatConflictError('terminal plan projection cannot be rewritten')
      }
      if (!canTransitionPlanStatus(prior.status, projection.status)) {
        throw new DurableChatConflictError('conflicting plan projection for the same revision')
      }
    }
    this.plans.set(key, projection)
    const currentKey = this.currentKey(scope, projection.planId)
    const currentKeyValue = this.currentPlans.get(currentKey)
    const current = currentKeyValue ? this.plans.get(currentKeyValue) : undefined
    if (!current || projection.revision > current.revision) this.currentPlans.set(currentKey, key)
  }

  async getPlanCommand(scope: DurableChatScope, commandKey: DurablePlanCommandKey): Promise<DurablePlanCommandRecord | null> {
    return this.commands.get(this.commandKey(scope, commandKey)) ?? null
  }

  async claimPlanCommand(scope: DurableChatScope, command: DurablePlanCommandRecord) {
    const key = this.commandKey(scope, command.commandKey)
    const existing = this.commands.get(key)
    if (!existing) {
      const prefix = this.scopePrefix(scope)
      const competing = [...this.commands.entries()].find(([storedKey, candidate]) =>
        storedKey.startsWith(prefix) && candidate.planId === command.planId &&
        candidate.revision === command.revision && candidate.decision !== command.decision,
      )
      if (competing) {
        return { status: 'conflict' as const, record: competing[1], reason: 'competing decision for plan revision' }
      }
      this.commands.set(key, command)
      return { status: 'claimed' as const, record: command }
    }
    if (
      existing.planId === command.planId && existing.revision === command.revision &&
      existing.decision === command.decision
    ) return { status: 'existing' as const, record: existing }
    return { status: 'conflict' as const, record: existing, reason: 'command key is already used by another decision' }
  }

  async recordPlanAuthorityResult(scope: DurableChatScope, commandKey: string, result: DurablePlanAuthorityResult, receipt: DurablePlanCommandRecord['receipt']): Promise<void> {
    const key = this.commandKey(scope, commandKey)
    const command = this.commands.get(key)
    if (!command) throw new DurableChatConflictError('cannot record authority result before claiming command')
    command.authorityResult = result
    command.receipt = receipt
    command.state = 'authority_committed'
  }

  async finalizePlanCommand(scope: DurableChatScope, commandKey: string): Promise<void> {
    const command = this.commands.get(this.commandKey(scope, commandKey))
    if (!command) throw new DurableChatConflictError('cannot finalize unknown plan command')
    command.state = 'finalized'
  }

  async getPlanEffect(scope: DurableChatScope, effectKey: string): Promise<DurablePlanEffectRecord | null> {
    return this.effects.get(this.effectKey(scope, effectKey)) ?? null
  }
  async claimPlanEffect(scope: DurableChatScope, effect: DurablePlanEffectRecord) {
    const key = this.effectKey(scope, effect.effectKey)
    const existing = this.effects.get(key)
    if (existing) return { status: 'existing' as const, record: existing }
    this.effects.set(key, effect)
    return { status: 'claimed' as const, record: effect }
  }
  async completePlanEffect(scope: DurableChatScope, effectKey: string): Promise<void> {
    const effect = this.effects.get(this.effectKey(scope, effectKey))
    if (!effect) throw new DurableChatConflictError('cannot complete unknown plan effect')
    effect.state = 'completed'
    effect.completedAt = new Date().toISOString()
  }
  async failPlanEffect(scope: DurableChatScope, effectKey: string, error: string): Promise<void> {
    const effect = this.effects.get(this.effectKey(scope, effectKey))
    if (!effect) throw new DurableChatConflictError('cannot fail unknown plan effect')
    effect.state = 'error'
    effect.error = error
  }

  async getInteractionProjection(scope: DurableChatScope, interactionId: string): Promise<DurableInteractionProjection | null> {
    const directKey = this.interactionKey(scope, interactionId)
    const alias = this.interactionAliases.get(directKey)
    return this.interactions.get(alias ?? directKey) ?? null
  }

  async listInteractionProjections(scope: DurableChatScope): Promise<DurableInteractionProjection[]> {
    const prefix = this.scopePrefix(scope)
    return [...this.interactions.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value)
  }

  async upsertInteractionProjection(scope: DurableChatScope, projection: DurableInteractionProjection): Promise<DurableInteractionProjection> {
    if (!projection.id) throw new TypeError('interaction projection requires id')
    const key = this.interactionKey(scope, projection.id)
    const prior = this.interactions.get(key)
    const resolvedPrior = prior ?? (() => {
      const alias = this.interactionAliases.get(key)
      return alias ? this.interactions.get(alias) : undefined
    })()
    if (!prior && resolvedPrior) {
      this.interactionAliases.set(key, this.interactionKey(scope, resolvedPrior.id))
    }
    if (resolvedPrior) {
      if (projection.eventId && resolvedPrior.eventId === projection.eventId) return resolvedPrior
      if (resolvedPrior.status !== 'pending') {
        if (
          resolvedPrior.tombstone && resolvedPrior.kind === 'unknown' &&
          projection.status === resolvedPrior.status
        ) {
          const enriched = {
            ...projection,
            id: resolvedPrior.id,
            status: resolvedPrior.status,
            tombstone: true,
            ...(resolvedPrior.cancelReason ? { cancelReason: resolvedPrior.cancelReason } : {}),
          }
          this.interactions.set(this.interactionKey(scope, resolvedPrior.id), enriched)
          return enriched
        }
        if (resolvedPrior.status === projection.status && JSON.stringify(resolvedPrior.answers) === JSON.stringify(projection.answers)) return resolvedPrior
        throw new DurableChatConflictError('interaction already has a conflicting terminal outcome')
      }
      // A terminal event wins over pending. A second terminal event is caught
      // above; this is the accepted-answer/cancel ordering rule.
      if (projection.status !== 'pending') {
        const canonical = resolvedPrior.id === projection.id ? projection : { ...projection, id: resolvedPrior.id }
        this.interactions.set(this.interactionKey(scope, canonical.id), canonical)
        if (resolvedPrior.semanticKey) {
          this.interactionSemantic.delete(this.scopedKey(scope, resolvedPrior.semanticKey))
        }
        return canonical
      }
      return resolvedPrior
    }
    if (projection.semanticKey) {
      const semantic = this.scopedKey(scope, projection.semanticKey)
      const priorId = this.interactionSemantic.get(semantic)
      if (priorId) {
        const canonicalKey = this.interactionKey(scope, priorId)
        this.interactionAliases.set(this.interactionKey(scope, projection.id), canonicalKey)
        return this.interactions.get(canonicalKey) ?? projection
      }
      this.interactionSemantic.set(semantic, projection.id)
    }
    this.interactions.set(key, projection)
    return projection
  }

  async getAnswerIntent(scope: DurableChatScope, intentKey: string): Promise<DurableAnswerIntentRecord | null> {
    return this.answerIntents.get(this.intentKey(scope, intentKey)) ?? null
  }
  async claimAnswerIntent(scope: DurableChatScope, intent: DurableAnswerIntentRecord) {
    const key = this.intentKey(scope, intent.intentKey)
    const existing = this.answerIntents.get(key)
    if (!existing) {
      this.answerIntents.set(key, intent)
      return { status: 'claimed' as const, record: intent }
    }
    if (existing.interactionId === intent.interactionId && existing.attemptKey === intent.attemptKey && existing.outcome === intent.outcome && JSON.stringify(existing.data) === JSON.stringify(intent.data)) {
      return { status: 'existing' as const, record: existing }
    }
    return { status: 'conflict' as const, record: existing, reason: 'answer intent key is already used by another answer' }
  }
  async acknowledgeAnswerIntent(scope: DurableChatScope, intentKey: string, acknowledgement: DurableAnswerIntentRecord['acknowledgement']): Promise<void> {
    const intent = this.answerIntents.get(this.intentKey(scope, intentKey))
    if (!intent) throw new DurableChatConflictError('cannot acknowledge unknown answer intent')
    if (intent.state === 'finalized') return
    intent.acknowledgement = acknowledgement
    intent.state = 'acknowledged'
  }
  async finalizeAnswerIntent(scope: DurableChatScope, intentKey: string, guarantee: DurableAnswerIntentRecord['guarantee'] = 'reconciled'): Promise<void> {
    const intent = this.answerIntents.get(this.intentKey(scope, intentKey))
    if (!intent) throw new DurableChatConflictError('cannot finalize unknown answer intent')
    if (intent.state === 'finalized') return
    if (!intent.acknowledgement?.acknowledged) {
      throw new DurableChatConflictError('cannot finalize an answer before authority acknowledgement')
    }
    const projection = await this.getInteractionProjection(scope, intent.interactionId)
    if (!projection) throw new DurableChatConflictError('cannot finalize an answer before its ask projection')
    const status = intent.outcome === 'accepted' ? 'answered' : 'declined'
    await this.upsertInteractionProjection(scope, {
      ...projection,
      status,
      ...(intent.data ? { answers: intent.data } : {}),
      updatedAt: intent.acknowledgement.at ?? new Date().toISOString(),
    })
    intent.state = 'finalized'
    intent.guarantee = guarantee
    intent.finalizedAt = new Date().toISOString()
  }
  async abortAnswerIntent(scope: DurableChatScope, intentKey: string, error: string): Promise<void> {
    const intent = this.answerIntents.get(this.intentKey(scope, intentKey))
    if (!intent) throw new DurableChatConflictError('cannot abort unknown answer intent')
    if (intent.state === 'finalized') return
    intent.state = 'aborted'
    intent.error = error
  }
}

/** Short aliases retained for adapter authors who call this a durable chat
 * store rather than a state store. Both names refer to the same non-production
 * reference implementation. */
export const InMemoryDurableChatStore = InMemoryDurableChatStateStore
export function createInMemoryDurableChatStateStore(): InMemoryDurableChatStateStore {
  return new InMemoryDurableChatStateStore()
}
