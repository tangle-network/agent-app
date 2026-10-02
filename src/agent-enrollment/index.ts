import type { EnsureInstanceOptions, Sandbox, SandboxInstance } from '@tangle-network/sandbox/core'

export { createEnrolledApplicationLineHandler } from './application'
export type { AuthenticatedSharedLinePrincipal, LiveSharedEnrollmentMember, EnrolledApplicationLineOptions, ObservedSharedLineApplicationRequest, SignedSharedLineApplicationRequest } from './application'

/** An application's durable pointer to one private agent's native SDK session. */
export interface AgentEnrollmentTarget {
  enrollmentId: string
  agentId: string
  workspaceId: string
  threadId: string
  instanceKey: string
  configurationDigest: string
  generation: number
  profileVersion: string
  sandboxId: string
  filesystemIncarnationId: string
  sessionId: string
}

export type AgentEnrollmentIdentity = Pick<AgentEnrollmentTarget, 'enrollmentId' | 'agentId' | 'workspaceId' | 'threadId'>

export interface AgentEnrollmentRequest extends AgentEnrollmentIdentity {
  /** The host derives this from the authorized agent and its saved profile. */
  instance: Pick<EnsureInstanceOptions, 'key' | 'create'> & { profile: NonNullable<EnsureInstanceOptions['profile']> }
}

/** Immutable reservation made before any SDK provisioning can change an instance. */
export type AgentEnrollmentClaim = AgentEnrollmentIdentity & Pick<AgentEnrollmentTarget,
  'instanceKey' | 'profileVersion' | 'configurationDigest'>

export interface AgentEnrollmentStore {
  get(enrollmentId: string): Promise<AgentEnrollmentTarget | null>
  /**
   * Atomically reserve the enrollment and instance key before SDK effects.
   * Return the existing claim for an enrollment ID. Reject another configuration
   * for a reserved instance key, even under a different enrollment ID.
   * Claims survive failed provisioning so an identical request can retry.
   */
  claimIfAbsent(claim: AgentEnrollmentClaim): Promise<AgentEnrollmentClaim>
  /** Atomically commit only under the matching claim. Never overwrite a target. */
  insertIfAbsent(target: AgentEnrollmentTarget): Promise<AgentEnrollmentTarget>
}

export interface AgentEnrollmentOptions<Principal> {
  /** Check the live agent, workspace, thread and owner grant on every call. */
  authorize(principal: Principal, identity: AgentEnrollmentIdentity, operation: 'enroll' | 'resolve'): Promise<void>
  /** Return the caller's owner-scoped SDK client. Never use a global service key. */
  client(principal: Principal): Pick<Sandbox, 'instances' | 'get'> | Promise<Pick<Sandbox, 'instances' | 'get'>>
  store: AgentEnrollmentStore
}

export class EnrollmentTargetError extends Error {
  constructor(readonly code: 'invalid_request' | 'missing' | 'conflict' | 'target_changed' | 'session_missing') {
    super(code)
    this.name = 'EnrollmentTargetError'
  }
}

export interface ResolvedAgentEnrollment {
  target: AgentEnrollmentTarget
  box: SandboxInstance
  session: ReturnType<SandboxInstance['session']>
}

function valid(value: string): boolean {
  return value.trim().length > 0
}

function sameIdentity(left: AgentEnrollmentIdentity, right: AgentEnrollmentIdentity): boolean {
  return left.enrollmentId === right.enrollmentId && left.agentId === right.agentId
    && left.workspaceId === right.workspaceId && left.threadId === right.threadId
}

function sameTarget(left: AgentEnrollmentTarget, right: AgentEnrollmentTarget): boolean {
  return sameIdentity(left, right) && left.instanceKey === right.instanceKey
    && left.generation === right.generation && left.profileVersion === right.profileVersion
    && left.configurationDigest === right.configurationDigest
    && left.sandboxId === right.sandboxId && left.filesystemIncarnationId === right.filesystemIncarnationId
    && left.sessionId === right.sessionId
}

function sameClaim(left: AgentEnrollmentClaim, right: AgentEnrollmentClaim): boolean {
  return sameIdentity(left, right) && left.instanceKey === right.instanceKey
    && left.profileVersion === right.profileVersion
    && left.configurationDigest === right.configurationDigest
}

