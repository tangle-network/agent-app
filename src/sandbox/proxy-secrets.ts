import {
  ProxySecretReceiptSchema,
  ProxySecretCapabilitiesSchema,
  ProxySecretsSchema,
  isProxySecretScopeAttenuation,
  proxySecretPresentationsEqual,
} from '@tangle-network/agent-interface'
import type {
  AgentProfile,
  ProxySecretBinding,
  ProxySecretCapabilities,
  ProxySecretReceipt,
} from '@tangle-network/agent-interface'
import type { Sandbox } from '@tangle-network/sandbox/core'
import type { SandboxInstance } from '@tangle-network/sandbox'
import type { SandboxScope } from './index'

export class SandboxProxySecretsError extends Error {
  constructor(message: string) {
    // Issuer/transport errors can contain credential bytes; expose only owned diagnostics.
    super(`sandbox proxy secrets: ${message}`)
    this.name = 'SandboxProxySecretsError'
  }
}

/** Resolves references only. Credentials remain in the platform's encrypted store. */
export type SandboxProxySecretsResolver = (
  scope: SandboxScope,
  context: { client?: Sandbox; box?: SandboxInstance },
) => Promise<ProxySecretBinding[]>

// Same-box evidence from the callback's confirmed complete placement. This is
// not caller-supplied metadata and never authorizes a broader selection.
const confirmedCallbackSelections = new WeakMap<SandboxInstance, {
  owner: SandboxProxySecretsResolver
  bindings: ProxySecretBinding[]
  receipt: ProxySecretReceipt
}>()

export interface SandboxTurnProxySecrets {
  scope: SandboxScope & { userId: string; threadId: string; executionId: string }
  resolve: (
    context: SandboxTurnProxySecrets['scope'] & { box: SandboxInstance },
  ) => Promise<ProxySecretBinding[]>
}

export async function resolveProxySecrets(
  resolve: SandboxProxySecretsResolver | undefined,
  scope: SandboxScope,
  context: { client?: Sandbox; box?: SandboxInstance },
): Promise<ProxySecretBinding[] | undefined> {
  if (!resolve) return undefined
  try {
    const bindings = await resolve(scope, context)
    return ProxySecretsSchema.parse(bindings)
  } catch {
    throw new SandboxProxySecretsError('reference issuance failed')
  }
}

export function assertNoReadableProxySecrets(
  bindings: readonly Pick<ProxySecretBinding, 'envName' | 'secretRef'>[] | undefined,
  env: Record<string, unknown>,
  secrets: readonly string[] = [],
): void {
  if (!bindings?.length) return
  const names = new Set(bindings.flatMap((binding) => [binding.envName, binding.secretRef.key]))
  if (Object.keys(env).some((name) => names.has(name)) || secrets.some((name) => names.has(name) || name === '*')) {
    throw new SandboxProxySecretsError('protected credentials cannot enter readable env, runtime secrets, or secret selection')
  }
}

export async function assertProxySecretCapabilities(
  client: Sandbox,
  bindings: readonly ProxySecretBinding[] | undefined,
  cached?: ProxySecretCapabilities,
): Promise<ProxySecretCapabilities | undefined> {
  if (bindings === undefined) return undefined
  try {
    const capability = cached ?? ProxySecretCapabilitiesSchema.parse(
      (await client.capabilities())?.proxySecrets,
    )
    if (bindings.some((binding) => !capability.presentations.includes(binding.presentation.type)
      || !capability.placeholderFormats.includes(binding.placeholderFormat ?? 'opaque'))) {
      throw new Error('peer does not advertise the required proxy custody capability')
    }
    return capability
  } catch {
    throw new SandboxProxySecretsError('required proxy custody is unsupported')
  }
}

/** Config callback owns the complete set; authored profiles may only request entries in it. */
export function mergeProxySecrets(
  authored: readonly ProxySecretBinding[] | undefined,
  configured?: readonly ProxySecretBinding[],
): ProxySecretBinding[] | undefined {
  if (authored === undefined && configured === undefined) return undefined
  try {
    const requested = ProxySecretsSchema.parse(authored ?? [])
    if (configured === undefined) return authored === undefined ? undefined : requested
    const selected = ProxySecretsSchema.parse(configured)
    for (const binding of requested) {
      if (!selected.some((entry) => JSON.stringify(entry) === JSON.stringify(binding))) {
        throw new SandboxProxySecretsError('authored proxy secret is outside the configured complete selection')
      }
    }
    return selected
  } catch (cause) {
    if (cause instanceof SandboxProxySecretsError) throw cause
    throw new SandboxProxySecretsError('invalid proxy secret selection')
  }
}

