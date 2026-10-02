import type { LineApplicationRequest } from '@tangle-network/sandbox/core'
import { createApplicationLineHandler, type ApplicationLineObservation } from '../hosted-agent/application'
import type { AgentEnrollmentTarget, ResolvedAgentEnrollment } from './index'

/** The host verifies Hub's signed callback before the SDK parses its body. */
export interface AuthenticatedSharedLinePrincipal<Principal> {
  principal: Principal
  binding: string
  /** Identity of the verified binding-scoped bearer, checked again at the task write. */
  callbackCredentialId: string
}

/** Current host-owned app, customer and member grant for one Hub subject. */
export interface LiveSharedEnrollmentMember {
  binding: string
  subjectId: string
  appId: string
  lineId: string
  attachmentId: string
  memberId: string
  /** Changes on every grant, consent, or target remap, including revoke and regrant. */
  grantRevision: string
  /** Fresh Hub member.updatedAt, independent of the application's grant revision. */
  memberRevision: string
  ownerUserId: string
  senderAddress: string
  enrollmentId: string
  agentId: string
  workspaceId: string
  threadId: string
}

/** Signed Hub fields required for every shared Line observation. */
export interface ObservedSharedLineApplicationRequest extends LineApplicationRequest {
  subjectId: string
  memberRevision: string
  dispatchFence?: string
  dispatchDeadline?: string
}

/** Lease fields required before a shared Line can admit new work. */
export interface SignedSharedLineApplicationRequest extends ObservedSharedLineApplicationRequest {
  dispatchFence: string
  /** Canonical UTC timestamp with milliseconds when this attempt loses admission authority. */
  dispatchDeadline: string
}

export interface EnrolledApplicationLineOptions<Principal> {
  /** Verify the callback bearer and return its current credential identity. */
  authenticate(request: Request): Promise<AuthenticatedSharedLinePrincipal<Principal>>
  /** Select an intended app from durable policy. Message text is intent, never a grant. */
  selectApp(authenticated: AuthenticatedSharedLinePrincipal<Principal>, input: Readonly<LineApplicationRequest>): Promise<string>
  /** Re-read live app, consent, grant and Hub member.updatedAt for the selected app. */
  lookup(principal: Principal, binding: string, subjectId: string, appId: string): Promise<LiveSharedEnrollmentMember | null>
  enrollment: { resolve(principal: Principal, enrollmentId: string): Promise<ResolvedAgentEnrollment> }
  /** Read through the application's existing durable output store using the pinned grant. */
  read(resolved: ResolvedAgentEnrollment, input: Readonly<ObservedSharedLineApplicationRequest>,
    member: Readonly<LiveSharedEnrollmentMember>): Promise<ApplicationLineObservation>
  /**
   * At the durable write, atomically compare the live grant, Hub member revision,
   * callback credential, dispatch fence and deadline. Deduplicate by messageId.
   */
  admit(resolved: ResolvedAgentEnrollment, input: Readonly<SignedSharedLineApplicationRequest>,
    member: Readonly<LiveSharedEnrollmentMember>,
    authenticated: Readonly<AuthenticatedSharedLinePrincipal<Principal>>): Promise<void>
}

function forbidden(): Response {
  return Response.json({ error: { code: 'enrollment_binding_mismatch' } },
    { status: 403, headers: { 'cache-control': 'no-store' } })
}

function utcMillis(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null
}

function signedInput(input: Readonly<LineApplicationRequest>): Readonly<ObservedSharedLineApplicationRequest> | null {
  const value = input as LineApplicationRequest & Partial<ObservedSharedLineApplicationRequest>
  if (typeof value.subjectId !== 'string' || !value.subjectId
    || utcMillis(value.memberRevision) === null) return null
  if (value.dispatchFence === undefined && value.dispatchDeadline === undefined)
    return value.acceptedExecutionId === undefined ? null : value as ObservedSharedLineApplicationRequest
  if (typeof value.dispatchFence !== 'string' || !value.dispatchFence
    || utcMillis(value.dispatchDeadline) === null) return null
  return value as ObservedSharedLineApplicationRequest
}

function admissionInput(input: Readonly<ObservedSharedLineApplicationRequest>): Readonly<SignedSharedLineApplicationRequest> | null {
  return input.dispatchFence !== undefined && input.dispatchDeadline !== undefined
    ? input as SignedSharedLineApplicationRequest : null
}

function matches(input: Readonly<ObservedSharedLineApplicationRequest>, member: LiveSharedEnrollmentMember): boolean {
  return !!member.enrollmentId && !!member.grantRevision && !!member.memberRevision
    && member.binding === input.binding && member.subjectId === input.subjectId
    && member.memberRevision === input.memberRevision
    && member.lineId === input.lineId && member.attachmentId === input.attachmentId
    && member.memberId === input.memberId && member.ownerUserId === input.ownerUserId
    && member.senderAddress === input.sender.address
}

