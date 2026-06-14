/**
 * `createCertifiedDelivery` — the delivery truck for Tangle Intelligence.
 *
 * Pulls a tenant's CERTIFIED `AgentProfile` from the deployed plane
 * (`GET /v1/profiles/:target/composed`) and applies it to the agent's resolved
 * surfaces each turn, so an approved improvement reaches the running agent with
 * NO redeploy. This is the `composeProfile` transform `createAgentRuntime`
 * accepts — opt-in per product, fail-closed, cached + refreshed.
 *
 * Profile-WIDE by design (not prompt-only): the composed profile carries every
 * promoted artifact type keyed by kind. What's folded where:
 *   - `prompt-surface` + `skill` → the system prompt (via `composeCertifiedPrompt`).
 *   - `tool` artifacts that carry an OpenAI tool definition → `extraTools`
 *     (advertised to the model; the matching executor is supplied by the product
 *     via `executeOtherTool`). Until a `tool` artifact carries a runnable def,
 *     it is surfaced (see `current()`) but not advertised — advertising a tool
 *     with no executor would make the model call into a dead end.
 *   - `mcp` / `memory` / `rag` artifacts materialize as servers/files and deliver
 *     through the SANDBOX-provisioning seam, not this in-process one. The full
 *     certified profile is exposed via `current()` so that seam can consume it.
 *
 * Substrate boundary: THIS module imports `@tangle-network/agent-runtime`; the
 * `createAgentRuntime` core does not (it only consumes the generic transform).
 */

import {
  composeCertifiedPrompt,
  type CertifiedProfile,
  pullCertified,
} from '@tangle-network/agent-runtime/intelligence'
import type { ResolvedAgentProfile } from './agent'

const defaultRefreshMs = 300_000

export interface CertifiedDeliveryConfig {
  /** The tenant target whose certified artifacts to deliver (the agent id). */
  target: string
  /** Bearer for the plane. Reads `TANGLE_API_KEY` when omitted. */
  apiKey?: string
  /** Plane base URL. Reads `TANGLE_INTELLIGENCE_URL` then the public plane. */
  baseUrl?: string
  /** Min interval between certified-profile pulls. Default 5m. */
  refreshMs?: number
  /** fetch impl (tests / non-global-fetch runtimes). */
  fetchImpl?: typeof fetch
}

export interface CertifiedDelivery {
  /** The `composeProfile` transform to pass to `createAgentRuntime`. Applies the
   *  cached certified profile to the base surfaces; refreshes on the cadence. */
  composeProfile(base: ResolvedAgentProfile): Promise<ResolvedAgentProfile>
  /** Force a pull now (ignores the refresh window). Best-effort. */
  refresh(): Promise<void>
  /** The certified profile currently in effect (null = none promoted / pull
   *  failed). Lets the sandbox-provisioning seam deliver the file/server
   *  artifact types this in-process seam doesn't. */
  current(): CertifiedProfile | null
}

/**
 * Build a certified-delivery transform for one agent target. Fail-closed: a pull
 * error or 404 keeps the last-known certified profile (or null), and the agent
 * runs on its base surfaces — it never breaks because Intelligence is down.
 */
export function createCertifiedDelivery(config: CertifiedDeliveryConfig): CertifiedDelivery {
  const refreshMs = config.refreshMs ?? defaultRefreshMs
  let certified: CertifiedProfile | null = null
  let lastPullAt = 0
  let inflight: Promise<void> | null = null

  async function refresh(force = false): Promise<void> {
    if (!force && Date.now() - lastPullAt < refreshMs) return
    if (inflight) return inflight
    inflight = (async () => {
      const outcome = await pullCertified({
        target: config.target,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        fetchImpl: config.fetchImpl,
      })
      lastPullAt = Date.now()
      // Only replace on a real pull; a 404/error keeps the last-known profile.
      if (outcome.succeeded) certified = outcome.value
    })()
    try {
      await inflight
    } finally {
      inflight = null
    }
  }

  return {
    async composeProfile(base) {
      await refresh()
      return {
        // prompt-surface + skill fold into the system prompt.
        systemPrompt: composeCertifiedPrompt(base.systemPrompt, certified),
        // Certified `tool` artifacts deliver here once they carry a runnable
        // OpenAI def + the product wires the executor; until then pass through.
        extraTools: base.extraTools,
      }
    },
    refresh: () => refresh(true),
    current: () => certified,
  }
}
