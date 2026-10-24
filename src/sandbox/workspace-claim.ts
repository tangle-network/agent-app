import {
  type SandboxRuntimeConfig,
  type EnsureWorkspaceSandboxOptions,
  DEFAULT_SANDBOX_RESOURCES,
} from './configuration'
import type { SandboxInstance } from '@tangle-network/sandbox'
import { hydrateReuseState, hasRecentProbe, trustedBoxes, persistReuseState } from './runtime-cache'
import { provisionWorkspaceSandbox } from './workspace-provision'
import { SandboxRecoveryFailedError } from './lifecycle-errors'
import {
  serializeSandboxProvisioningError,
  isSandboxHostCapacityFailure,
  isSandboxBoxConfigFailure,
} from './diagnostics'

/** Reuse a workspace sandbox, or remove its previous runtime before provisioning a replacement. */
export async function ensureWorkspaceSandbox(
  shell: SandboxRuntimeConfig,
  options: EnsureWorkspaceSandboxOptions,
): Promise<SandboxInstance> {
  const box = await claimWorkspaceSandbox(shell, options, false)
  if (!box) throw new Error('ensureWorkspaceSandbox: a claim that may provision returned no box')
  return box
}

/**
 * Reuse the workspace's running box if this isolate used it recently, or return
 * undefined. It never creates, resumes, restarts, replaces or deletes a box, so
 * a caller can run it without the provisioning lease that serializes those
 * steps (see `runForegroundSandboxSingleFlight`'s `reuse`); undefined means the
 * box needs one of them (or this isolate has no recent probe of it), and the
 * caller takes the lease and calls {@link ensureWorkspaceSandbox}.
 */
export async function reuseWorkspaceSandbox(
  shell: SandboxRuntimeConfig,
  options: EnsureWorkspaceSandboxOptions,
): Promise<SandboxInstance | undefined> {
  options.signal?.throwIfAborted()
  if (options.forceNew) return undefined
  await hydrateReuseState(shell, options)
  options.signal?.throwIfAborted()
  if (!hasRecentProbe(shell, options)) return undefined
  return claimWorkspaceSandbox(shell, options, true)
}

/** The spend gate, run at most once per ensure and timed under the turn's trace when it has one. */
function spendGate(options: EnsureWorkspaceSandboxOptions): () => Promise<void> {
  let gated: Promise<void> | undefined
  return () => {
    const before = options.spend?.beforeProvision
    if (!before) return Promise.resolve()
    const run = () => before({
      workspaceId: options.workspaceId,
      ...(options.userId ? { userId: options.userId } : {}),
    })
    return gated ??= Promise.resolve(options.trace
      ? options.trace.measure('sandbox.spend.before_provision', 'sandbox', run, undefined, options.traceParent)
      : run())
  }
}

async function claimWorkspaceSandbox(
  shell: SandboxRuntimeConfig,
  options: EnsureWorkspaceSandboxOptions,
  reuseOnly: boolean,
): Promise<SandboxInstance | undefined> {
  options.signal?.throwIfAborted()
  const { trace } = options
  // A budget refusal must land before any box is created, resumed or kept alive,
  // so it runs ahead of the first attempt and the unbringable-box replacement
  // below. A box this isolate probed recently has passed the gate in that
  // ensure; it is asked again when that probe expires, and before any lifecycle
  // step, so a reuse pays for it once per probe and not once per turn.
  const gate = spendGate(options)
  await hydrateReuseState(shell, options)
  options.signal?.throwIfAborted()
  if (!hasRecentProbe(shell, options)) await gate()
  const claim = trace?.start('sandbox.claim', 'sandbox', { 'workspace.harness': options.harness }, options.traceParent)
  // Each ensure step is a child of the claim, and the caller's own `measure` still sees it.
  const traced: EnsureWorkspaceSandboxOptions = trace && claim
    ? {
      ...options,
      measure: <T,>(stage: string, operation: () => Promise<T>): Promise<T> => {
        const run = () => trace.measure(stage, 'sandbox', () => operation(), undefined, claim)
        return options.measure ? options.measure(stage, run) : run()
      },
    }
    : options
  try {
    const box = await bringUpWorkspaceSandbox(shell, traced, gate, reuseOnly)
    options.signal?.throwIfAborted()
    if (!box) {
      claim?.end({ 'sandbox.reuse_declined': true })
      return undefined
    }
    claim?.end({ 'sandbox.id': box.id, ...(trustedBoxes.has(box) ? { 'sandbox.probe_trusted': true } : {}) })
    // A box handed out on a recent probe was observed by the ensure that probed it.
    if (!trustedBoxes.has(box)) await observeProvisionedBox(shell, options, box)
    await persistReuseState(shell, box)
    return box
  } catch (error) {
    claim?.end(undefined, error)
    throw error
  }
}

