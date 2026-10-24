import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import type { ChatPlan } from '../plans/index'

/** Represent durable plan decisions as either approved or rejected */
export type DurablePlanDecision = 'approved' | 'rejected'

/** Stable authority receipt for the follow-up turn dispatched by a plan
 * decision. Consumers must make `attachFollowUp` idempotent by `receiptId`;
 * reload and retry deliberately invoke it again. */
export interface DurablePlanFollowUpReceipt {
  receiptId: string
  planId: string
  revision: number
  turnId: string
  state: string
}

/** Describe the result of a durable plan decision including plan details and pending statuses */
export interface DurablePlanDecisionResult {
  plan: ChatPlan
  followUp?: DurablePlanFollowUpReceipt
  idempotent: boolean
  projectionPending?: boolean
  effectPending?: boolean
}

/** Define input parameters for making a durable plan decision including optional feedback */
export interface DurablePlanDecisionInput {
  planId: string
  revision: number
  decision: DurablePlanDecision
  feedback?: string
}

/** Define input parameters for retrieving the current durable plan including optional revision number */
export interface DurablePlanCurrentInput {
  planId: string
  revision?: number
}

/** Define methods to obtain and decide durable plan decisions asynchronously */
export interface DurablePlanDecisionClient {
  /** Stable transport context, independent of the client object's identity. */
  readonly scopeKey?: string
  current: (input: DurablePlanCurrentInput) => Promise<DurablePlanDecisionResult>
  decide: (input: DurablePlanDecisionInput) => Promise<DurablePlanDecisionResult>
}

/** Represent errors from DurablePlanClient operations including status, code, and current plan details */
export class DurablePlanClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly currentPlan?: ChatPlan,
  ) {
    super(message)
    this.name = 'DurablePlanClientError'
  }
}

/** Define configuration options for creating a durable plan decision client */
export interface DurablePlanDecisionClientOptions {
  url: string | ((input: DurablePlanCurrentInput | DurablePlanDecisionInput) => string)
  /** Non-secret endpoint/workspace/authentication identity. Defaults to a
   * string URL; function URLs and authentication changes need an explicit key. */
  scopeKey?: string
  body?: Record<string, unknown> | ((input: DurablePlanDecisionInput) => Record<string, unknown>)
  fetchImpl?: typeof fetch
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readPlan(value: unknown): ChatPlan | null {
  const plan = recordOf(value)
  if (!plan) return null
  const planId = typeof plan.planId === 'string' ? plan.planId : typeof plan.id === 'string' ? plan.id : null
  if (!planId || typeof plan.revision !== 'number' || typeof plan.body !== 'string' ||
      typeof plan.submittedAt !== 'string' || typeof plan.status !== 'string') return null
  return { ...plan, planId } as ChatPlan
}

function receiptIdentity(plan: ChatPlan, followUp: Record<string, unknown>): string {
  if (typeof followUp.receiptId === 'string' && followUp.receiptId) return followUp.receiptId
  const turnId = typeof followUp.turnId === 'string' ? followUp.turnId : ''
  return `${plan.planId}:${plan.revision}:${turnId}`
}

function parseDecisionResult(value: unknown): DurablePlanDecisionResult | null {
  const body = recordOf(value)
  const plan = readPlan(body?.plan)
  if (!body || !plan) return null
  const rawFollowUp = recordOf(body.followUp) ?? recordOf(body.receipt)
  const followUp = rawFollowUp && typeof rawFollowUp.turnId === 'string'
    ? {
        receiptId: receiptIdentity(plan, rawFollowUp),
        planId: plan.planId,
        revision: plan.revision,
        turnId: rawFollowUp.turnId,
        state: typeof rawFollowUp.state === 'string' ? rawFollowUp.state : 'unknown',
      }
    : undefined
  return {
    plan,
    ...(followUp ? { followUp } : {}),
    idempotent: body.idempotent === true || body.replayed === true,
    ...(body.projectionPending === true ? { projectionPending: true } : {}),
    ...(body.effectPending === true ? { effectPending: true } : {}),
  }
}

/** Browser client for the shared durable-plan route. The route URL and all
 * product routing fields are injected; workspace/session identity is still
 * resolved and authorized on the server. */
export function createDurablePlanDecisionClient(
  options: DurablePlanDecisionClientOptions,
): DurablePlanDecisionClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const urlFor = (input: DurablePlanCurrentInput | DurablePlanDecisionInput) =>
    typeof options.url === 'function' ? options.url(input) : options.url

  const read = async (response: Response): Promise<DurablePlanDecisionResult> => {
    const body = recordOf(await response.json().catch(() => null)) ?? {}
    const result = parseDecisionResult(body)
    if (response.ok && result) return result
    const currentPlan = readPlan(body.plan) ?? undefined
    const message = typeof body.error === 'string'
      ? body.error
      : typeof body.message === 'string' ? body.message : `Plan request failed (${response.status})`
    throw new DurablePlanClientError(
      message,
      response.status,
      typeof body.code === 'string' ? body.code : undefined,
      currentPlan,
    )
  }

