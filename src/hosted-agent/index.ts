import type { AgentProfile, BackendConfig, LineVoiceOptions } from '@tangle-network/sandbox'
import { type Line, type LineInstanceCreate, Sandbox } from '@tangle-network/sandbox/core'

/** Native Hub options. The kit does not keep a second membership or execution store. */
type NativeAttachment = Parameters<Sandbox['lines']['attach']>[0]
export type HostedAgentAttachment = Partial<Omit<NativeAttachment, 'number' | 'mode' | 'respond'>>
export type HostedAgentTransport = 'imessage' | 'whatsapp' | 'email'

export interface HostedAgentLineOptions {
  transport?: HostedAgentTransport
  mode?: 'personal' | 'shared'
  /** Required when creating a WhatsApp line on a connection with several numbers. */
  phoneNumberId?: string
  voice?: LineVoiceOptions
}

/**
 * The public conversation kit. Each person has an isolated sandbox.
 * This compatibility API is separate from the role-governed general-agent
 * provisioning path (`createTangleAgent` and `tangle-agent`).
 * Hub owns delivery, member threads, consent and execution. A host keeps its
 * product catalog and billing policy, then passes that policy to this kit.
 */
export interface HostedAgentConfig {
  /** Developer's Tangle API key. Required unless an authenticated client is supplied. */
  apiKey?: string
  /** Reuse the host's authenticated SDK client, including its timeout and tracing. */
  client?: Pick<Sandbox, 'lines'>
  profile: AgentProfile
  harness?: string
  /** A saved release can supply its complete, already-validated backend unchanged. */
  backend?: BackendConfig
  /** E.164 phone, or an email address (also accepted as an iMessage Apple ID). */
  owner: string
  freeTurnsPerDay?: number
  box?: Partial<BoxPolicy>
  sandboxUrl?: string
  /**
   * Host-selected members, roles, limits, instance namespace and reference.
   * Use a distinct instance.keyPrefix per assistant to keep their disks apart.
   * Supplying this never bypasses Hub's validation or owner checks.
   */
  attachment?: HostedAgentAttachment
}

export interface BoxPolicy {
  cpuCores: number
  memoryMB: number
  diskGB: number
  idleTimeoutSeconds: number
  maxLifetimeSeconds: number
  deleteAfterStoppedSeconds: number
  /** App domains. The runtime also admits the exact Platform preview-control host. */
  allowDomains: string[]
}

export const DEFAULT_BOX_POLICY: BoxPolicy = {
  cpuCores: 2, memoryMB: 2048, diskGB: 2,
  idleTimeoutSeconds: 600, maxLifetimeSeconds: 86_400, deleteAfterStoppedSeconds: 7 * 86_400,
  allowDomains: ['router.tangle.tools'],
}

/** Legacy default. Hosts running several assistants should supply their own namespace. */
export const PERSON_KEY_PREFIX = 'hosted:'
export const CONVERSATION_TOOLS_OFF = ['bash', 'glob', 'grep', 'task', 'todowrite', 'webfetch', 'skill'] as const
export const DEFAULT_HOSTED_MODEL = 'openai/gpt-5.6-luna'

function conversationProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    model: { ...profile.model, default: profile.model?.default ?? DEFAULT_HOSTED_MODEL },
    ...(profile.tools ? {} : {
      tools: Object.fromEntries(CONVERSATION_TOOLS_OFF.map(tool => [tool, false])),
      permissions: { bash: 'deny' as const, ...profile.permissions },
    }),
  }
}

const PERSON = { context: 'own', tools: 'act' } as const
// New shared-line guests are chat-only; trusted host policy may name other roles.
const GUEST = { context: 'own', tools: 'chat' } as const
const E164 = /^\+[1-9]\d{6,14}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class HostedAgentError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HostedAgentError' }
}