async function configurationDigest(request: AgentEnrollmentRequest): Promise<string> {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify({ profile: request.instance.profile, create: request.instance.create },
      (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
        : value)
  } catch {
    throw new EnrollmentTargetError('invalid_request')
  }
  if (!serialized) throw new EnrollmentTargetError('invalid_request')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function snapshotRequest(request: AgentEnrollmentRequest): AgentEnrollmentRequest {
  try {
    return {
      enrollmentId: request.enrollmentId, agentId: request.agentId,
      workspaceId: request.workspaceId, threadId: request.threadId,
      instance: structuredClone(request.instance),
    }
  } catch {
    throw new EnrollmentTargetError('invalid_request')
  }
}

/** Share one authenticated target between an app's phone, web and ChatGPT adapters. */
export function createAgentEnrollment<Principal>(options: AgentEnrollmentOptions<Principal>) {
  async function resolve(principal: Principal, enrollmentId: string): Promise<ResolvedAgentEnrollment> {
    if (!valid(enrollmentId)) throw new EnrollmentTargetError('invalid_request')
    const stored = await options.store.get(enrollmentId)
    if (!stored) throw new EnrollmentTargetError('missing')
    const target = Object.freeze({ ...stored })
    await options.authorize(principal, target, 'resolve')
    const client = await options.client(principal)
    const record = await client.instances.get(target.instanceKey)
    if (!record || record.key !== target.instanceKey || record.generation !== target.generation
      || record.profileVersion !== target.profileVersion || record.sandboxId !== target.sandboxId) {
      throw new EnrollmentTargetError('target_changed')
    }
    const box = await client.get(target.sandboxId)
    if (!box || box.id !== target.sandboxId || box.filesystemIncarnationReadiness !== 'ready'
      || box.filesystemIncarnationId !== target.filesystemIncarnationId) {
      throw new EnrollmentTargetError('target_changed')
    }
    const session = box.session(target.sessionId)
    const status = await session.status()
    if (!status || status.id !== target.sessionId) throw new EnrollmentTargetError('session_missing')
    // Each external observation can yield; deny if the host revoked the grant meanwhile.
    await options.authorize(principal, target, 'resolve')
    return { target, box, session }
  }

  async function enroll(principal: Principal, request: AgentEnrollmentRequest): Promise<AgentEnrollmentTarget> {
    const snapshot = snapshotRequest(request)
    if (![snapshot.enrollmentId, snapshot.agentId, snapshot.workspaceId, snapshot.threadId,
      snapshot.instance.key, snapshot.instance.profile.version].every(valid)) {
      throw new EnrollmentTargetError('invalid_request')
    }
    const identity: AgentEnrollmentIdentity = Object.freeze({
      enrollmentId: snapshot.enrollmentId, agentId: snapshot.agentId,
      workspaceId: snapshot.workspaceId, threadId: snapshot.threadId,
    })
    await options.authorize(principal, identity, 'enroll')
    const claim: AgentEnrollmentClaim = Object.freeze({
      ...identity,
      instanceKey: snapshot.instance.key, profileVersion: snapshot.instance.profile.version,
      configurationDigest: await configurationDigest(snapshot),
    })
    const winner = await options.store.claimIfAbsent(claim)
    if (!sameClaim(winner, claim)) throw new EnrollmentTargetError('conflict')
    const existing = await options.store.get(snapshot.enrollmentId)
    if (existing) {
      if (!sameClaim(existing, claim)) throw new EnrollmentTargetError('conflict')
      return (await resolve(principal, snapshot.enrollmentId)).target
    }
    const client = await options.client(principal)
    // Store and client lookups can yield after the first grant check.
    await options.authorize(principal, identity, 'enroll')
    const instance = await client.instances.ensure(structuredClone(snapshot.instance))
    const box = instance.box
    if (instance.key !== claim.instanceKey || instance.profileVersion !== claim.profileVersion
      || !Number.isSafeInteger(instance.generation) || instance.generation < 1
      || instance.sandboxId !== box.id || box.filesystemIncarnationReadiness !== 'ready'
      || !box.filesystemIncarnationId) throw new EnrollmentTargetError('target_changed')
    const sessionId = instance.sessionId(claim.threadId)
    if (!valid(sessionId)) throw new EnrollmentTargetError('target_changed')
    // Provisioning can await a revoked grant. Check again before creating a session.
    await options.authorize(principal, identity, 'enroll')
    const created = await box.createSession({ sessionId, retention: 'workspace', backend: snapshot.instance.profile.backend })
    if (created.info.id !== sessionId) throw new EnrollmentTargetError('target_changed')
    const target: AgentEnrollmentTarget = Object.freeze({
      enrollmentId: claim.enrollmentId, agentId: claim.agentId, workspaceId: claim.workspaceId,
      threadId: claim.threadId, instanceKey: instance.key,
      configurationDigest: claim.configurationDigest, generation: instance.generation,
      profileVersion: instance.profileVersion, sandboxId: instance.sandboxId,
      filesystemIncarnationId: box.filesystemIncarnationId, sessionId,
    })
    const record = await client.instances.get(target.instanceKey)
    if (!record || record.generation !== target.generation || record.sandboxId !== target.sandboxId
      || record.profileVersion !== target.profileVersion) throw new EnrollmentTargetError('target_changed')
    await options.authorize(principal, identity, 'enroll')
    const saved = await options.store.insertIfAbsent(target)
    if (!sameTarget(saved, target)) throw new EnrollmentTargetError('conflict')
    return (await resolve(principal, claim.enrollmentId)).target
  }

  return { enroll, resolve }
}