  return {
    scopeKey: options.scopeKey ?? (typeof options.url === 'string' ? options.url : undefined),
    async current(input) {
      const rawUrl = urlFor(input)
      const url = new URL(rawUrl, globalThis.location?.origin ?? 'http://localhost')
      url.searchParams.set('planId', input.planId)
      if (input.revision !== undefined) url.searchParams.set('revision', String(input.revision))
      const target = /^https?:/.test(rawUrl)
        ? url.toString()
        : `${url.pathname}${url.search}`
      return read(await fetchImpl(target, { method: 'GET' }))
    },
    async decide(input) {
      const extra = typeof options.body === 'function' ? options.body(input) : options.body ?? {}
      return read(await fetchImpl(urlFor(input), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...extra, ...input }),
      }))
    },
  }
}

/** Define options to configure durable plan flow with plan, client, and optional callbacks */
export interface UseDurablePlanFlowOptions {
  plan: ChatPlan
  client: DurablePlanDecisionClient
  /** Stable, non-secret identity of the endpoint/workspace/authentication
   * context. Change it when that context changes even if the plan does not.
   * Defaults to client.scopeKey. Incidental client object recreation does not
   * change request lifetime. */
  scopeKey?: string
  /** Must be idempotent by receipt.receiptId. */
  attachFollowUp?: (receipt: DurablePlanFollowUpReceipt, plan: ChatPlan, decision: DurablePlanDecision) => Promise<void> | void
  /** Restore an already-decided plan and bound failed follow-up attachment attempts. */
  autoRestore?: boolean
  onUpdated?: (plan: ChatPlan) => void
}

/** Define the result and actions for managing a durable plan flow including decisions, restoration, and error handling */
export interface UseDurablePlanFlowResult {
  plan: ChatPlan
  deciding: DurablePlanDecision | null
  restoring: boolean
  error: string | null
  decide: (decision: DurablePlanDecision, feedback?: string) => Promise<DurablePlanDecisionResult | null>
  restore: () => Promise<DurablePlanDecisionResult | null>
  clearError: () => void
  effectPending: boolean
  attachError: string | null
  retryAttach: () => void
}

const RESTORE_ATTEMPT_LIMIT = 2
const ATTACH_ERROR = 'Your decision was saved, but notifying the agent about it failed. Try again.'

interface PlanRestorationState {
  restored: string | null
  inFlight: string | null
  attempts: Map<string, number>
}

function planDecisionKey(plan: ChatPlan): string {
  return `${plan.planId}:${plan.revision}:${plan.status}`
}

function useAutomaticPlanRestore(args: {
  plan: ChatPlan
  enabled: boolean
  restore: UseDurablePlanFlowResult['restore']
  state: MutableRefObject<PlanRestorationState>
  retry: number
  advance: () => void
  failed: (error: string) => void
}): void {
  const { plan, enabled, restore, state, retry, advance, failed } = args
  useEffect(() => {
    if (!enabled || (plan.status !== 'approved' && plan.status !== 'rejected')) return
    const key = planDecisionKey(plan)
    if (state.current.restored === key || state.current.inFlight === key) return
    const attempts = state.current.attempts.get(key) ?? 0
    if (attempts >= RESTORE_ATTEMPT_LIMIT) { failed(ATTACH_ERROR); return }
    state.current.attempts.set(key, attempts + 1)
    state.current.inFlight = key
    const active = state.current
    void restore().then((result) => {
      if (state.current !== active) return
      if (state.current.inFlight === key) state.current.inFlight = null
      if (state.current.restored === key || result?.effectPending) return
      if ((state.current.attempts.get(key) ?? 0) < RESTORE_ATTEMPT_LIMIT) advance()
      else failed(ATTACH_ERROR)
    })
  }, [plan.planId, plan.revision, plan.status, enabled, restore, state, retry, advance, failed])
}

/** Shared plan decision controller. It coalesces only concurrent attachment
 * attempts; a later retry/restore calls the consumer's idempotent transport
 * again so a lost response cannot strand an already-dispatched follow-up. */