export function createHostedAgent(config: HostedAgentConfig) {
  if (!E164.test(config.owner) && !EMAIL.test(config.owner))
    throw new HostedAgentError('owner_not_e164', 'owner must be an E.164 phone number or email address.')
  if (!config.client && !config.apiKey)
    throw new HostedAgentError('credential_required', 'Supply an API key or an authenticated Sandbox client.')
  const policy = { ...DEFAULT_BOX_POLICY, ...config.box }
  const allowDomains = [...new Set([...policy.allowDomains, 'id.tangle.tools'])]
  const sandbox = config.client ?? new Sandbox({ apiKey: config.apiKey!, baseUrl: config.sandboxUrl ?? 'https://sandbox.tangle.tools', timeoutMs: 20_000 })
  const backend: BackendConfig = config.backend ?? {
    ...(config.harness ? { type: config.harness as BackendConfig['type'] } : {}),
    profile: conversationProfile(config.profile),
  }
  const create: LineInstanceCreate = {
    name: 'hosted-person',
    resources: { cpuCores: policy.cpuCores, memoryMB: policy.memoryMB, diskGB: policy.diskGB },
    egressPolicy: { mode: 'strict', allowDomains, includeImplicitDomains: false },
    idleTimeoutSeconds: policy.idleTimeoutSeconds, maxLifetimeSeconds: policy.maxLifetimeSeconds,
    deleteAfterStoppedSeconds: policy.deleteAfterStoppedSeconds,
  }
  const members = config.attachment?.members ?? [{ address: config.owner, role: 'owner' }]

  function validate(transport: HostedAgentTransport, options: HostedAgentLineOptions, creating: boolean) {
    if (!['imessage', 'whatsapp', 'email'].includes(transport))
      throw new HostedAgentError('transport_unsupported', 'Use an iMessage, WhatsApp or email line.')
    if (options.mode !== undefined && options.mode !== 'personal' && options.mode !== 'shared')
      throw new HostedAgentError('mode_invalid', 'mode must be personal or shared.')
    for (const address of [config.owner, ...members.map(member => member.address)]) {
      const valid = transport === 'email' ? EMAIL.test(address)
        : transport === 'whatsapp' ? E164.test(address) : E164.test(address) || EMAIL.test(address)
      if (!valid) throw new HostedAgentError('owner_transport_mismatch', `Member address does not match ${transport}.`)
    }
    if (creating && transport === 'whatsapp' && !options.phoneNumberId)
      throw new HostedAgentError('phone_number_required', 'WhatsApp lines require phoneNumberId.')
    if (transport !== 'whatsapp' && options.phoneNumberId)
      throw new HostedAgentError('phone_number_not_allowed', 'phoneNumberId is only valid for WhatsApp lines.')
    if (options.voice && transport !== 'imessage')
      throw new HostedAgentError('voice_transport_unsupported', 'Voice is supported only on iMessage lines.')
    if (transport === 'email' && config.attachment?.unknownSenders && config.attachment.unknownSenders !== 'reject')
      throw new HostedAgentError('email_declared_members_required', 'Email lines admit declared members only.')
  }

  async function attach(line: Line, options: HostedAgentLineOptions): Promise<Line> {
    const transport = line.transport as HostedAgentTransport
    validate(transport, options, false)
    if (options.transport && options.transport !== transport)
      throw new HostedAgentError('line_transport_mismatch', 'The existing line uses another transport.')
    if (options.phoneNumberId && line.providerNumberId !== options.phoneNumberId)
      throw new HostedAgentError('line_number_mismatch', 'The existing line is pinned to another WhatsApp number.')
    const retained = line.attachment?.status === 'active' ? line.attachment : undefined
    if (retained?.unknownSenders === 'onboard')
      throw new HostedAgentError('line_policy_migration_required', 'This line uses onboard admission. Manage it through Hub; the hosted-agent kit will not replace its policy.')
    const mode = options.mode ?? retained?.mode ?? 'shared'
    const declaredMembers = config.attachment?.members ?? (retained
      ? (await sandbox.lines.members(line.id).list())
        .filter(member => member.source === 'declared')
        .map(member => ({ address: member.address, role: member.role, label: member.label ?? undefined }))
      : members)
    const keyPrefix = line.attachment?.instance?.keyPrefix
      ?? (line.clientReference === 'hosted-agent' ? PERSON_KEY_PREFIX : `${PERSON_KEY_PREFIX}${line.id}:`)
    await sandbox.lines.attach({
      ...config.attachment,
      number: line.id,
      mode,
      members: declaredMembers,
      unknownSenders: config.attachment?.unknownSenders ?? retained?.unknownSenders ?? (mode === 'shared' && transport !== 'email' ? 'guest' : 'reject'),
      roles: config.attachment?.roles ?? retained?.roles ?? (mode === 'shared'
        ? { owner: PERSON, member: PERSON, guest: GUEST }
        : { owner: PERSON }),
      respond: { kind: 'agent', backend },
      limits: {
        ...retained?.limits,
        turnsPerMemberPerDay: config.freeTurnsPerDay ?? retained?.limits.turnsPerMemberPerDay ?? 20,
        ...config.attachment?.limits,
      },
      instance: config.attachment?.instance ?? retained?.instance ?? { keyPrefix, create },
      clientReference: config.attachment?.clientReference ?? retained?.clientReference ?? 'hosted-agent',
    })
    if (options.voice) await sandbox.lines.enableVoice(line.id, options.voice)
    return sandbox.lines.get(line.id)
  }

  return {
    /**
     * Create an address from an owned connection and attach it. Shared email
     * admits declared members only. Hub authenticates each mailbox by reply.
     * Other shared transports can admit isolated guests. Personal admits one
     * owner. Remove competing subscriptions before calling this method.
     */
    async attachLine(connectionId: string, options: HostedAgentLineOptions = {}): Promise<Line> {
      const transport = options.transport ?? 'imessage'
      validate(transport, options, true)
      // Hub deduplicates by provider identity. A new reference would conflict
      // with an existing WhatsApp line created by an earlier kit.
      const line = await sandbox.lines.fromConnection(transport === 'whatsapp'
        ? { connectionId, transport, phoneNumberId: options.phoneNumberId! }
        : { connectionId, transport })
      return attach(line, options)
    },
    /**
     * Attach an already-created owner-scoped line. Used during a host cutover
     * so the line id, connection, named-instance namespace and payer survive.
     * A 409 remains a 409. This method never detaches a competing attachment.
     */
    async attachExistingLine(lineId: string, options: HostedAgentLineOptions = {}): Promise<Line> {
      return attach(await sandbox.lines.get(lineId), options)
    },
  }
}

export type HostedAgent = ReturnType<typeof createHostedAgent>
export { buildGeneralAgentProfile, createTangleAgent, GENERAL_AGENT_MODEL, GENERAL_AGENT_SYSTEM_PROMPT } from './general'
export type { GeneralAgentProfileOptions, GeneralAgentMember, TangleAgentOptions } from './general'
export { agentHomeWorkflows } from './workflows'
export type { AgentHomeWorkflowOptions, AgentHomeWorkflow } from './workflows'
export { defaultHomeFiles, DEFAULT_HOME_LIMITS, DEFAULT_AGENT_HOME, withDefaultAgentHome } from '../profile/home'

export * from './application'
export * from './workspace-line'
