import type { AgentProfile, BackendConfig, LineVoiceOptions } from '@tangle-network/sandbox'
import { type Line, type LineInstanceCreate, Sandbox } from '@tangle-network/sandbox/core'

export interface HostedAgentConfig {
  /** The developer's Tangle API key. Used only for platform requests. */
  apiKey: string
  /** Stable application identity. Different assistants must use different ids.
   * Omit only for existing single-assistant installations using `hosted:`. */
  id?: string
  profile: AgentProfile
  harness?: string
  /** E.164 phone number, or an email address for an email line. */
  owner: string
  /** Additional declared members in shared mode. Each has an isolated sandbox. */
  members?: Array<{ address: string; label?: string }>
  freeTurnsPerDay?: number
  box?: Partial<BoxPolicy>
  sandboxUrl?: string
}

export interface BoxPolicy {
  cpuCores: number
  memoryMB: number
  diskGB: number
  idleTimeoutSeconds: number
  maxLifetimeSeconds: number
  deleteAfterStoppedSeconds: number
  allowDomains: string[]
}

export const DEFAULT_BOX_POLICY: BoxPolicy = {
  cpuCores: 2, memoryMB: 2048, diskGB: 2,
  idleTimeoutSeconds: 600, maxLifetimeSeconds: 86_400, deleteAfterStoppedSeconds: 7 * 86_400,
  allowDomains: ['router.tangle.tools'],
}

/** Legacy namespace. Named assistants never share this namespace. */
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
const E164 = /^\+[1-9]\d{6,14}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export class HostedAgentError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HostedAgentError' }
}

export interface HostedAgentIdentity {
  /** The contract revision, not a package version. */
  revision: 1
  id: string | null
  clientReference: string
  instanceKeyPrefix: string
}

export interface HostedLineOptions {
  transport?: 'imessage' | 'email' | 'whatsapp'
  mode?: 'personal' | 'shared'
  phoneNumberId?: string
  /** Shared phone lines default to guest admission. Email requires declared members. */
  unknownSenders?: 'reject' | 'guest'
  voice?: LineVoiceOptions
}

function address(value: string): string {
  const normalized = value.trim()
  return normalized.includes('@') ? normalized.toLowerCase() : normalized
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24)
}

/**
 * The kit describes a hosted agent. Hub owns enrollment, STOP/START, turns,
 * delivery and per-member named instances. No messages or secrets are stored here.
 */
