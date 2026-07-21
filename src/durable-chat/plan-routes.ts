import {
  DurableChatConflictError,
  DurableChatGoneError,
  DurableChatUnavailableError,
} from './errors'
import {
  durableChatScopeKey,
  normalizePlanDecision,
  planAuthorityIdempotencyKey,
  planCommandKey,
  planEffectKey,
  stablePlanReceipt,
  type DurableChatScope,
  type DurableFollowUpReceipt,
  type DurablePlanAuthority,
  type DurablePlanAuthorityCurrentResult,
  type DurablePlanAuthorityResult,
  type DurablePlanCommandRecord,
  type DurablePlanProjection,
  type DurablePlanStore,
} from './types'
import { canTransitionPlanStatus, planFollowUpTurnId } from '../plans/index'

export type DurablePlanAuthorization =
  | DurableChatScope
  | { scope: DurableChatScope }
  | Response
  | null
  | undefined

export interface DurablePlanRouteAuthorizeArgs {
  request: Request
  operation: 'current' | 'decide'
  planId?: string
}

export interface DurablePlanRouteOptions {
  store: DurablePlanStore
  authority: DurablePlanAuthority
  /** Authentication and resource authorization. Scope must be derived by the
   * caller from trusted credentials, never from client JSON. */
  authorize: (args: DurablePlanRouteAuthorizeArgs) => Promise<DurablePlanAuthorization> | DurablePlanAuthorization
  /** Required idempotent side effect seam. The route claims `effectKey` before
   * calling it; a product must make the callback safe to retry by that key. */
  afterDecision: (args: {
    scope: DurableChatScope
    plan: DurablePlanProjection
    receipt: DurableFollowUpReceipt
    effectKey: string
  }) => Promise<void> | void
  now?: () => string
  logger?: Pick<Console, 'warn' | 'error'>
}

export interface DurablePlanRoutes {
  current(request: Request): Promise<Response>
  decide(request: Request): Promise<Response>
}

type ParsedDecision = {
  planId: string
  revision: number
  decision: 'approved' | 'rejected'
  feedback?: string
}

function errorResponse(error: unknown, fallbackCode: string, fallbackStatus: number, fallbackMessage: string): Response {
  if (error instanceof Response) return error
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
    const typed = error as { code?: unknown; message?: unknown; status: number }
    return Response.json(
      { code: typeof typed.code === 'string' ? typed.code : fallbackCode, error: typeof typed.message === 'string' ? typed.message : fallbackMessage },
      { status: typed.status },
    )
  }
  return Response.json({ code: fallbackCode, error: fallbackMessage }, { status: fallbackStatus })
}

function scopeFromAuthorization(value: DurablePlanAuthorization): DurableChatScope | Response {
  if (value instanceof Response) return value
  if (typeof value === 'string' && value) return value
  if (value && typeof value === 'object' && 'scope' in value && value.scope) return value.scope
  return Response.json({ code: 'DURABLE_CHAT_UNAUTHORIZED', error: 'not authorized' }, { status: 401 })
}

function planIdFromUrl(request: Request): string | null {
  const url = new URL(request.url)
  const query = url.searchParams.get('planId') ?? url.searchParams.get('id')
  if (query) return query
  const segments = url.pathname.split('/').filter(Boolean)
  return segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]!) : null
}

function asCurrent(value: DurablePlanAuthorityCurrentResult | DurablePlanProjection | null): DurablePlanAuthorityCurrentResult {
  if (value === null) return { plan: null }
  if ('plan' in value) return value
  return { plan: value }
}

function terminalDecision(plan: DurablePlanProjection | null): 'approved' | 'rejected' | null {
  if (!plan) return null
  return plan.status === 'approved' || plan.status === 'rejected' ? plan.status : null
}

