import type { AgentProfile, BackendConfig, SandboxInstance } from '@tangle-network/sandbox'
import { InstanceRestartingError, type LineAttachment, type LineInstanceCreate, lineInstanceKey, Sandbox } from '@tangle-network/sandbox/core'
import { runHostedTurn, TurnPending } from './engine'

export * from './engine'

/**
 * A hosted agent: people text or call a line, and each person is answered
 * from their own isolated sandbox. The developer's Tangle API key pays for
 * every box, model turn and reply.
 *
 * The platform does the work. {@link HostedAgent.attachLine} attaches the
 * line to Tangle Hub with one sandbox per person: Hub routes each text to the
 * sender's box (the named instance {@link PERSON_KEY_PREFIX} plus a hash of
 * their number), keeps one thread per person, handles STOP and START, counts
 * each person's texts per day, and sends the reply. A call through ph0ny runs
 * in the same box and the same thread, so text and voice share one memory.
 */

/** Durable key-value storage for voice call tokens. A Cloudflare KV namespace satisfies it. */
export interface HostedAgentStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

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
  /** Voice call tokens. Required for `voiceHook` and `voiceAsk`. */
  store?: HostedAgentStore
  /** Shared secret for the ph0ny call hook and `ask_workspace` webhook tool. */
  voiceSecret?: string
  /** How long one `ask_workspace` call may wait before it returns a ticket. Default 8 s. */
  voiceBudgetMs?: number
  turnWallCapMs?: number
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

export const DEFAULT_BOX_POLICY: BoxPolicy = {
  cpuCores: 1, memoryMB: 2048, diskGB: 10,
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

/** The profile a person's box runs: the developer's profile over the conversation defaults. */
function conversationProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    model: { ...profile.model, default: profile.model?.default ?? DEFAULT_HOSTED_MODEL },
    // A profile that sets `tools` owns its tool set.
    ...(profile.tools ? {} : {
      tools: Object.fromEntries(CONVERSATION_TOOLS_OFF.map(tool => [tool, false])),
      // The sandbox's preview policy grants the shell unless its permission
      // is denied, so turning the tool off alone leaves the shell in place.
      permissions: { bash: 'deny' as const, ...profile.permissions },
    }),
  }
}

export type AskResult =
  | { state: 'answered'; text: string }
  | { state: 'declined'; reply?: string }
  | { state: 'pending' }

