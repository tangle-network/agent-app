import { Sandbox } from '@tangle-network/sandbox/core'
import { type Outcome, ok, fail } from './outcome'
import type { SandboxInstance } from '@tangle-network/sandbox'
import { forgetBox, getClientFromCreds } from './runtime-cache'
import type { SandboxRuntimeConfig, SandboxScope } from './configuration'

export async function listRunning(
  client: Sandbox,
  name: string,
): Promise<Outcome<SandboxInstance | null>> {
  try {
    const running = await client.list({ status: 'running' })
    return ok(running.find((s) => s.name === name) ?? null)
  } catch (err) {
    return fail(err)
  }
}

/**
 * The running box this isolate last used under `name`, read by id. Null when it
 * is gone, stopped, renamed, or answers without the metadata a reuse decides on;
 * the caller then lists, which is the authority.
 */
export async function getRunningBox(
  client: Sandbox,
  id: string,
  name: string,
): Promise<SandboxInstance | null> {
  try {
    const box = await client.get(id)
    if (!box || box.name !== name || box.status !== 'running') return null
    if (typeof box.metadata?.harness !== 'string') return null
    return box
  } catch {
    return null
  }
}

export async function listStopped(
  client: Sandbox,
  name: string,
): Promise<Outcome<SandboxInstance | null>> {
  try {
    const stopped = await client.list({ status: 'stopped' })
    return ok(stopped.find((s) => s.name === name) ?? null)
  } catch (err) {
    return fail(err)
  }
}

export async function deleteBox(box: SandboxInstance): Promise<Outcome<void>> {
  try {
    const acknowledgement = await box.delete({ until: 'removed' })
    forgetBox(box.id)
    // Creation reuses this box's name as its idempotency key.
    if (acknowledgement.removal === 'pending') {
      return fail(new Error(`sandbox ${box.id} removal is still pending; retry replacement after removal completes`))
    }
    return ok(undefined)
  } catch (err) {
    return fail(err)
  }
}

/** Scope + the client and box key every workspace-scoped sandbox call needs.
 *  One place resolves credentials and derives the box name, so the ensure and
 *  peek paths cannot drift on which key a workspace's box lives under. */
export async function resolveWorkspaceSandboxClient(
  shell: SandboxRuntimeConfig,
  workspaceId: string,
  userId: string | undefined,
): Promise<{ scope: SandboxScope; client: Sandbox; name: string }> {
  const scope: SandboxScope = { workspaceId, ...(userId ? { userId } : {}) }
  const creds = await shell.credentials(scope)
  if (!creds) throw new Error('sandbox credentials are required (apiKey/baseUrl)')
  return {
    scope,
    client: getClientFromCreds(creds),
    name: shell.boxKey ? shell.boxKey(scope) : shell.name(workspaceId),
  }
}

/** What a peek can find. `warming` means the control plane is running while
 *  the filesystem incarnation is still transitioning. `not-running` carries
 *  the platform's own state string (`stopped`, `starting`, `failed`, …) —
 *  narrowing it to a union here would drop states the platform adds later,
 *  and every caller wants it for a log. */
export type PeekWorkspaceSandboxOutcome =
  | { status: 'running'; box: SandboxInstance }
  | { status: 'warming'; readiness: 'transitioning'; box: SandboxInstance }
  | { status: 'not-running'; state: string; box: SandboxInstance }
  | { status: 'absent' }

/**
 * Read-only twin of {@link ensureWorkspaceSandbox}: report whether a
 * workspace's box exists and is fully ready, WITHOUT provisioning, resuming,
 * or bootstrapping anything.
 *
 * This is what a read-mostly path needs — a file-index route's `authorize`
 * seam, a stale-lock reconciliation, a status badge. Calling `ensure` from one
 * of those spins a box up as a side effect of a read (legal-agent #509), and
 * costs the caller a cold start it never asked for.
 *
 * Matching is on BOTH the box key and the display name, IN THAT ORDER.
 * `client.get(id)` is a direct read by the platform's opaque sandbox id, not by
 * the deterministic key a product derives from a workspace, so a lookup that
 * has not seen the box before has to list and match (`ensureWorkspaceSandbox`
 * reads a box it has seen by id).
 * Provisioning here always stamps `name` with the box key, so the key is the
 * authoritative match; the display-name pass exists only to adopt boxes on a
 * host that predates that convention. The order matters: a single unordered
 * `find` returns whichever the platform happens to list first, so a stopped
 * display-name box could shadow a running box-key one and report
 * `not-running` for a live workspace.
 *
 * Unlike `ensure`, this lists ALL statuses in one call: distinguishing "no box"
 * from "box is stopped" is the whole point, and a status-filtered list cannot.
 *
 * A `client.list()` rejection propagates RAW, unlike the `Outcome`-wrapping
 * helpers `ensure` uses internally. That is deliberate: there is no honest
 * outcome to map a listing failure onto — it is not `absent` and not
 * `not-running`, and inventing one would have callers act on a status the
 * platform never reported. Callers that must tolerate it say so explicitly
 * (the stale-turn-lock policy documents "a throw is treated as unreachable").
 */
export async function peekWorkspaceSandbox(
  shell: SandboxRuntimeConfig,
  options: { workspaceId: string; userId?: string },
): Promise<PeekWorkspaceSandboxOutcome> {
  const { client, name } = await resolveWorkspaceSandboxClient(shell, options.workspaceId, options.userId)
  const displayName = shell.name(options.workspaceId)
  const boxes = await client.list()
  const match = boxes.find((box) => box.name === name) ?? boxes.find((box) => box.name === displayName)
  if (!match) return { status: 'absent' }
  if (match.status !== 'running') return { status: 'not-running', state: match.status, box: match }
  if (match.filesystemIncarnationReadiness === 'transitioning') {
    return { status: 'warming', readiness: 'transitioning', box: match }
  }
  if (match.filesystemIncarnationReadiness !== 'ready') {
    throw new Error(`sandbox ${match.id} is running without filesystem incarnation readiness`)
  }
  return { status: 'running', box: match }
}
