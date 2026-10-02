import type { LineApplicationRequest } from '@tangle-network/sandbox/core'
import { createApplicationLineHandler, type ApplicationLineObservation } from '../hosted-agent/application'
import type { AgentEnrollmentTarget, ResolvedAgentEnrollment } from './index'

/** The host verifies Hub's signed callback before the SDK parses its body. */
export interface AuthenticatedSharedLinePrincipal<Principal> {
  principal: Principal
  binding: string
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
  ownerUserId: string
  senderAddress: string
  enrollmentId: string
  agentId: string
  workspaceId: string
  threadId: string
}

export interface EnrolledApplicationLineOptions<Principal> {
  /** Verify the server-to-server callback; the maintained SDK parses its subjectId. */
  authenticate(request: Request): Promise<AuthenticatedSharedLinePrincipal<Principal>>
  /** Select an intended app from durable policy. Message text is intent, never a grant. */
  selectApp(authenticated: AuthenticatedSharedLinePrincipal<Principal>, input: Readonly<LineApplicationRequest>): Promise<string>
  /** Re-read live app, customer, consent and member grant for the selected app. */
  lookup(principal: Principal, binding: string, subjectId: string, appId: string): Promise<LiveSharedEnrollmentMember | null>
  enrollment: { resolve(principal: Principal, enrollmentId: string): Promise<ResolvedAgentEnrollment> }
  /** Read and admit through the application's existing durable task and output store. */
  read(resolved: ResolvedAgentEnrollment, input: Readonly<LineApplicationRequest>): Promise<ApplicationLineObservation>
  admit(resolved: ResolvedAgentEnrollment, input: Readonly<LineApplicationRequest>): Promise<void>
}

function forbidden(): Response {
  return Response.json({ error: { code: 'enrollment_binding_mismatch' } },
    { status: 403, headers: { 'cache-control': 'no-store' } })
}

function subjectId(input: Readonly<LineApplicationRequest>): string | null {
  const value = (input as LineApplicationRequest & { subjectId?: unknown }).subjectId
  return typeof value === 'string' && value.length > 0 ? value : null
}

function matches(input: Readonly<LineApplicationRequest>, member: LiveSharedEnrollmentMember): boolean {
  return !!member.enrollmentId && !!member.grantRevision
    && member.binding === input.binding && member.subjectId === subjectId(input)
    && member.lineId === input.lineId && member.attachmentId === input.attachmentId
    && member.memberId === input.memberId && member.ownerUserId === input.ownerUserId
    && member.senderAddress === input.sender.address
}

function sameMember(left: LiveSharedEnrollmentMember, right: LiveSharedEnrollmentMember): boolean {
  return left.binding === right.binding && left.subjectId === right.subjectId
    && left.appId === right.appId && left.grantRevision === right.grantRevision
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
    const subject = subjectId(input)
    if (!subject) throw forbidden()
    const appId = await options.selectApp(authenticated, input)
    if (!appId || (authenticated.selectedAppId && authenticated.selectedAppId !== appId)) throw forbidden()
    authenticated.selectedAppId = appId
    const member = await options.lookup(authenticated.principal, authenticated.binding, subject, appId)
    if (!member || member.appId !== appId || !matches(input, member)
      || (authenticated.pinned && !sameMember(authenticated.pinned.member, member))) throw forbidden()
    const resolved = await options.enrollment.resolve(authenticated.principal, member.enrollmentId)
    if (!matchesTarget(member, resolved.target)
      || (authenticated.pinned && !sameTarget(authenticated.pinned.target, resolved.target))) throw forbidden()
    // SDK observations yield. A revoked or remapped member must not start or read a turn.
    const current = await options.lookup(authenticated.principal, authenticated.binding, subject, appId)
    if (!current || !sameMember(current, member)) throw forbidden()
    authenticated.pinned ??= Object.freeze({
      member: Object.freeze({ ...member }), target: Object.freeze({ ...resolved.target }),
    })
    return resolved
  }

  return createApplicationLineHandler({
    authenticate: async request => {
      const target = await options.authenticate(request)
      if (!target.binding) throw forbidden()
      return { binding: target.binding, target: { ...target, selectedAppId: undefined, pinned: undefined } }
    },
    authorize: async (target, input) => { await resolve(target, input) },
    read: async (target, input) => options.read(await resolve(target, input), input),
    admit: async (target, input) => options.admit(await resolve(target, input), input),
  })
}
