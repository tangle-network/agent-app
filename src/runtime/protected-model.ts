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
        method: 'POST', redirect: 'error', signal,
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
      const wire = await request<RouterProtectedModelSettlement>('settle', value, true)
      const projected = runtimeSettlement(wire, options.maxCostUsd)
      receipts.set(value.preparationId, wire)
      return projected
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

export interface RouterProtectedModelSettlement extends Omit<Awaited<ReturnType<AgentCandidateModelGrantClient['settle']>>, 'calls'> {
  billing: {
    status: string
    authorizationId?: string
    transactionId?: string
    reservedCostUsdNanos: number
    settledCostUsdNanos: number
  }
  calls: Array<Omit<Awaited<ReturnType<AgentCandidateModelGrantClient['settle']>>['calls'][number], 'costProvenance'> & {
    cacheWriteTokens: number
    cacheWrite5mTokens: number
    cacheWrite1hTokens: number
  }>
}

/** Check Router's billing extension before projecting its portable Runtime ledger. */
function runtimeSettlement(wire: RouterProtectedModelSettlement, capUsd: number): Awaited<ReturnType<AgentCandidateModelGrantClient['settle']>> {
  const billing = wire?.billing
  if (!Array.isArray(wire?.calls) || !billing || billing.status !== 'settled'
    || typeof billing.authorizationId !== 'string' || billing.authorizationId.length === 0
    || billing.reservedCostUsdNanos !== Math.round(capUsd * 1_000_000_000)
    || !Number.isSafeInteger(billing.settledCostUsdNanos) || billing.settledCostUsdNanos < 0
    || billing.settledCostUsdNanos > billing.reservedCostUsdNanos
    || (billing.settledCostUsdNanos > 0 && (typeof billing.transactionId !== 'string' || billing.transactionId.length === 0))) {
    throw new Error('Protected model billing receipt is incomplete or exceeds its reservation')
  }
  const billingFields = new Set(['status', 'authorizationId', 'transactionId', 'reservedCostUsdNanos', 'settledCostUsdNanos'])
  if (Object.keys(billing).some((key) => !billingFields.has(key))) {
    throw new Error('Protected model billing receipt contains an unknown field')
  }
  let cost = 0
  const calls = wire.calls.map(({ cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens, ...call }) => {
    for (const count of [cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens]) {
      if (!Number.isSafeInteger(count) || count < 0 || count > call.accountedInputTokens) {
        throw new Error('Protected model cache-write receipt is invalid')
      }
    }
    if (cacheWrite5mTokens + cacheWrite1hTokens > cacheWriteTokens) {
      throw new Error('Protected model cache-write receipt does not reconcile')
    }
    if (!Number.isSafeInteger(call.costUsdNanos) || call.costUsdNanos < 0) {
      throw new Error('Protected model call cost is invalid')
    }
    cost += call.costUsdNanos
    if (!Number.isSafeInteger(cost)) throw new Error('Protected model cumulative cost is invalid')
    if ('costProvenance' in call) throw new Error('Router call receipt contains an unknown field')
    return { ...call, costProvenance: 'observed' as const }
  })
  if (cost !== billing.settledCostUsdNanos) throw new Error('Protected model billing does not match its call ledger')
  const { billing: _billing, ...settlement } = wire
  return { ...settlement, calls }
}
