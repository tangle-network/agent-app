/**
 * The models a workspace box may call. Platform mints every box's Router key
 * (`auto:sandbox:router:<box>`) under the payer's sandbox policy, and the
 * Sandbox API sends that key with every run in place of any per-turn key. A
 * paying customer's policy names no models (`null`); a company account's
 * (operator, smoke, acceptance, staff) names only its flat-plan models, so a
 * box asked for any other model is refused before it writes a token.
 * `GET /v1/keys/sandbox-router-models` reports that policy for the calling key
 * without returning key material.
 *
 * Creative #739, Legal #546 and GTM each kept a copy of this read; a computer
 * step asked for a model its box key refuses failed every call.
 */
import { fail, ok, type Outcome } from './outcome'

export interface ReadSandboxRouterModelsOptions {
  /** Platform's origin (`TANGLE_PLATFORM_URL`); any path on it is ignored. */
  platformUrl: string
  /** A key of the payer whose sandbox policy applies: the member's linked key, or the owner's sandbox key. */
  apiKey: string
  signal?: AbortSignal
  fetch?: typeof fetch
}

const TTL_MS = 10 * 60_000
const MAX_ENTRIES = 256
// Resolved answers only, never a read in flight: a promise's I/O belongs to the request that started it.
const answers = new Map<string, { allowedModels: string[] | null; at: number }>()

async function keyDigest(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey))
  return Array.from(new Uint8Array(digest).slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Platform's model policy for a box minted under the payer of `apiKey`: the allowed models, or `null` for any. */
export async function readSandboxRouterModels(options: ReadSandboxRouterModelsOptions): Promise<Outcome<string[] | null>> {
  const id = await keyDigest(options.apiKey)
  const cached = answers.get(id)
  if (cached && Date.now() - cached.at < TTL_MS) return ok(cached.allowedModels)
  let origin: string
  try { origin = new URL(options.platformUrl).origin } catch {
    return fail(new Error('The sandbox model policy needs a valid Platform URL'))
  }
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(`${origin}/v1/keys/sandbox-router-models`, {
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: options.signal ?? AbortSignal.timeout(5_000),
    })
  } catch (error) {
    return fail(new Error(`The sandbox model policy request failed: ${error instanceof Error ? error.message : String(error)}`))
  }
  if (!response.ok) return fail(Object.assign(new Error(`The sandbox model policy returned HTTP ${response.status}`), { status: response.status }))
  const body = await response.json().catch(() => null) as { success?: unknown; data?: { allowedModels?: unknown } } | null
  const allowed = body?.success === true && body.data && 'allowedModels' in body.data ? body.data.allowedModels : undefined
  if (allowed !== null && !(Array.isArray(allowed) && allowed.every(model => typeof model === 'string' && model.trim()))) {
    return fail(new Error('The sandbox model policy returned an invalid response'))
  }
  const allowedModels = allowed === null ? null : [...new Set(allowed as string[])]
  if (answers.size >= MAX_ENTRIES) answers.delete(answers.keys().next().value!)
  answers.set(id, { allowedModels, at: Date.now() })
  return ok(allowedModels)
}

/** The first preferred model the policy allows, else the policy's own first model; `null` allows the first preference. */
export function modelWithinAllowList(preferred: readonly string[], allowedModels: readonly string[] | null): string | undefined {
  if (allowedModels === null) return preferred[0]
  return preferred.find(model => allowedModels.includes(model)) ?? allowedModels[0]
}