function parseDecisionBody(body: unknown): ParsedDecision | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Invalid JSON body' }
  const record = body as Record<string, unknown>
  const planId = typeof record.planId === 'string' && record.planId
    ? record.planId
    : typeof record.id === 'string' && record.id ? record.id : null
  const revision = record.revision
  const decision = normalizePlanDecision(record.decision ?? record.outcome ?? record.status)
  if (!planId) return { error: 'Missing planId' }
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return { error: 'revision must be a positive integer' }
  if (!decision) return { error: 'decision must be approved or rejected' }
  if (record.feedback !== undefined && typeof record.feedback !== 'string') return { error: 'feedback must be a string' }
  return { planId, revision, decision, ...(typeof record.feedback === 'string' ? { feedback: record.feedback } : {}) }
}

function withReceipt(result: DurablePlanAuthorityResult, scope: DurableChatScope, parsed: ParsedDecision): DurablePlanAuthorityResult & { receipt: DurableFollowUpReceipt } {
  const receipt = result.receipt ?? stablePlanReceipt(scope, parsed.planId, parsed.revision, parsed.decision, result)
  return { ...result, receipt }
}

function recoverReceipt(
  scope: DurableChatScope,
  plan: DurablePlanProjection,
  decision: 'approved' | 'rejected',
): DurableFollowUpReceipt {
  return stablePlanReceipt(scope, plan.planId, plan.revision, decision, {
    followUp: { turnId: planFollowUpTurnId(plan.planId, decision), state: 'unknown' },
  })
}