function confirmedReceipt(
  value: unknown,
  box: SandboxInstance,
  bindings: readonly ProxySecretBinding[],
  previousGeneration?: number,
  completeSet = true,
): ProxySecretReceipt {
  const parsed = ProxySecretReceiptSchema.safeParse(value)
  if (!parsed.success) throw new SandboxProxySecretsError('peer returned no canonical placement receipt')
  const receipt = parsed.data
  if (receipt.sandboxId !== box.id
    || (previousGeneration !== undefined && receipt.generation <= previousGeneration)
    || receipt.status !== ((completeSet ? bindings.length : receipt.bindings.length) ? 'installed' : 'revoked')
    || (completeSet && receipt.bindings.length !== bindings.length)
    || receipt.bindings.some(({ grant }) => Date.parse(grant.issuedAt) > Date.now() || Date.parse(grant.expiresAt) <= Date.now())) {
    throw new SandboxProxySecretsError('proxy and materialization placement was not confirmed')
  }
  for (const binding of bindings) {
    const placed = receipt.bindings.find((entry) => entry.envName === binding.envName)
    const grant = placed?.grant
    if (!grant || placed?.secretRef.key !== binding.secretRef.key || grant.sandboxId !== box.id
      || (binding.ttlSeconds !== undefined
        && Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt) > binding.ttlSeconds * 1_000)
      || !proxySecretPresentationsEqual(binding.presentation, grant.presentation)
      || grant.placeholderFormat !== (binding.placeholderFormat ?? 'opaque')
      || !isProxySecretScopeAttenuation(binding, grant.scope)) {
      throw new SandboxProxySecretsError('effective grant does not confirm the requested sandbox and confinement')
    }
  }
  return receipt
}

/** A successful update is insufficient without the canonical placement receipt. */
export async function reconcileProxySecrets(
  box: SandboxInstance,
  bindings: ProxySecretBinding[] | undefined,
): Promise<void> {
  if (bindings === undefined) return
  try {
    const egress = box.egress
    const current = await egress.get()
    const previous = ProxySecretReceiptSchema.safeParse(current.proxySecretReceipt)
    if (!previous.success || previous.data.sandboxId !== box.id) {
      throw new SandboxProxySecretsError('peer did not report the current proxy secret generation')
    }
    const generation = previous.data.generation
    const applied = await egress.update({
      proxySecrets: bindings,
      expectedProxySecretGeneration: generation,
      requireInPlace: true,
    })
    const appliedReceipt = confirmedReceipt(applied.proxySecretReceipt, box, bindings, generation)
    const confirmed = await egress.get()
    const receipt = confirmedReceipt(confirmed.proxySecretReceipt, box, bindings)
    if (JSON.stringify(receipt) !== JSON.stringify(appliedReceipt)) {
      throw new SandboxProxySecretsError('proxy placement changed before dispatch')
    }
  } catch (cause) {
    if (cause instanceof SandboxProxySecretsError) throw cause
    throw new SandboxProxySecretsError('atomic renewal failed; dispatch refused')
  }
}

export async function verifyProxySecrets(
  box: SandboxInstance,
  bindings: ProxySecretBinding[] | undefined,
  owner?: SandboxProxySecretsResolver,
): Promise<void> {
  if (bindings === undefined) return
  confirmedCallbackSelections.delete(box)
  try {
    const current = await box.egress.get()
    const receipt = confirmedReceipt(current.proxySecretReceipt, box, bindings)
    if (owner) confirmedCallbackSelections.set(box, {
      owner, bindings: ProxySecretsSchema.parse(bindings), receipt,
    })
  } catch (cause) {
    if (cause instanceof SandboxProxySecretsError) throw cause
    throw new SandboxProxySecretsError('placement could not be verified after runtime refresh')
  }
}

/** Dispatch verifies authored declarations as a subset; it never replaces the owner's complete set. */
export async function verifyProfileProxySecrets(
  box: SandboxInstance,
  requested: ProxySecretBinding[] | undefined,
  runtimeSecrets: Record<string, string> | undefined,
  owner: SandboxProxySecretsResolver | undefined,
): Promise<void> {
  const requireReceipt = owner !== undefined
  if (requested === undefined && Object.keys(runtimeSecrets ?? {}).length === 0 && !requireReceipt) return
  const egress = box.egress
  if (!egress?.get && !requireReceipt && requested === undefined) return
  try {
    const current = await egress.get()
    if (current.proxySecretReceipt === undefined && !requireReceipt && requested === undefined) return
    if (owner) {
      const selected = confirmedCallbackSelections.get(box)
      if (selected?.owner !== owner) {
        throw new SandboxProxySecretsError('dispatch requires the callback’s confirmed complete selection')
      }
      const complete = confirmedReceipt(current.proxySecretReceipt, box, selected.bindings)
      if (JSON.stringify(complete) !== JSON.stringify(selected.receipt)) {
        throw new SandboxProxySecretsError('callback placement changed before dispatch')
      }
    }
    const receipt = confirmedReceipt(current.proxySecretReceipt, box, requested ?? [], undefined, false)
    if (!owner && requested?.length === 0 && receipt.bindings.length > 0) {
      throw new SandboxProxySecretsError('an empty authored selection requires confirmed callback ownership or revocation')
    }
    assertNoReadableProxySecrets(receipt.bindings, runtimeSecrets ?? {})
  } catch (cause) {
    if (cause instanceof SandboxProxySecretsError) throw cause
    throw new SandboxProxySecretsError('authored profile custody is not installed on the dispatch sandbox')
  }
}

export function assertNoNestedProxySecrets(profile: AgentProfile): void {
  for (const child of Object.values(profile.subagents ?? {})) {
    if ('proxySecrets' in child || 'subagents' in child) {
      throw new SandboxProxySecretsError('subagent proxy secrets require separately authorized sandbox placement')
    }
  }
}