export function createHostedAgent(config: HostedAgentConfig) {
  const owner = address(config.owner)
  if (!E164.test(owner) && !EMAIL.test(owner)) throw new HostedAgentError('owner_not_e164', 'owner must be an E.164 phone number or email address.')
  if (config.id !== undefined && !ID.test(config.id)) throw new HostedAgentError('invalid_id', 'id must be 1-64 letters, digits, underscores or hyphens.')
  const turns = config.freeTurnsPerDay ?? 20
  if (!Number.isInteger(turns) || turns < 1 || turns > 10_000) throw new HostedAgentError('invalid_turn_limit', 'freeTurnsPerDay must be an integer from 1 to 10000.')
  const declared = (config.members ?? []).map(member => ({ ...member, address: address(member.address) }))
  if (declared.length > 49 || new Set([owner, ...declared.map(member => member.address)]).size !== declared.length + 1)
    throw new HostedAgentError('invalid_members', 'Declare at most 49 additional members, without duplicates or the owner.')
  for (const member of declared) {
    if ((!E164.test(member.address) && !EMAIL.test(member.address)) || (member.label !== undefined && (!member.label.trim() || member.label.length > 60)))
      throw new HostedAgentError('invalid_members', 'Each member needs a valid address and an optional label of 1-60 characters.')
  }
  const identity: Readonly<HostedAgentIdentity> = Object.freeze({
    revision: 1,
    id: config.id ?? null,
    clientReference: config.id ? `hosted-agent:${config.id}` : 'hosted-agent',
    instanceKeyPrefix: config.id ? `${PERSON_KEY_PREFIX}${config.id}:` : PERSON_KEY_PREFIX,
  })
  const policy = { ...DEFAULT_BOX_POLICY, ...config.box }
  const sandbox = new Sandbox({ apiKey: config.apiKey, baseUrl: config.sandboxUrl ?? 'https://sandbox.tangle.tools', timeoutMs: 20_000 })
  const backend: BackendConfig = { ...(config.harness ? { type: config.harness as BackendConfig['type'] } : {}), profile: conversationProfile(config.profile) }
  const create: LineInstanceCreate = {
    name: 'hosted-person',
    resources: { cpuCores: policy.cpuCores, memoryMB: policy.memoryMB, diskGB: policy.diskGB },
    egressPolicy: { mode: 'strict', allowDomains: policy.allowDomains, includeImplicitDomains: false },
    idleTimeoutSeconds: policy.idleTimeoutSeconds, maxLifetimeSeconds: policy.maxLifetimeSeconds,
    deleteAfterStoppedSeconds: policy.deleteAfterStoppedSeconds,
  }

  return {
    identity,
    /**
     * Attach one owned connection. Personal mode admits only the owner. Shared
     * mode gives every declared or admitted member a private instance and thread.
     * A named assistant's instance namespace and attachment reference are stable
     * across retries and releases, but distinct from every other assistant.
     * Existing attachments with different configuration are never detached here.
     */
    async attachLine(connectionId: string, options: HostedLineOptions = {}): Promise<Line> {
      const transport = options.transport ?? 'imessage'
      const mode = options.mode ?? 'shared'
      const unknownSenders = options.unknownSenders ?? (mode === 'shared' && transport !== 'email' ? 'guest' : 'reject')
      const matches = transport === 'email' ? EMAIL : E164
      if (![owner, ...declared.map(member => member.address)].every(value => matches.test(value)))
        throw new HostedAgentError('owner_transport_mismatch', `${transport} lines require ${transport === 'email' ? 'email' : 'E.164'} member addresses.`)
      if (mode === 'personal' && (declared.length > 0 || unknownSenders !== 'reject'))
        throw new HostedAgentError('personal_owner_only', 'Personal lines admit the owner only.')
      if (transport === 'email' && unknownSenders !== 'reject')
        throw new HostedAgentError('email_declared_members_only', 'Email lines require declared members and reject unknown senders.')
      if (transport === 'whatsapp' && !options.phoneNumberId)
        throw new HostedAgentError('phone_number_required', 'WhatsApp lines require phoneNumberId.')
      if (transport !== 'whatsapp' && options.phoneNumberId)
        throw new HostedAgentError('phone_number_not_allowed', 'phoneNumberId is only valid for WhatsApp lines.')
      if (options.voice && transport !== 'imessage')
        throw new HostedAgentError('voice_transport_unsupported', 'Voice is supported only on iMessage lines.')
      // A connection may own several WhatsApp numbers. Creation references must
      // distinguish those resources without putting private addresses in refs.
      const clientReference = config.id
        ? `${identity.clientReference}:${await digest(JSON.stringify([connectionId, transport, options.phoneNumberId ?? null]))}`
        : identity.clientReference
      const line = await sandbox.lines.fromConnection(
        transport === 'whatsapp'
          ? { connectionId, transport, phoneNumberId: options.phoneNumberId!, clientReference }
          : { connectionId, transport, clientReference },
      )
      if (config.id && line.attachment?.status === 'active' && line.attachment.clientReference !== identity.clientReference)
        throw new HostedAgentError('line_attached_elsewhere', 'Detach the existing attachment explicitly before assigning this line to another assistant.')
      await sandbox.lines.attach({
        number: line.id,
        mode,
        members: [{ address: owner, role: 'owner' }, ...declared.map(member => ({ ...member, role: 'member' }))],
        unknownSenders,
        roles: mode === 'shared' ? { owner: PERSON, member: PERSON, guest: PERSON } : { owner: PERSON },
        respond: { kind: 'agent', backend },
        limits: { turnsPerMemberPerDay: turns },
        instance: { keyPrefix: identity.instanceKeyPrefix, create },
        clientReference: identity.clientReference,
      })
      if (options.voice) await sandbox.lines.enableVoice(line.id, options.voice)
      return sandbox.lines.get(line.id)
    },
  }
}

export type HostedAgent = ReturnType<typeof createHostedAgent>