function sameMember(left: LiveSharedEnrollmentMember, right: LiveSharedEnrollmentMember): boolean {
  return left.binding === right.binding && left.subjectId === right.subjectId
    && left.appId === right.appId && left.grantRevision === right.grantRevision
    && left.memberRevision === right.memberRevision
    && left.enrollmentId === right.enrollmentId && left.agentId === right.agentId
    && left.workspaceId === right.workspaceId && left.threadId === right.threadId
    && left.lineId === right.lineId && left.attachmentId === right.attachmentId
    && left.memberId === right.memberId && left.ownerUserId === right.ownerUserId
    && left.senderAddress === right.senderAddress
}

function matchesTarget(member: LiveSharedEnrollmentMember, target: AgentEnrollmentTarget): boolean {
  return member.enrollmentId === target.enrollmentId && member.agentId === target.agentId
    && member.workspaceId === target.workspaceId && member.threadId === target.threadId
}

function sameTarget(left: AgentEnrollmentTarget, right: AgentEnrollmentTarget): boolean {
  return left.enrollmentId === right.enrollmentId && left.agentId === right.agentId
    && left.workspaceId === right.workspaceId && left.threadId === right.threadId
    && left.instanceKey === right.instanceKey && left.configurationDigest === right.configurationDigest
    && left.profileVersion === right.profileVersion && left.generation === right.generation
    && left.sandboxId === right.sandboxId && left.filesystemIncarnationId === right.filesystemIncarnationId
    && left.sessionId === right.sessionId
}

interface PinnedResolution {
  member: Readonly<LiveSharedEnrollmentMember>
  target: Readonly<AgentEnrollmentTarget>
}

interface AuthenticatedContext<Principal> extends AuthenticatedSharedLinePrincipal<Principal> {
  selectedAppId?: string
  pinned?: PinnedResolution
}

/** Bind a signed shared Line member to the same native target used by web and ChatGPT. */
export function createEnrolledApplicationLineHandler<Principal>(options: EnrolledApplicationLineOptions<Principal>) {
  async function resolve(authenticated: AuthenticatedContext<Principal>,
    input: Readonly<LineApplicationRequest>) {
    const signed = signedInput(input)
    if (!signed) throw forbidden()
    const appId = await options.selectApp(authenticated, signed)
    if (!appId || (authenticated.selectedAppId && authenticated.selectedAppId !== appId)) throw forbidden()
    authenticated.selectedAppId = appId
    const observedMember = await options.lookup(authenticated.principal, authenticated.binding, signed.subjectId, appId)
    if (!observedMember) throw forbidden()
    // A host cache may return the same mutable object on both lookups.
    const member = Object.freeze({ ...observedMember })
    if (member.appId !== appId || !matches(signed, member)
      || (authenticated.pinned && !sameMember(authenticated.pinned.member, member))) throw forbidden()
    const resolved = await options.enrollment.resolve(authenticated.principal, member.enrollmentId)
    const target = Object.freeze({ ...resolved.target })
    if (!matchesTarget(member, target)
      || (authenticated.pinned && !sameTarget(authenticated.pinned.target, target))) throw forbidden()
    // SDK observations yield. A revoked or remapped member must not start or read a turn.
    const current = await options.lookup(authenticated.principal, authenticated.binding, signed.subjectId, appId)
    if (!current || !sameMember(current, member)) throw forbidden()
    authenticated.pinned ??= Object.freeze({ member, target })
    return { resolved: { ...resolved, target }, member: authenticated.pinned.member, signed }
  }

  return createApplicationLineHandler({
    authenticate: async request => {
      const target = await options.authenticate(request)
      if (!target.binding || !target.callbackCredentialId) throw forbidden()
      return { binding: target.binding, target: { ...target, selectedAppId: undefined, pinned: undefined } }
    },
    authorize: async (target, input) => { await resolve(target, input) },
    read: async (target, input) => {
      const { resolved, member, signed } = await resolve(target, input)
      return options.read(resolved, signed, member)
    },
    admit: async (target, input) => {
      const { resolved, member, signed } = await resolve(target, input)
      const admission = admissionInput(signed)
      if (!admission) throw forbidden()
      const remaining = Date.parse(admission.dispatchDeadline) - Date.now()
      if (remaining <= 0 || remaining > 60_000) throw forbidden()
      return options.admit(resolved, admission, member,
        Object.freeze({ principal: target.principal, binding: target.binding,
          callbackCredentialId: target.callbackCredentialId }))
    },
  })
}
