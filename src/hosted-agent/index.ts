import type { AgentProfile, BackendConfig, LineVoiceOptions } from '@tangle-network/sandbox'
import { type Line, type LineInstanceCreate, Sandbox } from '@tangle-network/sandbox/core'

/**
 * The existing public conversation kit. Each person has an isolated sandbox.
 * This compatibility API is not the role-governed general-agent provisioning
 * path. Use createTangleAgent or the tangle-agent command for Tangle agent v1.
 * Hub owns routing, consent, metering, and text/voice delivery in both paths.
 */
export interface HostedAgentConfig {
  apiKey: string
  /** A conversation profile. General agents use the explicit role-policy API. */
  profile: AgentProfile
  harness?: string
  /** E.164 for iMessage/WhatsApp, email address for an email line. */
  owner: string
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
export const PERSON_KEY_PREFIX = 'hosted:'

/** Legacy conversation defaults only. The general role policy does not use this list. */
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

const OWNER = { context: 'own', tools: 'act' } as const
// An unsolicited guest must never inherit the owner's explicit tools, MCP,
// files, connections or hooks. Hub enforces the existing chat-only boundary.
const GUEST = { context: 'own', tools: 'chat' } as const
const E164 = /^\+[1-9]\d{6,14}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class HostedAgentError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HostedAgentError' }
}

export function createHostedAgent(config: HostedAgentConfig) {
  if (!E164.test(config.owner) && !EMAIL.test(config.owner)) {
    throw new HostedAgentError('owner_not_e164', 'owner must be an E.164 phone number or email address.')
  }
  const policy = { ...DEFAULT_BOX_POLICY, ...config.box }
  const sandbox = new Sandbox({ apiKey: config.apiKey, baseUrl: config.sandboxUrl ?? 'https://sandbox.tangle.tools', timeoutMs: 20_000 })
  const backend: BackendConfig = {
    ...(config.harness ? { type: config.harness as BackendConfig['type'] } : {}),
    profile: conversationProfile(config.profile),
  }
  const create: LineInstanceCreate = {
    name: 'hosted-person',
    resources: { cpuCores: policy.cpuCores, memoryMB: policy.memoryMB, diskGB: policy.diskGB },
    egressPolicy: { mode: 'strict', allowDomains: policy.allowDomains, includeImplicitDomains: false },
    idleTimeoutSeconds: policy.idleTimeoutSeconds, maxLifetimeSeconds: policy.maxLifetimeSeconds,
    deleteAfterStoppedSeconds: policy.deleteAfterStoppedSeconds,
  }
  return {
    /**
     * Preserve the complete legacy transport API: Inkbox iMessage/email and
     * Linq WhatsApp, plus personal/shared mode and iMessage voice. Repeating
     * the same attachment is idempotent. This never silently detaches a line.
     */
    async attachLine(connectionId: string, options: {
      transport?: 'imessage' | 'email' | 'whatsapp'
      mode?: 'personal' | 'shared'
      phoneNumberId?: string
      voice?: LineVoiceOptions
    } = {}): Promise<Line> {
      const transport = options.transport ?? 'imessage'
      const mode = options.mode ?? 'shared'
      if (transport === 'email' && !EMAIL.test(config.owner))
        throw new HostedAgentError('owner_transport_mismatch', 'email lines require an email owner address.')
      if (transport !== 'email' && !E164.test(config.owner))
        throw new HostedAgentError('owner_transport_mismatch', `${transport} lines require an E.164 owner address.`)
      if (transport === 'whatsapp' && !options.phoneNumberId)
        throw new HostedAgentError('phone_number_required', 'WhatsApp lines require phoneNumberId.')
      if (transport !== 'whatsapp' && options.phoneNumberId)
        throw new HostedAgentError('phone_number_not_allowed', 'phoneNumberId is only valid for WhatsApp lines.')
      if (options.voice && transport !== 'imessage')
        throw new HostedAgentError('voice_transport_unsupported', 'Voice is supported only on iMessage lines.')
      const line = await sandbox.lines.fromConnection(
        transport === 'whatsapp'
          ? { connectionId, transport, phoneNumberId: options.phoneNumberId!, clientReference: 'hosted-agent' }
          : { connectionId, transport, clientReference: 'hosted-agent' },
      )
      await sandbox.lines.attach({
        number: line.id,
        mode,
        members: [{ address: config.owner, role: 'owner' }],
        unknownSenders: mode === 'shared' ? 'guest' : 'reject',
        roles: mode === 'shared' ? { owner: OWNER, guest: GUEST } : { owner: OWNER },
        respond: { kind: 'agent', backend },
        limits: { turnsPerMemberPerDay: config.freeTurnsPerDay ?? 20 },
        instance: { keyPrefix: PERSON_KEY_PREFIX, create },
        clientReference: 'hosted-agent',
      })
      if (options.voice) await sandbox.lines.enableVoice(line.id, options.voice)
      return sandbox.lines.get(line.id)
    },
  }
}

export type HostedAgent = ReturnType<typeof createHostedAgent>
export { buildGeneralAgentProfile, createTangleAgent, GENERAL_AGENT_MODEL, GENERAL_AGENT_SYSTEM_PROMPT } from './general'
export type { GeneralAgentProfileOptions, GeneralAgentMember, TangleAgentOptions } from './general'
export { agentHomeWorkflows } from './workflows'
export type { AgentHomeWorkflowOptions, AgentHomeWorkflow } from './workflows'
export { defaultHomeFiles, DEFAULT_HOME_LIMITS, DEFAULT_AGENT_HOME, withDefaultAgentHome } from '../profile/home'
