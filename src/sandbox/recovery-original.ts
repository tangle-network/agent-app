import type { Sandbox } from '@tangle-network/sandbox'
import { parseJsonObjectBody } from '../web/core'
import {
  WORKSPACE_SANDBOX_MISSING, WORKSPACE_SANDBOX_SNAPSHOT_MAX_AGE_MS,
  type WorkspaceSandboxRecoveryState, type WorkspaceSandboxRecoveryStore, type WorkspaceSandboxSnapshot,
} from './recovery'

export interface WorkspaceSandboxOriginalRecoveryOptions {
  workspaceId: string
  /** The application's authenticated SDK client, with a finite request timeout
   * and the caller's cancellation signal. No admin credentials or lifecycle calls. */
  client: Pick<Sandbox, 'fetch'>
  /** Server-owned namespace policy. Accept historical generations for this
   * workspace, never a key supplied by a browser or a freshly computed epoch. */
  ownsOriginalBoxKey: (identity: { workspaceId: string; sandboxId: string; boxKey: string }) => boolean
  now?: number
}

export type WorkspaceSandboxOriginalRecoveryResult<Snapshot extends WorkspaceSandboxSnapshot = WorkspaceSandboxSnapshot> = {
  status: 'unchanged' | 'recovered' | 'unverified' | 'conflict'
  recovery: WorkspaceSandboxRecoveryState<Snapshot> | undefined
  /** Fixed diagnostic category; never runtime errors, credentials or raw API bodies. */
  reason?: string
}

const MAX_RECOVERY_READ_BYTES = 256 * 1024
const MAX_RECOVERY_READ_RECORDS = 256

type CommittedOriginal = {
  boxKey: string
  suspendedAt: number
  incarnationId: string | undefined
}

