import type { AgentProfile, BackendConfig, LineVoiceOptions } from '@tangle-network/sandbox'
import { type Line, type LineInstanceCreate, Sandbox } from '@tangle-network/sandbox/core'
import { withDefaultAgentHome } from '../profile/home'

/**
 * A hosted agent: people text or call a line, and each person is answered
 * from their own isolated sandbox. The developer's Tangle API key pays for
 * every box, model turn, reply and call.
 *
 * The platform does the work. {@link HostedAgent.attachLine} attaches the
 * line to Tangle Hub with one sandbox per person: Hub routes each text and
 * call to the person's box (the named instance {@link PERSON_KEY_PREFIX} plus
 * a hash of their number), keeps one thread per person, handles STOP and
 * START, counts each person's texts per day, and sends the reply. A call on
 * the line runs in the same box and thread, so text and voice share one memory.
 */

export interface HostedAgentConfig {
  /** The developer's Tangle API key. */
  apiKey: string
  /**
   * The persona every person's box runs. A profile without `model.default`
   * runs {@link DEFAULT_HOSTED_MODEL}, and a profile without `tools` runs with
   * {@link CONVERSATION_TOOLS_OFF} turned off. Set `tools` to choose your own,
   * for example on a harness that cannot turn those tools off.
   */
  profile: AgentProfile
  /** Backend harness type, such as `opencode`; the runtime default when omitted. */
  harness?: string
  /** The owner's own phone (E.164), the line's first member. */
  owner: string
  /** Texts Hub answers per person per UTC day. Default 20. */
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
 * Each person's box is the developer's named instance with this prefix. It is
 * the key this kit used before Hub routed its texts, so every existing
 * person keeps their box.
 */
export const PERSON_KEY_PREFIX = 'hosted:'

/**
 * Harness orchestration tools a general hosted assistant does not need by default.
 * Shell/file access, skills and web fetch stay available: the hosted assistant is
 * a general sandbox agent, not a chat-only bot. Products may still provide an
 * explicit `tools` map to narrow or widen this set.
 */
export const CONVERSATION_TOOLS_OFF = ['task', 'todowrite'] as const

/**
 * The model for a profile without `model.default`. It gave the most useful
 * on-topic replies among four Router models on the same five texts and calls
 * (2026-09-23), within the latency of the others.
 */
export const DEFAULT_HOSTED_MODEL = 'openai/gpt-5.6-luna'

/** The profile a person's box runs: the developer's profile over the conversation defaults. */
function conversationProfile(profile: AgentProfile): AgentProfile {
  const homed = withDefaultAgentHome(profile)
  return {
    ...homed,
    model: { ...homed.model, default: homed.model?.default ?? DEFAULT_HOSTED_MODEL },
    // A profile that sets `tools` owns its tool set.
    ...(homed.tools ? {} : {
      tools: Object.fromEntries(CONVERSATION_TOOLS_OFF.map(tool => [tool, false])),
      permissions: { ...homed.permissions },
    }),
  }
}

/** Each person runs in their own box, so no member shares a disk and each may use the persona's tools. */
const PERSON = { context: 'own', tools: 'act' } as const
const E164 = /^\+[1-9]\d{6,14}$/

export class HostedAgentError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HostedAgentError' }
}

export function createHostedAgent(config: HostedAgentConfig) {
  if (!E164.test(config.owner)) throw new HostedAgentError('owner_not_e164', 'owner must be an E.164 phone number, such as +15550100001.')
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
     * Attach an Inkbox iMessage identity, connected to Hub under the
     * developer's account, as this agent's line: the owner and anyone who
     * texts it each get their own box and thread. With `voice`, calls to the
     * line reach the caller's box and thread through that ph0ny agent; Hub
     * admits only members, so a caller texts once before calling. Safe to
     * repeat with the same config. Hub refuses a changed profile, box or
     * limit on an attached line: detach it first
     * (`DELETE /v1/lines/:id/attachment`). Each person keeps their box and
     * its memory, and their thread starts over. Remove any Hub event
     * subscription on the connection first; Hub refuses a line that another
     * route would also answer.
     */
    async attachLine(connectionId: string, options: { voice?: LineVoiceOptions } = {}): Promise<Line> {
      const line = await sandbox.lines.fromConnection({ connectionId, transport: 'imessage', clientReference: 'hosted-agent' })
      await sandbox.lines.attach({
        number: line.id,
        mode: 'shared',
        members: [{ address: config.owner, role: 'owner' }],
        unknownSenders: 'guest',
        roles: { owner: PERSON, guest: PERSON },
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

export { defaultHomeFiles, DEFAULT_HOME_LIMITS } from "../profile/home"
