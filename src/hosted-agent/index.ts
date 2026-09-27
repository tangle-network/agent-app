import type { AgentProfile, BackendConfig, LineVoiceOptions } from '@tangle-network/sandbox'
import { type Line, type LineInstanceCreate, Sandbox } from '@tangle-network/sandbox/core'

/**
 * A hosted agent assembled over Hub lines. Hub owns admission, STOP/START,
 * per-member threads, sandbox instances, limits and delivery. The developer's
 * Tangle key pays for the work. This kit runs no message loop or scheduler.
 */
export interface HostedAgentConfig {
  apiKey: string
  /** The persona and tools every admitted person's isolated box runs. */
  profile: AgentProfile
  harness?: string
  /** E.164 phone number, or the declared owner's email address. */
  owner: string
  freeTurnsPerDay?: number
  box?: Partial<BoxPolicy>
  sandboxUrl?: string
  /**
   * Explicit instance namespace, only when intentionally sharing retained
   * state across lines or migrating a legacy attachment. New lines otherwise
   * get a namespace derived from their immutable Hub line id.
   */
  instanceKeyPrefix?: string
}

export interface BoxPolicy {
  cpuCores: number
  memoryMB: number
  diskGB: number
  idleTimeoutSeconds: number
  maxLifetimeSeconds: number
  deleteAfterStoppedSeconds: number
  /** Egress allow-list. The default reaches the model router only. */
  allowDomains: string[]
}

/**
 * Two cores and a 2 GB disk cost what one core and 10 GB cost: both bill the
 * platform's hourly floor. A person's box starts OpenCode on their first text
 * and after every idle stop, and that start is CPU-bound: on one core it took
 * 6.1 s after a resume and 8.4 s on a new box, on two cores 3.5 s and 3.4 s
 * (production, 2026-09-24). A disk no larger than the platform's warm seed
 * lets a new person's box be claimed from the warm pool: create took 2.1-2.7 s
 * instead of 5.3-7.0 s (2026-09-25).
 */
export const DEFAULT_BOX_POLICY: BoxPolicy = {
  cpuCores: 2, memoryMB: 2048, diskGB: 2,
  idleTimeoutSeconds: 600, maxLifetimeSeconds: 86_400, deleteAfterStoppedSeconds: 7 * 86_400,
  allowDomains: ['router.tangle.tools'],
}

/**
 * Legacy namespace. Lines created by the earlier kit have clientReference
 * `hosted-agent`; they retain this prefix even after detach/reattach. New
 * lines use `hosted:<line-id>:` so two assistants never share a person's disk
 * by accident. Use the returned attachment's instance.keyPrefix to address
 * its member instances with the Sandbox SDK's lineInstanceKey.
 */
export const PERSON_KEY_PREFIX = 'hosted:'

/**
 * Harness tools a texting or calling assistant does not use. Their
 * descriptions present every turn as coding work: a shell, file search,
 * sub-agents, to-do lists, skills and web fetch. File read, write and edit
 * stay, so a persona can keep notes such as `memory.md`.
 */
export const CONVERSATION_TOOLS_OFF = ['bash', 'glob', 'grep', 'task', 'todowrite', 'webfetch', 'skill'] as const

/**
 * The model for a profile without `model.default`. It gave the most useful
 * on-topic replies among four Router models on the same five texts and calls
 * (2026-09-23), within the latency of the others.
 */
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
const KEY_PREFIX = /^[A-Za-z0-9._:@-]{1,100}$/

export interface HostedAgentLineOptions {
  transport?: 'imessage' | 'email' | 'whatsapp'
  /** Omitted preserves an active attachment's admission policy. New email lines default to personal; new phone lines to shared. */
  mode?: 'personal' | 'shared'
  /** Required only for WhatsApp: one connection can own several numbers. */
  phoneNumberId?: string
  voice?: LineVoiceOptions
}

export class HostedAgentError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HostedAgentError' }
}

export function createHostedAgent(config: HostedAgentConfig) {
  if (config.owner.length > 320 || (!E164.test(config.owner) && !EMAIL.test(config.owner)))
    throw new HostedAgentError('owner_not_e164', 'owner must be an E.164 phone number or email address.')
  if (config.instanceKeyPrefix !== undefined && !KEY_PREFIX.test(config.instanceKeyPrefix))
    throw new HostedAgentError('invalid_instance_prefix', 'instanceKeyPrefix must be 1-100 letters, digits or . _ : @ - characters.')
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
    /**
     * Attach an owned Inkbox iMessage identity, Inkbox mailbox, or Linq
     * WhatsApp number. Hub deduplicates iMessage/email by connection and
     * transport, and WhatsApp by connection, transport and owned number id.
     * Its unique indexes and insert-race recovery enforce that identity even
     * without a clientReference. A global reference would prevent a second
     * line; inventing a new reference would conflict with legacy WhatsApp lines.
     *
     * New phone shared mode admits guests into isolated boxes. New email
     * lines admit declared members only. Omit mode to keep an active line's
     * mode, roles and unknown-sender policy unchanged. Changing an existing
     * policy is an explicit detach/attach migration, never a setup side effect.
     * Hub remains authoritative if an old policy is no longer supported.
     *
     * Repeating the same attachment is idempotent. Changed profiles or
     * policies require an explicit detach. Existing Hub event subscriptions
     * that would also answer must be explicitly removed by their owner.
     * This call never removes them or rewrites an existing attachment.
     */
    async attachLine(connectionId: string, options: HostedAgentLineOptions = {}): Promise<Line> {
      const transport = options.transport ?? 'imessage'
      if (!['imessage', 'email', 'whatsapp'].includes(transport) ||
          (options.mode !== undefined && !['personal', 'shared'].includes(options.mode)))
        throw new HostedAgentError('unsupported_line_options', 'Unsupported line transport or mode.')
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
          ? { connectionId, transport, phoneNumberId: options.phoneNumberId! }
          : { connectionId, transport },
      )
      const retained = options.mode === undefined && line.attachment?.status === 'active' ? line.attachment : undefined
      if (retained?.unknownSenders === 'onboard')
        throw new HostedAgentError('line_policy_migration_required', 'This line uses onboard admission. Manage it through Hub; the hosted-agent kit will not replace its policy.')
      const mode = options.mode ?? retained?.mode ?? (transport === 'email' ? 'personal' : 'shared')
      const keyPrefix = config.instanceKeyPrefix
        ?? line.attachment?.instance?.keyPrefix
        ?? (line.clientReference === 'hosted-agent' ? PERSON_KEY_PREFIX : `${PERSON_KEY_PREFIX}${line.id}:`)
      const guests = mode === 'shared' && transport !== 'email'
      await sandbox.lines.attach({
        number: line.id,
        mode,
        members: [{ address: config.owner, role: 'owner' }],
        unknownSenders: retained?.unknownSenders ?? (guests ? 'guest' : 'reject'),
        roles: retained?.roles ?? (guests ? { owner: PERSON, guest: PERSON } : { owner: PERSON }),
        respond: { kind: 'agent', backend },
        limits: { turnsPerMemberPerDay: config.freeTurnsPerDay ?? 20 },
        instance: { keyPrefix, create },
        clientReference: 'hosted-agent',
      })
      if (options.voice) await sandbox.lines.enableVoice(line.id, options.voice)
      return sandbox.lines.get(line.id)
    },
  }
}

export type HostedAgent = ReturnType<typeof createHostedAgent>