async function committedOriginal(
  recovery: WorkspaceSandboxRecoveryState,
  options: WorkspaceSandboxOriginalRecoveryOptions,
  now: number,
): Promise<CommittedOriginal | undefined> {
  // SDK get() discards incomplete incarnation tuples. Validate the same raw
  // observation atomically, so partial/transitioning cannot become legacy absence.
  const response = await options.client.fetch(`/v1/sandboxes/${encodeURIComponent(recovery.sandboxId)}`, { method: 'GET' }, { timeoutMs: 5_000 })
  if (!response.ok) {
    await response.body?.cancel()
    return undefined
  }
  const [box, error] = await parseJsonObjectBody(response, { maxBytes: MAX_RECOVERY_READ_BYTES })
  if (error) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (box.id !== recovery.sandboxId || box.status !== 'stopped'
    || box.lifecycleState !== 'suspended' || typeof box.name !== 'string' || !box.name.trim()) return undefined
  const id = box.filesystemIncarnationId
  const provenance = box.filesystemIncarnationProvenance
  const readiness = box.filesystemIncarnationReadiness
  const absent = id === undefined && provenance === undefined && readiness === undefined
  if (!absent && (typeof id !== 'string' || !id.trim()
    || (provenance !== 'fresh' && provenance !== 'restored' && provenance !== 'unknown') || readiness !== 'ready')) return undefined
  const suspendedAt = typeof box.suspendedAt === 'string' ? Date.parse(box.suspendedAt) : NaN
  if (!Number.isFinite(suspendedAt) || suspendedAt > now) return undefined
  if (!options.ownsOriginalBoxKey({ workspaceId: options.workspaceId, sandboxId: recovery.sandboxId, boxKey: box.name })) return undefined
  return { boxKey: box.name, suspendedAt, incarnationId: typeof id === 'string' ? id : undefined }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A missing local binding is not proof that a prior create did not make a
 * box. The SDK list() drops listingComplete, so preserve that public API
 * envelope through its ordinary authenticated transport. No filters or pages:
 * clear means only absent in this complete observation, never no remote task. */
async function inspectReplacement(
  client: WorkspaceSandboxOriginalRecoveryOptions['client'], boxKey: string,
): Promise<'clear' | 'present' | 'unverified'> {
  const response = await client.fetch('/v1/sandboxes', { method: 'GET' }, { timeoutMs: 5_000 })
  if (!response.ok) {
    await response.body?.cancel()
    return 'unverified'
  }
  const [body, error] = await parseJsonObjectBody(response, { maxBytes: MAX_RECOVERY_READ_BYTES })
  if (error) {
    await response.body?.cancel().catch(() => undefined)
    return 'unverified'
  }
  const entries = body.sandboxes
  if (!Array.isArray(entries) || entries.length > MAX_RECOVERY_READ_RECORDS) return 'unverified'
  const ids = new Set<string>()
  for (const entry of entries) {
    if (!record(entry) || typeof entry.id !== 'string' || !entry.id.trim()
      || typeof entry.name !== 'string' || !entry.name.trim() || ids.has(entry.id)) return 'unverified'
    ids.add(entry.id)
    // A positive physical match is a conflict even if a peer also reports
    // incompleteness. It never licenses switching or overwriting either box.
    if (entry.name === boxKey) return 'present'
  }
  if (body.listingComplete !== true
    || Object.keys(body).some(key => !['sandboxes', 'listingComplete', 'total', 'count'].includes(key))
    || (body.total !== undefined && body.total !== entries.length)
    || (body.count !== undefined && body.count !== entries.length)) return 'unverified'
  return 'clear'
}

type FinalSnapshot = { snapshotId: string; createdAt: number }

/** A positive same-original, remotely synced final-stop witness. The public
 * API's suspended phase means final commit finished; suspendedAt is stamped
 * BEFORE its pre-suspend capture. Tags alone never certify a final snapshot. */
function finalSnapshot(
  body: Record<string, unknown>, recovery: WorkspaceSandboxRecoveryState,
  original: CommittedOriginal, now: number,
): FinalSnapshot | undefined {
  const entries = body.snapshots
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_RECOVERY_READ_RECORDS) return undefined
  // A primary fallback can omit newer customer history. Its older final
  // snapshot never licenses choosing this original. The public API forwards
  // success/source; older responses may omit these optional envelope fields.
  if (body.success !== undefined && body.success !== true) return undefined
  if (body.source !== undefined && body.source !== 'primary' && body.source !== 'customer') return undefined
  // No newest-state inference from a partial page or an unknown envelope.
  if (Object.keys(body).some(key => !['snapshots', 'total', 'count', 'success', 'source'].includes(key))) return undefined
  if (body.total !== undefined && body.total !== entries.length) return undefined
  if (body.count !== undefined && body.count !== entries.length) return undefined
  const previous = recovery.snapshot.snapshot
  const previousAt = previous && Date.parse(previous.createdAt)
  if (!previous || previous.fromSandboxId !== recovery.sandboxId
    || previousAt === undefined || !Number.isFinite(previousAt)) return undefined
  let latest: (FinalSnapshot & { final: boolean }) | undefined
  const ids = new Set<string>()
  for (const entry of entries) {
    if (!record(entry)) return undefined
    const id = entry.snapshotId ?? entry.id
    const owner = entry.sandboxId ?? entry.projectRef
    const createdAt = typeof entry.createdAt === 'string' ? Date.parse(entry.createdAt) : NaN
    // The authenticated endpoint scopes omitted owner fields to this exact
    // original (the SDK's standard listSnapshots contract). Explicit mismatch
    // is a refusal, not a record to silently filter out.
    if (typeof id !== 'string' || !id.trim() || ids.has(id)
      || (owner !== undefined && owner !== recovery.sandboxId)
      || (entry.sandboxId !== undefined && entry.sandboxId !== recovery.sandboxId)
      || (entry.projectRef !== undefined && entry.projectRef !== recovery.sandboxId)
      || !Number.isFinite(createdAt) || createdAt > now
      || !Array.isArray(entry.tags) || !entry.tags.every(tag => typeof tag === 'string')) return undefined
    ids.add(id)
    const final = entry.tags.includes('pre-suspend') && entry.remoteSync === 'synced'
      && createdAt >= original.suspendedAt && createdAt > previousAt
      && now - createdAt <= WORKSPACE_SANDBOX_SNAPSHOT_MAX_AGE_MS
    if (!latest || createdAt > latest.createdAt) latest = { snapshotId: id, createdAt, final }
    else if (createdAt === latest.createdAt && id !== latest.snapshotId) return undefined
  }
  return latest?.final ? latest : undefined
}

