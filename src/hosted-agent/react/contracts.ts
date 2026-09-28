import type { Line, LineFromConnectionInput, LineMember, LineMemberPatch, LineMemberSpec } from '@tangle-network/sandbox'

export type ConnectableLineTransport = LineFromConnectionInput['transport']
export type LineBoxMode = 'per-member' | 'shared'
export type LineIdentityKind = 'handle' | 'number' | 'email'

/** An owned identity that Hub can turn into a line through sandbox.lines.fromConnection(). */
export interface LineIdentityOption {
  kind: LineIdentityKind
  transport: ConnectableLineTransport
  label: string
  /** An existing provider number id, when this connection owns several numbers. */
  phoneNumberId?: string
  /** True when the provider requires the owner to enter an existing number id. */
  requiresPhoneNumberId?: boolean
}

export interface LineConnectionOption {
  id: string
  label: string
  providerId: string
  identities: LineIdentityOption[]
}

export interface LineAnswerTarget {
  id: string
  label: string
  kind: 'agent' | 'box'
  modes: readonly LineBoxMode[]
}

export type LineLastTurn =
  | { kind: 'latest'; at: string; status: string }
  | { kind: 'none' }
  | { kind: 'unavailable' }

/** The line fields the SDK returns, with the app's target and latest turn joined on. */
export interface LineSetupLine extends Pick<Line, 'id' | 'connectionId' | 'transport' | 'address' | 'connect' | 'routerAddress' | 'status'> {
  /** True only while an active Hub attachment routes messages to an agent or box. */
  answering: boolean
  /** The viewer may disconnect this line. A workspace list can include other agents' lines. */
  canDisconnect: boolean
  targetId: string | null
  targetLabel: string | null
  boxMode: LineBoxMode | null
  lastTurn: LineLastTurn
}

export interface LineSetupSnapshot {
  /** Include every line in the workspace, even when another agent answers it. */
  lines: LineSetupLine[]
  /** Null means the Hub connection read failed; an empty array means none exist. */
  connections: LineConnectionOption[] | null
  targets: LineAnswerTarget[]
  workspaceName: string
}

export interface LineConnectInput {
  connectionId: string
  transport: ConnectableLineTransport
  phoneNumberId?: string
  targetId: string
  boxMode: LineBoxMode
}

/** The host authenticates these calls and composes the published Sandbox SDK and Hub clients. */
export interface LineSetupClient {
  load(): Promise<LineSetupSnapshot>
  connect(input: LineConnectInput): Promise<void>
  disconnect(lineId: string): Promise<void>
}

export interface LineSetupProps {
  client: LineSetupClient
  /** Reloads when the host switches workspace or agent. */
  scopeKey: string
  initialTargetId?: string
  canManage: boolean
  onNotice?(notice: { kind: 'success' | 'error'; message: string }): void
}

export interface LineMemberRole {
  value: string
  label: string
  tools: 'act' | 'chat'
}

export interface LineMembersClient {
  list(lineId: string): Promise<LineMember[]>
  add(lineId: string, input: LineMemberSpec): Promise<void>
  update(lineId: string, memberId: string, patch: LineMemberPatch): Promise<void>
  remove(lineId: string, memberId: string): Promise<void>
}

export interface LineMembersProps {
  lineId: string
  /** Changes when the authenticated viewer or workspace changes. */
  scopeKey: string
  client: LineMembersClient
  /** The attached line's actual role map, including any chat-only role. */
  roles: readonly LineMemberRole[]
  canManage: boolean
  /** Disable generic invitations when the product uses a separate verified owner claim. */
  canAdd?: boolean
  /** Product policy can narrow an otherwise shared line to one member. */
  maxMembers?: number
  allowRoleChange?: boolean
  /** A one-member product may free its line for the next consenting owner. */
  allowRemoveLastOwner?: boolean
  onNotice?(notice: { kind: 'success' | 'error'; message: string }): void
}

export interface LineBillingView {
  workspaceName: string
  lineAddress: string
  /** The Hub's verified line charge owner. Unknown is shown as unverified. */
  linePayer: { kind: 'workspace'; label: string } | { kind: 'unverified' }
  /** The payer for agent turns; member payer is available when Hub enables it. */
  turnPayer: { kind: 'owner' | 'member'; label: string } | { kind: 'unverified' }
  allowance: {
    turnsPerMemberPerDay: number
    used?: number
    limit?: number
    resetsAt?: string
  } | null
}

export interface LineBillingProps {
  view: LineBillingView
}