/** Each person runs in their own box, so no member shares a disk and each may use the persona's tools. */
const PERSON = { context: 'own', tools: 'act' } as const
const CALL_TTL_MS = 2 * 3_600_000
const E164 = /^\+[1-9]\d{6,14}$/
const encode = (text: string) => new TextEncoder().encode(text)
const sha256 = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
/** Compares digests, so the time taken reveals nothing about the secret. */
async function equal(given: string | null | undefined, expected: string): Promise<boolean> {
  if (!given) return false
  const [a, b] = await Promise.all([sha256(given), sha256(expected)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
/** 43 url-safe characters from 32 random bytes. */
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64 = (text: string) => btoa(String.fromCharCode(...encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const json = (body: unknown, status = 200) => Response.json(body, { status })
const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  .replace(/sk-tan-[\w-]+|Bearer\s+\S+/g, '<redacted>').slice(0, 400)

export class HostedAgentError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HostedAgentError' }
}

/** A call admitted by `voiceHook`: the caller's number and, once found, their text thread's session. */
interface Call { phone: string; exp: number; session?: string }

export function createHostedAgent(config: HostedAgentConfig) {
  const policy = { ...DEFAULT_BOX_POLICY, ...config.box }
  const wallCapMs = config.turnWallCapMs ?? 120_000
  const sandbox = new Sandbox({ apiKey: config.apiKey, baseUrl: config.sandboxUrl ?? 'https://sandbox.tangle.tools', timeoutMs: 20_000 })
  if (!E164.test(config.owner)) throw new HostedAgentError('owner_not_e164', 'owner must be an E.164 phone number, such as +15550100001.')
  const backend: BackendConfig = { ...(config.harness ? { type: config.harness as BackendConfig['type'] } : {}), profile: conversationProfile(config.profile) }
  const create: LineInstanceCreate = {
    name: 'hosted-person',
    resources: { cpuCores: policy.cpuCores, memoryMB: policy.memoryMB, diskGB: policy.diskGB },
    egressPolicy: { mode: 'strict', allowDomains: policy.allowDomains, includeImplicitDomains: false },
    idleTimeoutSeconds: policy.idleTimeoutSeconds, maxLifetimeSeconds: policy.maxLifetimeSeconds,
    deleteAfterStoppedSeconds: policy.deleteAfterStoppedSeconds,
  }

  /** The caller's running box: the instance Hub runs their texts in. Null when the deadline passed while it starts. */
  async function personBox(phone: string, deadline: number): Promise<SandboxInstance | null> {
    let box: SandboxInstance
    try {
      ({ box } = await sandbox.instances.ensure({ key: await lineInstanceKey(PERSON_KEY_PREFIX, phone),
        create: { ...create, secrets: [], sshEnabled: false } }))
    } catch (error) {
      // The platform replaces a box that keeps failing to start; until then the turn waits.
      if (error instanceof InstanceRestartingError) throw new TurnPending('box_restarting', true)
      throw error
    }
    if (box.status === 'running') return box
    const timeoutMs = deadline - Date.now()
    if (timeoutMs < 1000) return null
    try {
      return await sandbox.waitForRunning(box.id, { timeoutMs })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') return null
      throw error
    }
  }

  /** The session of the caller's text thread, so a call continues the conversation; a caller who never texted gets their own. */
  async function callSession(phone: string): Promise<string> {
    for (const line of await sandbox.lines.list()) {
      if (line.attachment?.instance?.keyPrefix !== PERSON_KEY_PREFIX) continue
      const member = (await sandbox.lines.members(line.id).list()).find(m => m.address === phone)
      const thread = member && (await sandbox.lines.threads(line.id).list()).find(t => t.memberId === member.id)
      if (thread) return thread.sessionId
    }
    return `voice-${(await sha256(phone)).slice(0, 32)}`
  }

  /** Answer one spoken question in the caller's box until it answers or `deadline`. */
  async function answerCall(call: Call, text: string, turnId: string, deadline: number): Promise<AskResult> {
    const outcome = await runHostedTurn({ turnId, text }, {
      // Calls are admitted by `voiceHook`; Hub counts texts.
      admit: async () => null,
      async box() {
        const box = await personBox(call.phone, deadline)
        if (!box) throw new TurnPending('box_starting', true)
        return box
      },
      sessionId: call.session!,
      backend: async () => backend,
      prompt: async () => `[Phone call. Answer in one to three short spoken sentences.]\n${text}`,
      classify: error => error instanceof HostedAgentError ? { ok: false, reason: 'unavailable', detail: error.code } : undefined,
      observe: {
        failure(step, failure) {
          console.error(`[hosted-agent] voice turn=${turnId} step=${step} code=${failure.code} message=${JSON.stringify(failure.message)}`)
        },
      },
    }, { wallCapMs, timeoutMs: 8000, until: deadline })
    if (outcome.ok === true) return { state: 'answered', text: outcome.text }
    // A thrown failure is rethrown, so the caller's retry policy decides it.
    if (outcome.ok === 'pending') {
      if (outcome.cause !== undefined) throw outcome.cause
      return { state: 'pending' }
    }
    const code = outcome.detail ?? outcome.reason
    throw new HostedAgentError(code === 'agent_failed' ? 'turn_failed' : code, `The turn ended without an answer (${code}).`)
  }

  function voiceStore(): HostedAgentStore {
    if (!config.store) throw new HostedAgentError('store_missing', 'voice needs a store for call tokens')
    return config.store
  }

  return {
    /**
     * Attach an Inkbox iMessage identity, connected to Hub under the
     * developer's account, as this agent's line: the owner and anyone who
     * texts it each get their own box and thread. Safe to repeat with the
     * same config. Remove any Hub event subscription on the connection first;
     * Hub refuses a line that another route would also answer.
     */
    async attachLine(connectionId: string): Promise<LineAttachment> {
      const line = await sandbox.lines.fromConnection({ connectionId, transport: 'imessage', clientReference: 'hosted-agent' })
      return sandbox.lines.attach({
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
    },

    /**
     * ph0ny's call hook. `admit` returns a call token bound to the caller's
     * number from the carrier's signed call record, never from the model.
     */
    async voiceHook(request: Request): Promise<Response> {
      const secret = config.voiceSecret
      if (!secret || !await equal(request.headers.get('authorization'), `Bearer ${secret}`)) return json({ error: 'unauthorized' }, 401)
      const body = await request.json().catch(() => null) as { event?: string; phone?: string } | null
      if (body?.event !== 'admit') return json({ ok: true })
      const phone = body.phone?.trim() ?? ''
      if (!E164.test(phone)) return json({ admit: false, say: 'Sorry, I can only take calls from a visible number.' })
      // ph0ny accepts only an opaque token matching ^[A-Za-z0-9_-]{16,128}$,
      // so the caller's number stays here and the token is its random key.
      const callToken = randomToken()
      await voiceStore().put(`vcall:${callToken}`, JSON.stringify({ phone, exp: Date.now() + CALL_TTL_MS } satisfies Call),
        { expirationTtl: CALL_TTL_MS / 1000 })
      return json({ admit: true, callToken })
    },

    /**
     * ph0ny's `ask_workspace` webhook tool, configured with `forwardCallToken`.
     * A slow turn returns a ticket; the voice agent asks again with it.
     */
    async voiceAsk(request: Request): Promise<Response> {
      const secret = config.voiceSecret
      if (!secret || !await equal(request.headers.get('authorization'), `Bearer ${secret}`)) return json({ error: 'unauthorized' }, 401)
      const token = request.headers.get('x-voice-call-token') ?? ''
      const store = voiceStore()
      const admitted = /^[A-Za-z0-9_-]{16,128}$/.test(token) ? await store.get(`vcall:${token}`) : null
      if (!admitted) return json({ status: 'error', error: 'call_not_admitted' }, 403)
      const call = JSON.parse(admitted) as Call
      if (call.exp < Date.now()) return json({ status: 'error', error: 'call_expired' }, 403)
      const body = await request.json().catch(() => null) as { utterance?: string; ticket?: string } | null
      // A ticket carries its own turn id and question, so a retry after a
      // slow first step still settles exactly one turn.
      const [turnId, asked] = body?.ticket ? body.ticket.split('.') : [`v-${crypto.randomUUID()}`, b64(body?.utterance ?? '')]
      if (!turnId || !asked) return json({ status: 'error', error: 'missing_utterance' }, 400)
      try {
        if (!call.session) {
          call.session = await callSession(call.phone)
          await store.put(`vcall:${token}`, JSON.stringify(call), { expirationTtl: Math.max(60, Math.ceil((call.exp - Date.now()) / 1000)) })
        }
        // ph0ny drops the tool call at its own timeout, and resuming an idle
        // box can take longer than the budget. Answer 'pending' at the
        // budget regardless; every step is idempotent by turn id, so the
        // ticket call continues where this one stopped.
        const budgetMs = config.voiceBudgetMs ?? 8000
        const result = await Promise.race([
          answerCall(call, unb64(asked), turnId, Date.now() + budgetMs),
          sleep(budgetMs).then((): AskResult => ({ state: 'pending' })),
        ])
        if (result.state === 'pending') return json({ status: 'pending', ticket: `${turnId}.${asked}` })
        if (result.state === 'declined') return json({ status: 'complete', answer: result.reply ?? 'I cannot answer that right now.' })
        return json({ status: 'complete', answer: result.text })
      } catch (error) {
        console.error(`[hosted-agent] voice turn=${turnId} ${describe(error)}`)
        return json({ status: 'error', error: 'agent_unavailable' }, 502)
      }
    },
  }
}

export type HostedAgent = ReturnType<typeof createHostedAgent>