/** Called only through the recovery manager. No create/resume/ensure/delete,
 * no physical-absence inference and no cancellation of remote operations. */
export async function reconcileWorkspaceSandboxOriginal<Snapshot extends WorkspaceSandboxSnapshot>(
  store: WorkspaceSandboxRecoveryStore<Snapshot>,
  options: WorkspaceSandboxOriginalRecoveryOptions,
): Promise<WorkspaceSandboxOriginalRecoveryResult<Snapshot>> {
  const current = await store.read(options.workspaceId)
  const result = (status: WorkspaceSandboxOriginalRecoveryResult<Snapshot>['status'], reason?: string) => ({ status, recovery: current, reason })
  if (!current || current.code !== WORKSPACE_SANDBOX_MISSING) return result('unchanged')
  if (current.action === 'original_recovered') return result('recovered')
  // Manual decisions and already completed replacements are never switched.
  if (current.action !== 'missing_replacement_started') return result('unchanged')
  if (current.replacementSandboxId) return result('conflict', 'replacement_already_bound')
  if (!current.replacementBoxKey?.trim() || !store.compareAndSet || !store.insertIfAbsent) return result('unverified', 'atomic_transition_required')
  const now = options.now ?? Date.now()
  if (!Number.isFinite(now)) return result('unverified', 'invalid_clock')
  let first: CommittedOriginal | undefined
  let last: CommittedOriginal | undefined
  let snapshot: FinalSnapshot | undefined
  try {
    const replacement = await inspectReplacement(options.client, current.replacementBoxKey)
    if (replacement === 'present') return result('conflict', 'replacement_physically_present')
    if (replacement !== 'clear') return result('unverified', 'replacement_listing_unverified')
    first = await committedOriginal(current, options, now)
    if (!first || first.boxKey === current.replacementBoxKey) return result('unverified', 'original_not_committed_or_owned')
    const response = await options.client.fetch(`/v1/sandboxes/${encodeURIComponent(current.sandboxId)}/snapshots`, { method: 'GET' }, { timeoutMs: 5_000 })
    if (!response.ok) {
      await response.body?.cancel()
      return result('unverified', 'snapshot_read_refused')
    }
    const [body, error] = await parseJsonObjectBody(response, { maxBytes: MAX_RECOVERY_READ_BYTES })
    if (error) {
      await response.body?.cancel().catch(() => undefined)
      return result('unverified', 'snapshot_body_unreadable')
    }
    snapshot = finalSnapshot(body, current, first, now)
    if (!snapshot) return result('unverified', 'final_snapshot_unverified')
    last = await committedOriginal(current, options, now)
    const replacementAfter = await inspectReplacement(options.client, current.replacementBoxKey)
    if (replacementAfter === 'present') return result('conflict', 'replacement_physically_present')
    if (replacementAfter !== 'clear') return result('unverified', 'replacement_listing_unverified')
  } catch {
    return result('unverified', 'original_read_failed')
  }
  if (!last || last.boxKey !== first.boxKey || last.suspendedAt !== first.suspendedAt
    || last.incarnationId !== first.incarnationId) return result('unverified', 'original_changed_during_read')
  const next: WorkspaceSandboxRecoveryState<Snapshot> = {
    ...current,
    action: 'original_recovered',
    originalBoxKey: first.boxKey,
    // Keep replacementBoxKey as invalidation evidence. The action no longer
    // chooses it; an unknown in-flight remote create is not called absent.
    originalRecovered: {
      snapshotId: snapshot.snapshotId, snapshotCreatedAt: new Date(snapshot.createdAt).toISOString(),
      suspendedAt: new Date(first.suspendedAt).toISOString(),
      ...(first.incarnationId ? { filesystemIncarnationId: first.incarnationId } : {}),
      verifiedAt: new Date(now).toISOString(),
    },
  }
  if (!await store.compareAndSet(options.workspaceId, current, next)) return result('conflict', 'recovery_changed')
  return { status: 'recovered', recovery: next }
}
