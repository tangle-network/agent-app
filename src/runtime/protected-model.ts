import {
  createProtectedAgentCandidateModelPort,
  type AgentCandidateModelGrantClient,
  type AgentCandidateModelPort,
} from '@tangle-network/agent-runtime/candidate-execution'

const GATEWAY_ORIGIN = 'https://candidate-router.tangle.tools'
const CONTROL_ORIGIN = 'https://router.tangle.tools/v1/candidate-model-grants'
const ACTIVATION_NAMES = [
  'MODEL_GATEWAY_TOKEN', 'MODEL_GATEWAY_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
] as const

export interface RouterProtectedModelPortOptions {
  apiKey: string
  maxCostUsd: number
  clientName?: string
  signal?: AbortSignal
  onSettlement?(receipt: RouterProtectedModelSettlement): Promise<void> | void
}

/** A validated charge remains authoritative when the product cannot save its audit record. */
export class ProtectedModelSettlementError extends Error {
  constructor(readonly settlement: Awaited<ReturnType<AgentCandidateModelPort['settleGrant']>>, cause: unknown) {
    super('Protected model settled, but its audit record could not be saved', { cause })
    this.name = 'ProtectedModelSettlementError'
  }
}

/** Bind one turn to Router's atomic grant ledger without exposing its parent key. */
export function createRouterProtectedModelPort(options: RouterProtectedModelPortOptions): AgentCandidateModelPort {
  if (!options.apiKey || !Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0
    || !Number.isSafeInteger(Math.round(options.maxCostUsd * 1_000_000_000))) {
    throw new Error('Protected Router transport requires a parent key and finite positive cap')
  }
  const receipts = new Map<string, RouterProtectedModelSettlement>()
  async function request<T>(operation: string, body: unknown, settling = false): Promise<T> {
    const timeout = AbortSignal.timeout(settling ? 30_000 : 15_000)
    const signal = !settling && options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
    let response: Response
    try {
      response = await fetch(`${CONTROL_ORIGIN}/${operation}`, {
        // Workerd supports manual redirects; non-2xx responses below still fail closed.
        method: 'POST', redirect: 'manual', signal,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json', 'X-Tangle-Client': options.clientName ?? 'agent-app',
        },
        body: JSON.stringify(body),
      })
    } catch {
      if (!settling && options.signal?.aborted) throw options.signal.reason
      throw new Error(`Protected model ${operation} transport failed`)
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: unknown } } | null
      const code = body?.error?.code
      // Preserve Runtime's draining retry contract without echoing server text or credentials.
      const safeCode = typeof code === 'string' && /^candidate_[a-z_]{1,80}$/.test(code) ? code : 'request_failed'
      throw new Error(`Protected model ${operation}: ${safeCode} (HTTP ${response.status})`)
    }
    return await response.json() as T
  }

  const client: AgentCandidateModelGrantClient = {
    reserve: (value) => request('reserve', value),
    activate: async (value) => {
      const activation = await request<Awaited<ReturnType<AgentCandidateModelGrantClient['activate']>>>('activate', value)
      const env = activation?.env
      const token = env?.MODEL_GATEWAY_TOKEN
      if (typeof token !== 'string' || !/^sk-tgr-[A-Za-z0-9_-]{32,}$/.test(token)
        || env.MODEL_GATEWAY_BASE_URL !== `${GATEWAY_ORIGIN}/v1`
        || env.OPENAI_BASE_URL !== `${GATEWAY_ORIGIN}/v1`
        || env.ANTHROPIC_BASE_URL !== GATEWAY_ORIGIN
        || [env.OPENAI_API_KEY, env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN].some((value) => value !== token)) {
        throw new Error('Protected model activation changed the gateway or credential binding')
      }
      return activation
    },
    settle: async (value) => {
      const settlement = await request<RouterProtectedModelSettlement>('settle', value, true)
      assertWithinCap(settlement, options.maxCostUsd)
      receipts.set(value.preparationId, settlement)
      return settlement
    },
  }
  const port = createProtectedAgentCandidateModelPort({
    client, resolveModel: (value) => request('resolve', value),
    gatewayDomain: 'candidate-router.tangle.tools', activationEnvNames: ACTIVATION_NAMES,
  })
  return {
    ...port,
    settleGrant: async (value) => {
      const settlement = await port.settleGrant(value)
      const receipt = receipts.get(value.preparationId)
      if (receipt) {
        try {
          await options.onSettlement?.(structuredClone(receipt))
        } catch (error) {
          throw new ProtectedModelSettlementError(settlement, error)
        } finally {
          receipts.delete(value.preparationId)
        }
      }
      return settlement
    },
  }
}

/**
 * Router's settle response is Runtime's exact settlement ledger. Router keeps
 * the billing hold and charge behind it and refuses a settlement outside the
 * grant's frozen limits; Runtime rejects unknown or missing ledger fields.
 */
export type RouterProtectedModelSettlement = Awaited<ReturnType<AgentCandidateModelGrantClient['settle']>>

/** Bound the ledger's cumulative cost by this turn's cap before anything retains it. */
function assertWithinCap(settlement: RouterProtectedModelSettlement, capUsd: number): void {
  if (!Array.isArray(settlement?.calls)) throw new Error('Protected model settlement has no call ledger')
  const capNanos = Math.round(capUsd * 1_000_000_000)
  let cost = 0
  for (const call of settlement.calls) {
    if (!Number.isSafeInteger(call?.costUsdNanos) || call.costUsdNanos < 0) {
      throw new Error('Protected model call cost is invalid')
    }
    cost += call.costUsdNanos
    if (!Number.isSafeInteger(cost) || cost > capNanos) {
      throw new Error('Protected model settlement exceeds its cost cap')
    }
  }
}
