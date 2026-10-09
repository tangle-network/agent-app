/**
 * Bill work an agent app runs for a Platform agent key to that key's one cap.
 *
 * An owner approves an agent key with one lifetime cap shared across every
 * product. Work the app runs for the key must spend that cap, even when the
 * owner already has their own credential in the app:
 *
 * - Model calls: `modelKey` delegates a Router key from the agent key that
 *   spends its cap directly ("spend-through"). Router refuses every call once
 *   the cap is spent, so a turn cannot run past it.
 * - Work the app cannot route through the key, such as compute in a sandbox
 *   the owner's own credential pays for: `hold` reserves the work's maximum
 *   against the cap before it starts, and `consume` spends what it measured,
 *   up to the hold, without charging the owner's wallet again.
 *
 * A spent or insufficient cap answers 402 `agent_key.budget_exhausted`, so an
 * app refuses the work before it starts. Web-standard fetch only.
 */

export interface AgentSpendRefusal {
  status: 402 | 403 | 503
  code: string
  message: string
}

export type AgentSpendOutcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: AgentSpendRefusal }

export interface PlatformAgentSpendOptions {
  /** Platform origin, e.g. `https://id.tangle.tools`. */
  platformUrl: string
  /** This app's Platform service name. */
  serviceName: string
  serviceToken: string | (() => string)
  /** The Platform product this app bills, e.g. `gtm-agent`. */
  product: string
  fetch?: typeof fetch
}

export interface PlatformAgentSpend {
  /**
   * A Router key whose charges spend the agent key's cap. `name` must start
   * `auto:`; give each piece of work its own.
   */
  modelKey(input: { agentKey: string; name: string; expiresAt: Date }): Promise<AgentSpendOutcome<{ key: string; keyId: string | null }>>
  /** Reserve up to `amountUsd` of the agent key's cap for work billed elsewhere. */
  hold(input: { keyId: string; amountUsd: number; referenceId: string; expiresAt: Date }): Promise<AgentSpendOutcome<{ authorizationId: string }>>
  /** Spend what the work measured, at most the hold. A retry repeats the amount. */
  consume(input: { authorizationId: string; amountUsd: number }): Promise<AgentSpendOutcome<{ consumedUsd: number }>>
  /** Return a hold whose work never ran. */
  release(authorizationId: string): Promise<AgentSpendOutcome<null>>
}

const REQUEST_TIMEOUT_MS = 10_000

const budgetExhausted: AgentSpendRefusal = {
  status: 402,
  code: 'agent_key.budget_exhausted',
  message: 'The key has spent, or cannot cover, the cap its owner approved.',
}

function refusal(status: number, code: unknown): AgentSpendRefusal {
  if (code === 'KEY_BUDGET_EXHAUSTED' || code === 'KEY_BUDGET_EXCEEDED' || code === 'PRODUCT_BUDGET_EXCEEDED') return budgetExhausted
  if (code === 'INSUFFICIENT_BALANCE') {
    return { status: 402, code: 'agent_key.payment_required', message: "The key owner's Tangle account has no credit." }
  }
  if (code === 'EMAIL_VERIFICATION_REQUIRED') {
    return { status: 403, code: 'agent_key.owner_unverified', message: 'The key owner must verify their Tangle email.' }
  }
  if (status >= 500 || status === 429 || code === 'PLATFORM_BUSY') {
    return { status: 503, code: 'agent_key.spend_unavailable', message: 'Platform could not record the spend; retry.' }
  }
  return { status: 403, code: 'agent_key.spend_refused', message: 'Platform refused to bill this work to the key.' }
}

interface PlatformBody {
  success?: unknown
  data?: { key?: unknown; id?: unknown; consumedAmount?: unknown }
  error?: { code?: unknown }
}

export function createPlatformAgentSpend(options: PlatformAgentSpendOptions): PlatformAgentSpend {
  const fetchImpl = options.fetch ?? fetch
  const base = options.platformUrl.replace(/\/+$/, '')

  async function call(path: string, body: unknown): Promise<{ status: number; body: PlatformBody } | null> {
    const token = typeof options.serviceToken === 'function' ? options.serviceToken() : options.serviceToken
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-service-name': options.serviceName,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      return { status: response.status, body: (await response.json().catch(() => ({}))) as PlatformBody }
    } catch {
      return null
    }
  }

  const unavailable = (): { succeeded: false; error: AgentSpendRefusal } => ({ succeeded: false, error: refusal(503, null) })

  return {
    async modelKey({ agentKey, name, expiresAt }) {
      const result = await call('/v1/keys/delegate', {
        sourceKey: agentKey, name, product: 'router', spendThrough: true, expiresAt: expiresAt.toISOString(),
      })
      if (!result) return unavailable()
      const key = result.body.data?.key
      if (result.status !== 201 || typeof key !== 'string') {
        return { succeeded: false, error: refusal(result.status, result.body.error?.code) }
      }
      const keyId = result.body.data?.id
      return { succeeded: true, value: { key, keyId: typeof keyId === 'string' ? keyId : null } }
    },
    async hold({ keyId, amountUsd, referenceId, expiresAt }) {
      const result = await call('/v1/billing/authorizations', {
        keyId, amount: amountUsd, type: 'key_cap', product: options.product, referenceId, expiresAt: expiresAt.toISOString(),
      })
      if (!result) return unavailable()
      const id = result.body.data?.id
      if (result.status !== 201 || typeof id !== 'string') {
        return { succeeded: false, error: refusal(result.status, result.body.error?.code) }
      }
      return { succeeded: true, value: { authorizationId: id } }
    },
    async consume({ authorizationId, amountUsd }) {
      const result = await call(`/v1/billing/authorizations/${encodeURIComponent(authorizationId)}/consume`, { amount: amountUsd })
      if (!result) return unavailable()
      const consumed = result.body.data?.consumedAmount
      if (result.status !== 200 || typeof consumed !== 'number') {
        return { succeeded: false, error: refusal(result.status, result.body.error?.code) }
      }
      return { succeeded: true, value: { consumedUsd: consumed } }
    },
    async release(authorizationId) {
      const result = await call(`/v1/billing/authorizations/${encodeURIComponent(authorizationId)}/release`, {})
      if (!result) return unavailable()
      if (result.status !== 200) return { succeeded: false, error: refusal(result.status, result.body.error?.code) }
      return { succeeded: true, value: null }
    },
  }
}