export function createDurablePlanRoutes(options: DurablePlanRouteOptions): DurablePlanRoutes {
  const now = options.now ?? (() => new Date().toISOString())
  const logger = options.logger ?? console

  async function authorize(request: Request, operation: 'current' | 'decide', planId?: string): Promise<DurableChatScope | Response> {
    try {
      return scopeFromAuthorization(await options.authorize({ request, operation, ...(planId ? { planId } : {}) }))
    } catch (error) {
      return errorResponse(error, 'DURABLE_CHAT_UNAUTHORIZED', 401, 'not authorized')
    }
  }

  async function runEffect(
    scope: DurableChatScope,
    plan: DurablePlanProjection,
    receipt: DurableFollowUpReceipt,
  ): Promise<boolean> {
    const effectKey = planEffectKey(scope, plan.planId, plan.revision, receipt.decision)
    try {
      const existing = await options.store.getPlanEffect(scope, effectKey)
      if (existing?.state === 'completed') return true
      const claim = await options.store.claimPlanEffect(scope, {
        effectKey, scope, planId: plan.planId, revision: plan.revision,
        decision: receipt.decision, state: 'claimed', claimedAt: now(),
      })
      if (claim.status === 'existing' && claim.record.state === 'completed') return true
      await options.afterDecision({ scope, plan, receipt, effectKey })
      await options.store.completePlanEffect(scope, effectKey)
      return true
    } catch (error) {
      await options.store.failPlanEffect(scope, effectKey, error instanceof Error ? error.message : String(error)).catch(() => undefined)
      logger.warn('[durable-chat] afterDecision failed:', error)
      return false
    }
  }

  async function current(request: Request): Promise<Response> {
    const planId = planIdFromUrl(request)
    if (!planId) return Response.json({ code: 'DURABLE_CHAT_BAD_REQUEST', error: 'Missing planId' }, { status: 400 })
    const scope = await authorize(request, 'current', planId)
    if (scope instanceof Response) return scope
    const local = await options.store.getPlanProjection(scope, planId)
    let authoritative: DurablePlanAuthorityCurrentResult
    try {
      authoritative = asCurrent(await options.authority.current({ scope, planId }))
    } catch (error) {
      // A known terminal local record is safe to replay while authority is
      // temporarily down; pending records must not pretend to be committed.
      const decision = terminalDecision(local)
      if (decision) {
        const command = await options.store.getPlanCommand(scope, planCommandKey(planId, local!.revision, decision))
        if (command?.receipt) {
          const effectComplete = await runEffect(scope, command.authorityResult?.plan ?? local!, command.receipt)
          return Response.json({
            plan: command.authorityResult?.plan ?? local,
            receipt: command.receipt,
            replayed: true,
            ...(!effectComplete ? { effectPending: true } : {}),
          })
        }
      }
      return errorResponse(error, 'DURABLE_CHAT_UNAVAILABLE', 503, 'plan authority unavailable')
    }
    if (!authoritative.plan) {
      return Response.json({ code: 'DURABLE_CHAT_GONE', error: 'plan is no longer available' }, { status: 410 })
    }
    const authorityPlan = authoritative.plan
    const localWins = Boolean(local && (
      local.revision > authorityPlan.revision ||
      (local.revision === authorityPlan.revision && !canTransitionPlanStatus(local.status, authorityPlan.status))
    ))
    const plan = localWins ? local! : authorityPlan
    let projectionPending = false
    if (!localWins) {
      try {
        await options.store.putPlanProjection(scope, plan)
      } catch (error) {
        projectionPending = true
        logger.warn('[durable-chat] failed to heal plan projection:', error)
      }
    }
    const decision = terminalDecision(plan)
    let receipt = localWins ? undefined : authoritative.receipt
    if (!receipt && decision) {
      const command = await options.store.getPlanCommand(scope, planCommandKey(plan.planId, plan.revision, decision))
      receipt = command?.receipt
      if (!receipt) receipt = recoverReceipt(scope, plan, decision)
    }
    const effectComplete = decision && receipt ? await runEffect(scope, plan, receipt) : true
    return Response.json({
      plan,
      ...(receipt ? { receipt } : {}),
      ...(projectionPending ? { projectionPending: true } : {}),
      ...(!effectComplete ? { effectPending: true } : {}),
    })
  }

  async function decide(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null)
    const parsed = parseDecisionBody(body)
    if ('error' in parsed) return Response.json({ code: 'DURABLE_CHAT_BAD_REQUEST', error: parsed.error }, { status: 400 })
    const scope = await authorize(request, 'decide', parsed.planId)
    if (scope instanceof Response) return scope
    const local = await options.store.getPlanProjection(scope, parsed.planId, parsed.revision)
    const current = await options.store.getPlanProjection(scope, parsed.planId)
    if (!local) {
      return Response.json({ code: 'DURABLE_CHAT_UNAVAILABLE', error: 'submitted plan projection is required before deciding' }, { status: 503 })
    }
    if (current && parsed.revision < current.revision) {
      return Response.json({ code: 'DURABLE_CHAT_CONFLICT', error: 'stale plan revision' }, { status: 409 })
    }
    if (local.status !== 'pending') {
      const existingTerminal = terminalDecision(local)
      if (existingTerminal === parsed.decision) {
        const existing = await options.store.getPlanCommand(scope, planCommandKey(parsed.planId, parsed.revision, parsed.decision))
        const receipt = existing?.receipt ?? recoverReceipt(scope, local, parsed.decision)
        const effectComplete = await runEffect(scope, existing?.authorityResult?.plan ?? local, receipt)
        return Response.json({
          plan: existing?.authorityResult?.plan ?? local,
          receipt,
          replayed: true,
          ...(!effectComplete ? { effectPending: true } : {}),
        })
      }
      return Response.json({
        code: 'DURABLE_CHAT_CONFLICT',
        error: 'plan is not pending',
        plan: local,
      }, { status: 409 })
    }
    const opposite = parsed.decision === 'approved' ? 'rejected' : 'approved'
    const oppositeCommand = await options.store.getPlanCommand(scope, planCommandKey(parsed.planId, parsed.revision, opposite))
    if (oppositeCommand) return Response.json({ code: 'DURABLE_CHAT_CONFLICT', error: 'competing decision for plan revision' }, { status: 409 })
    const commandKey = planCommandKey(parsed.planId, parsed.revision, parsed.decision)
    const authorityIdempotencyKey = planAuthorityIdempotencyKey(scope, parsed.planId, parsed.revision, parsed.decision)
    const command: DurablePlanCommandRecord = {
      scope, planId: parsed.planId, revision: parsed.revision, decision: parsed.decision,
      commandKey, authorityIdempotencyKey, state: 'claimed', claimedAt: now(),
    }
    const claimed = await options.store.claimPlanCommand(scope, command)
    if (claimed.status === 'conflict') return Response.json({ code: 'DURABLE_CHAT_CONFLICT', error: claimed.reason }, { status: 409 })
    if (claimed.status === 'existing' && claimed.record.receipt) {
      // Effect errors are intentionally retried on a known committed command.
      const effectComplete = await runEffect(scope, claimed.record.authorityResult?.plan ?? local, claimed.record.receipt)
      return Response.json({
        plan: claimed.record.authorityResult?.plan ?? local,
        receipt: claimed.record.receipt,
        replayed: true,
        ...(!effectComplete ? { effectPending: true } : {}),
      })
    }
    let authorityResult: DurablePlanAuthorityResult & { receipt: DurableFollowUpReceipt }
    try {
      authorityResult = withReceipt(await options.authority.decide({
        scope, planId: parsed.planId, revision: parsed.revision, decision: parsed.decision,
        ...(parsed.feedback ? { feedback: parsed.feedback } : {}), idempotencyKey: authorityIdempotencyKey,
      }), scope, parsed)
    } catch (error) {
      try {
        const reconciled = asCurrent(await options.authority.current({
          scope,
          planId: parsed.planId,
          revision: parsed.revision,
        }))
        const terminal = terminalDecision(reconciled.plan)
        if (reconciled.plan && terminal === parsed.decision) {
          const receipt = reconciled.receipt ?? recoverReceipt(scope, reconciled.plan, terminal)
          authorityResult = {
            plan: reconciled.plan,
            followUp: { turnId: receipt.turnId, state: receipt.state },
            idempotent: true,
            receipt,
          }
        } else if (reconciled.plan && reconciled.plan.status !== 'pending') {
          // The authority has already moved this revision out of its pending
          // state, but not to the decision this request asked for. Surface the
          // authoritative snapshot so the client can converge instead of
          // retrying an already-lost decision as if the authority were down.
          let projectionPending = false
          try {
            await options.store.putPlanProjection(scope, reconciled.plan)
          } catch (projectionError) {
            projectionPending = true
            logger.warn('[durable-chat] failed to reconcile conflicting plan projection:', projectionError)
          }
          return Response.json({
            code: 'DURABLE_CHAT_CONFLICT',
            error: 'plan is not pending',
            plan: reconciled.plan,
            ...(reconciled.receipt ? { receipt: reconciled.receipt } : {}),
            ...(projectionPending ? { projectionPending: true } : {}),
          }, { status: 409 })
        } else {
          return errorResponse(error, 'DURABLE_CHAT_UNAVAILABLE', 503, 'plan authority unavailable')
        }
      } catch {
        return errorResponse(error, 'DURABLE_CHAT_UNAVAILABLE', 503, 'plan authority unavailable')
      }
    }
    let projectionPending = false
    try {
      await options.store.recordPlanAuthorityResult(scope, commandKey, authorityResult, authorityResult.receipt)
    } catch (error) {
      projectionPending = true
      // The authority has committed; the receipt remains safe to return and
      // GET can reconcile from the authority on the next request.
      logger.warn('[durable-chat] failed to record authority result:', error)
    }
    try {
      await options.store.putPlanProjection(scope, authorityResult.plan)
      await options.store.finalizePlanCommand(scope, commandKey)
    } catch (error) {
      projectionPending = true
      logger.warn('[durable-chat] failed to finalize plan projection:', error)
    }
    const effectComplete = await runEffect(scope, authorityResult.plan, authorityResult.receipt)
    return Response.json({
      plan: authorityResult.plan,
      receipt: authorityResult.receipt,
      ...(projectionPending ? { projectionPending: true } : {}),
      ...(!effectComplete ? { effectPending: true } : {}),
    })
  }

  return { current, decide }
}
