/**
 * The models a workspace box may call. Platform mints every box's Router key
 * (`auto:sandbox:router:<box>`) under the payer's sandbox policy, and the
 * Sandbox API sends that key with every run in place of any per-turn key. A
 * paying customer's policy names no models; a company account's (operator,
 * smoke, acceptance, staff) names only the flat-plan models and the Router's
 * synthetic model, so a box asked for any other model is refused before it
 * produces a token. `GET /v1/keys/sandbox-router-models` reports that policy
 * for the calling key without returning key material.
 */

export type SandboxModelPolicy =
  | { ok: true; allowedModels: string[] | null }
  | { ok: false; error: string }

const POLICY_TTL_MS = 10 * 60_000
const cache = new Map<string, { policy: { ok: true; allowedModels: string[] | null }; at: number }>()

async function keyDigest(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey))
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Platform's model policy for a box minted under the payer of `apiKey`, cached
 * per key for ten minutes. A missing Platform URL, a failed request or an
 * invalid answer is a refusal, never an open policy.
 */
export async function readSandboxModelPolicy(
  apiKey: string,
  options: { platformUrl: string | undefined; signal?: AbortSignal },
): Promise<SandboxModelPolicy> {
  const id = await keyDigest(apiKey)
  const cached = cache.get(id)
  if (cached && Date.now() - cached.at < POLICY_TTL_MS) return cached.policy
  const raw = options.platformUrl?.trim()
  if (!raw) return { ok: false, error: 'TANGLE_PLATFORM_URL is required to read the sandbox model policy' }
  let response: Response
  try {
    response = await fetch(`${new URL(raw).origin}/v1/keys/sandbox-router-models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: options.signal ?? AbortSignal.timeout(5_000),
    })
  } catch (error) {
    return { ok: false, error: `sandbox model policy request failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { ok: false, error: `sandbox model policy returned HTTP ${response.status}` }
  const body = await response.json().catch(() => null) as { success?: unknown; data?: { allowedModels?: unknown } } | null
  const allowed = body?.success === true && body.data && 'allowedModels' in body.data ? body.data.allowedModels : undefined
  if (allowed !== null && !(Array.isArray(allowed) && allowed.every((model) => typeof model === 'string' && model.trim()))) {
    return { ok: false, error: 'sandbox model policy returned an invalid response' }
  }
  const policy = { ok: true as const, allowedModels: allowed === null ? null : [...new Set(allowed as string[])] }
  cache.set(id, { policy, at: Date.now() })
  return policy
}

/**
 * The first preferred model the policy allows, else the policy's own first
 * model. A policy that names none allows the first preference.
 */
export function sandboxModelWithinPolicy(preferred: readonly string[], allowedModels: readonly string[] | null): string | undefined {
  if (allowedModels === null) return preferred[0]
  return preferred.find((model) => allowedModels.includes(model)) ?? allowedModels[0]
}
