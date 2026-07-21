import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatPlan } from '../plans/index'

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

export interface DurablePlanDecisionResult {
  plan: ChatPlan
  followUp?: DurablePlanFollowUpReceipt
  idempotent: boolean
  projectionPending?: boolean
  effectPending?: boolean
}

export interface DurablePlanDecisionInput {
  planId: string
  revision: number
  decision: DurablePlanDecision
  feedback?: string
}

export interface DurablePlanCurrentInput {
  planId: string
  revision?: number
}

export interface DurablePlanDecisionClient {
  current: (input: DurablePlanCurrentInput) => Promise<DurablePlanDecisionResult>
  decide: (input: DurablePlanDecisionInput) => Promise<DurablePlanDecisionResult>
}

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

export interface DurablePlanDecisionClientOptions {
  url: string | ((input: DurablePlanCurrentInput | DurablePlanDecisionInput) => string)
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
    idempotent: body.idempotent === true,
    ...(body.projectionPending === true ? { projectionPending: true } : {}),
    ...(body.effectPending === true ? { effectPending: true } : {}),
  }
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return recordOf(await response.json().catch(() => null)) ?? {}
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
    const body = await responseBody(response)
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

export interface UseDurablePlanFlowOptions {
  plan: ChatPlan
  client: DurablePlanDecisionClient
  /** Must be idempotent by receipt.receiptId. */
  attachFollowUp?: (receipt: DurablePlanFollowUpReceipt) => Promise<void> | void
  onUpdated?: (plan: ChatPlan) => void
}

export interface UseDurablePlanFlowResult {
  plan: ChatPlan
  deciding: DurablePlanDecision | null
  restoring: boolean
  error: string | null
  decide: (decision: DurablePlanDecision, feedback?: string) => Promise<DurablePlanDecisionResult | null>
  restore: () => Promise<DurablePlanDecisionResult | null>
  clearError: () => void
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

  useEffect(() => setPlan(options.plan), [options.plan])

  const apply = useCallback(async (result: DurablePlanDecisionResult) => {
    setPlan(result.plan)
    options.onUpdated?.(result.plan)
    const receipt = result.followUp
    if (!receipt || !options.attachFollowUp) return
    let pending = attachments.current.get(receipt.receiptId)
    if (!pending) {
      pending = Promise.resolve(options.attachFollowUp(receipt))
      attachments.current.set(receipt.receiptId, pending)
      void pending.finally(() => attachments.current.delete(receipt.receiptId))
    }
    await pending
  }, [options.attachFollowUp, options.onUpdated])

  const decide = useCallback(async (decision: DurablePlanDecision, feedback?: string) => {
    if (deciding) return null
    setDeciding(decision)
    setError(null)
    try {
      const result = await options.client.decide({
        planId: plan.planId,
        revision: plan.revision,
        decision,
        ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
      })
      await apply(result)
      return result
    } catch (cause) {
      if (cause instanceof DurablePlanClientError && cause.currentPlan) {
        setPlan(cause.currentPlan)
        options.onUpdated?.(cause.currentPlan)
      }
      setError(cause instanceof Error ? cause.message : 'Could not decide the plan.')
      return null
    } finally {
      setDeciding(null)
    }
  }, [apply, deciding, options.client, options.onUpdated, plan.planId, plan.revision])

  const restore = useCallback(async () => {
    setRestoring(true)
    setError(null)
    try {
      const result = await options.client.current({ planId: plan.planId, revision: plan.revision })
      await apply(result)
      return result
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not restore the plan.')
      return null
    } finally {
      setRestoring(false)
    }
  }, [apply, options.client, plan.planId, plan.revision])

  return { plan, deciding, restoring, error, decide, restore, clearError: () => setError(null) }
}