export function useDurablePlanFlow(options: UseDurablePlanFlowOptions): UseDurablePlanFlowResult {
  const [plan, setPlan] = useState(options.plan)
  const [deciding, setDeciding] = useState<DurablePlanDecision | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const attachments = useRef(new Map<string, Promise<void>>())
  const decisionInFlight = useRef(false)
  const restoration = useRef<PlanRestorationState>({ restored: null, inFlight: null, attempts: new Map() })
  const [effectPending, setEffectPending] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [restoreRetry, setRestoreRetry] = useState(0)
  const advanceRestore = useCallback(() => setRestoreRetry(value => value + 1), [])
  const lifetime = useRef<object | null>(null)
  const scopeKey = options.scopeKey ?? options.client.scopeKey
  const latest = useRef(options)
  useLayoutEffect(() => { latest.current = options })
  useLayoutEffect(() => {
    lifetime.current = {}
    restoration.current = { restored: null, inFlight: null, attempts: new Map() }
    attachments.current = new Map()
    decisionInFlight.current = false
    setPlan(options.plan)
    setEffectPending(false)
    setAttachError(null)
    setError(null)
    setDeciding(null)
    setRestoring(false)
    return () => {
      lifetime.current = null
      restoration.current = { restored: null, inFlight: null, attempts: new Map() }
    }
  }, [options.plan.planId, options.plan.revision, scopeKey])

  useEffect(() => setPlan(options.plan), [options.plan])

  const apply = useCallback(async (result: DurablePlanDecisionResult, context: object, decision?: DurablePlanDecision) => {
    const active = () => lifetime.current === context
    if (!active()) return
    const options = latest.current
    setPlan(result.plan)
    options.onUpdated?.(result.plan)
    if (!active()) return
    setEffectPending(result.effectPending === true)
    const receipt = result.followUp
    if (!receipt) {
      // A pending effect is settled authority state; Continue explicitly decides again.
      restoration.current.restored = planDecisionKey(result.plan)
      return
    }
    if (!options.attachFollowUp) return
    const currentAttachments = attachments.current
    let pending = currentAttachments.get(receipt.receiptId)
    if (!pending) {
      pending = Promise.resolve().then(() => {
        if (active()) return options.attachFollowUp!(receipt, result.plan,
          decision ?? (result.plan.status === 'rejected' ? 'rejected' : 'approved'))
      })
      currentAttachments.set(receipt.receiptId, pending)
      const release = () => { currentAttachments.delete(receipt.receiptId) }
      void pending.then(release, release)
    }
    try {
      await pending
      if (!active()) return
      restoration.current.restored = planDecisionKey(result.plan)
      setAttachError(null)
    } catch (cause) {
      if (!active()) return
      // The decision is durable; automatic restoration owns the bounded attach retry.
      if (!options.autoRestore) throw cause
      const key = planDecisionKey(result.plan)
      if (restoration.current.restored === key) restoration.current.restored = null
      if (decision !== undefined) {
        restoration.current.attempts.set(key, 0)
        setAttachError(null)
        advanceRestore()
      }
    }
  }, [advanceRestore])

  const decide = useCallback(async (decision: DurablePlanDecision, feedback?: string) => {
    const context = lifetime.current
    if (!context || decisionInFlight.current) return null
    decisionInFlight.current = true
    setDeciding(decision)
    setError(null)
    try {
      const result = await latest.current.client.decide({
        planId: plan.planId,
        revision: plan.revision,
        decision,
        ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
      })
      if (lifetime.current !== context) return null
      await apply(result, context, decision)
      return lifetime.current === context ? result : null
    } catch (cause) {
      if (lifetime.current !== context) return null
      if (cause instanceof DurablePlanClientError && cause.currentPlan) {
        setPlan(cause.currentPlan)
        latest.current.onUpdated?.(cause.currentPlan)
      }
      setError(cause instanceof Error ? cause.message : 'Could not decide the plan.')
      return null
    } finally {
      if (lifetime.current === context) {
        decisionInFlight.current = false
        setDeciding(null)
      }
    }
  }, [apply, plan.planId, plan.revision, scopeKey])

  const restore = useCallback(async () => {
    const context = lifetime.current
    if (!context) return null
    setRestoring(true)
    setError(null)
    try {
      const result = await latest.current.client.current({ planId: plan.planId, revision: plan.revision })
      if (lifetime.current !== context) return null
      await apply(result, context)
      return lifetime.current === context ? result : null
    } catch (cause) {
      if (lifetime.current !== context) return null
      setError(cause instanceof Error ? cause.message : 'Could not restore the plan.')
      return null
    } finally {
      if (lifetime.current === context) setRestoring(false)
    }
  }, [apply, plan.planId, plan.revision, scopeKey])

  const retryAttach = useCallback(() => {
    restoration.current.attempts.set(planDecisionKey(plan), 0)
    setAttachError(null)
    advanceRestore()
  }, [plan.planId, plan.revision, plan.status, advanceRestore])
  useAutomaticPlanRestore({ plan, enabled: options.autoRestore === true && !!options.attachFollowUp && deciding === null &&
    plan.planId === options.plan.planId && plan.revision === options.plan.revision,
    restore, state: restoration, retry: restoreRetry, advance: advanceRestore, failed: setAttachError })

  return { plan, deciding, restoring, error, decide, restore, clearError: () => setError(null),
    effectPending, attachError, retryAttach }
}