/**
 * Report a now-billable box to the spend seam.
 *
 * Awaited rather than fired and forgotten: an expectation ledger with holes
 * reports boxes it simply failed to record as `unknown-box`, and an alert that
 * cries wolf is worse than no alert. The cost is one local write on a path that
 * already makes at least one platform round trip, so it is not the term that
 * decides provisioning latency.
 *
 * Errors are swallowed — the box is up, and failing the caller because
 * bookkeeping failed would trade a real capability for a record of it.
 */
async function observeProvisionedBox(
  shell: SandboxRuntimeConfig,
  options: EnsureWorkspaceSandboxOptions,
  box: SandboxInstance,
): Promise<void> {
  const onProvisioned = options.spend?.onProvisioned
  if (!onProvisioned) return
  const resources = shell.resources ?? DEFAULT_SANDBOX_RESOURCES
  const observe = async (): Promise<void> => {
    await onProvisioned({
      workspaceId: options.workspaceId,
      ...(options.userId ? { userId: options.userId } : {}),
      sandboxId: box.id,
      boxKey: box.name,
      idleTimeoutSeconds: resources.idleTimeoutSeconds,
      maxLifetimeSeconds: resources.maxLifetimeSeconds,
      at: Date.now(),
    })
  }
  try {
    await (options.trace
      ? options.trace.measure('sandbox.spend.observe', 'sandbox', observe, undefined, options.traceParent)
      : observe())
  } catch {
    // An observability seam must never take down the provision it reports on.
  }
}

async function bringUpWorkspaceSandbox(
  shell: SandboxRuntimeConfig,
  options: EnsureWorkspaceSandboxOptions,
  gate: () => Promise<void>,
  reuseOnly: boolean,
): Promise<SandboxInstance | undefined> {
  try {
    return await provisionWorkspaceSandbox(shell, options, gate, reuseOnly)
  } catch (err) {
    options.signal?.throwIfAborted()
    // A box the platform cannot bring up is not a transient failure: the box
    // key is derived from the workspace, so every later call resumes the same
    // dead box and fails the same way. Left alone the workspace never runs
    // again. Replacing it is a delete, so it happens only where the shell has
    // declared the box rebuildable — and only once, so a replacement that dies
    // the same way surfaces the error instead of looping.
    if (!shell.replaceUnbringableBox) throw err
    if (options.forceNew) throw err
    if (!isUnbringableBoxError(err)) throw err
    return await provisionWorkspaceSandbox(shell, { ...options, forceNew: true }, gate, reuseOnly)
  }
}

/**
 * True when the platform cannot bring this box up where it lives.
 *
 * Two shapes reach here. `SandboxRecoveryFailedError` is the substrate's own
 * verdict after it tried a state-preserving restart and failed. A host-capacity
 * rejection is the same verdict one layer earlier: a box is pinned to a host,
 * and a full host rejects every resume for every box on it until something else
 * there goes away. Neither is transient, and neither is fixed by trying again
 * at the same key.
 */
function isUnbringableBoxError(error: unknown): boolean {
  if (error instanceof SandboxRecoveryFailedError) return true
  const diagnostics = serializeSandboxProvisioningError(error)
  return isSandboxHostCapacityFailure(diagnostics) || isSandboxBoxConfigFailure(diagnostics)
}
