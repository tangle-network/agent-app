/** Separate cleanup policy. Chat switches and profile tools never import this module. */
export const MIN_PROFILE_REAP_GRACE_MS = 24 * 60 * 60 * 1000

export interface ProfileReapCandidate {
  resourceId: string
  workspaceId: string
  /** When the final reference stopped using this resource. */
  retiredAt: number
  /** Binding event that replaced this resource. */
  successorBindingVersion: number
}

export interface ProfileReaperPort {
  listCandidates(): Promise<ProfileReapCandidate[]>
  /** Must include current bindings and all admitted turns still in flight. */
  hasLiveReference(candidate: ProfileReapCandidate): Promise<boolean>
  hasSuccessfulSuccessorTurn(candidate: ProfileReapCandidate): Promise<boolean>
  hasDryRunReceipt(candidate: ProfileReapCandidate): Promise<boolean>
  recordDryRun(candidate: ProfileReapCandidate): Promise<void>
  /** Platform retire path. Recheck references atomically at retirement. */
  retireIfStillUnreferenced(candidate: ProfileReapCandidate): Promise<boolean>
}

export interface ProfileReapDecision {
  candidate: ProfileReapCandidate
  status: 'too-new' | 'referenced' | 'no-successor-turn' | 'dry-run' | 'needs-dry-run' | 'retired' | 'changed'
}

/** Defaults to a logged dry run; a destructive pass requires a prior dry-run receipt. */
export async function runProfileReaper(input: {
  port: ProfileReaperPort
  now?: number
  graceMs?: number
  dryRun?: boolean
}): Promise<ProfileReapDecision[]> {
  const now = input.now ?? Date.now()
  const graceMs = input.graceMs ?? MIN_PROFILE_REAP_GRACE_MS
  if (!Number.isFinite(now) || !Number.isFinite(graceMs) || graceMs < MIN_PROFILE_REAP_GRACE_MS) {
    throw new TypeError('Profile reaper requires a grace period of at least 24 hours')
  }
  const dryRun = input.dryRun ?? true
  const decisions: ProfileReapDecision[] = []
  for (const candidate of await input.port.listCandidates()) {
    let status: ProfileReapDecision['status']
    if (candidate.retiredAt > now - graceMs) status = 'too-new'
    else if (await input.port.hasLiveReference(candidate)) status = 'referenced'
    else if (!await input.port.hasSuccessfulSuccessorTurn(candidate)) status = 'no-successor-turn'
    else if (dryRun) {
      await input.port.recordDryRun(candidate)
      status = 'dry-run'
    } else if (!await input.port.hasDryRunReceipt(candidate)) status = 'needs-dry-run'
    else status = await input.port.retireIfStillUnreferenced(candidate) ? 'retired' : 'changed'
    decisions.push({ candidate, status })
  }
  return decisions
}
