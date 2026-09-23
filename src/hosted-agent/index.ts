import { authenticateHubEventRequest, HubClient, type HubProviderEvent } from '@tangle-network/hub-sdk'
import { buildMessagingReply, normalizeConversationEvent } from '@tangle-network/agent-integrations/conversation-events'
import type { AgentProfile, BackendConfig, SandboxInstance } from '@tangle-network/sandbox'
import { Sandbox } from '@tangle-network/sandbox/core'

/**
 * A hosted agent: a person texts or calls a line, and the agent answers from
 * that person's own isolated sandbox. The developer's Tangle API key pays for
 * every box, model turn and reply.
 *
 * Each person gets one fresh isolated box built from the published profile,
 * never a copy of the developer's box. Later messages resume the same box and
 * the same conversation, so text and voice share one memory. A box the
 * platform deleted is replaced by a fresh one instead of blocking the person.
 *
 * Every step is idempotent by the message's turn id: a retried delivery
 * settles the same sandbox turn and replays the same Hub send. So the caller
 * may retry any failure, and needs no dedupe table.
 */

/** Durable key-value storage. A Cloudflare KV namespace satisfies it. */
export interface HostedAgentStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export type HostedChannel = 'imessage' | 'voice'

export interface HostedMessage {
  /** The sender's address as the channel delivered it: E.164 for a phone. */
  userId: string
  channel: HostedChannel
  text: string
  /** Stable per logical message. Reusing it settles the same turn. */
  turnId: string
}

/** What the allowance hook decides for one new message. */
export type Allowance = 'answer' | 'ignore' | { reply: string }

export interface HostedAgentConfig {
  /** The developer's Tangle API key (Sandbox and Hub). */
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
  store: HostedAgentStore
  /** Answers per person per UTC day before `allow` must decide. Default 20. */
  freeTurnsPerDay?: number
  /**
   * Decide a new message after the free allowance is used, for example reply
   * with a checkout link. Without it, a person past the allowance is told to
   * come back tomorrow. Retries of an admitted message never reach this hook.
   */
  allow?: (message: HostedMessage, usedToday: number) => Allowance | Promise<Allowance>
  /** Shared secret for the ph0ny call hook and `ask_workspace` webhook tool. */
  voiceSecret?: string
  /** How long one `ask_workspace` call may wait before it returns a ticket. Default 8 s. */
  voiceBudgetMs?: number
  box?: Partial<BoxPolicy>
  turnWallCapMs?: number
  sandboxUrl?: string
  hubUrl?: string
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

/** A Hub delivery that passed authentication, in a form a queue can carry. */
export interface HostedInbound {
  runId: string
  connectionId: string
  event: HubProviderEvent
}

export const NOTICE = {
  stopped: 'You are unsubscribed. Text START to talk again.',
  started: 'Welcome back. Text me anytime. Reply STOP to stop.',
  limit: 'You have used today\'s free messages. Talk tomorrow!',
  unavailable: 'Sorry, I could not answer that just now. Please try again in a minute.',
} as const

const IMESSAGE_EVENT = 'inkbox.imessage.received'
const IMESSAGE_REPLY = 'inkbox.imessage.reply'
const STOP = /^(stop|stopall|unsubscribe|cancel|end|quit)$/i
const START = /^(start|unstop|resume)$/i
const TWO_DAYS = 2 * 86_400
const RESUMABLE = new Set(['stopped', 'expired'])
const GONE = new Set(['failed', 'deleted'])

const encode = (text: string) => new TextEncoder().encode(text)
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
const sha256 = async (value: string) => hex(await crypto.subtle.digest('SHA-256', encode(value)))
/** Compares digests, so the time taken reveals nothing about the secret. */
async function equal(given: string | null | undefined, expected: string): Promise<boolean> {
  if (!given) return false
  const [a, b] = await Promise.all([sha256(given), sha256(expected)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
const CALL_TTL_MS = 2 * 3_600_000
/** 43 url-safe characters from 32 random bytes. */
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64 = (text: string) => btoa(String.fromCharCode(...encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const json = (body: unknown, status = 200) => Response.json(body, { status })
const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  .replace(/sk-tan-[\w-]+|Bearer\s+\S+/g, '<redacted>').slice(0, 400)

/** One address per person: E.164 for anything phone-shaped, else lowercase. */
export function normalizeAddress(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.includes('@')) return trimmed.toLowerCase()
  const digits = trimmed.replace(/[^\d]/g, '')
  if (digits.length < 8 || digits.length > 15) return null
  return `+${digits.length === 10 && !trimmed.startsWith('+') ? `1${digits}` : digits}`
}

export class HostedAgentError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HostedAgentError' }
}

export function createHostedAgent(config: HostedAgentConfig) {
  const store = config.store
  const policy = { ...DEFAULT_BOX_POLICY, ...config.box }
  const wallCapMs = config.turnWallCapMs ?? 120_000
  const sandbox = new Sandbox({ apiKey: config.apiKey, baseUrl: config.sandboxUrl ?? 'https://sandbox.tangle.tools', timeoutMs: 20_000 })
  const hub = new HubClient({ baseUrl: config.hubUrl ?? 'https://id.tangle.tools', apiKey: config.apiKey })
  const profile = conversationProfile(config.profile)
  const backend: BackendConfig = { ...(config.harness ? { type: config.harness as BackendConfig['type'] } : {}), profile }
  const profileTag = sha256(JSON.stringify(profile)).then(hash => hash.slice(0, 8))

  /** The person's running box: created on the first message, resumed later,
   *  replaced when the platform deleted it. Null when the deadline passed. */
  async function ensureBox(user: string, deadline: number): Promise<SandboxInstance | null> {
    const key = `box:${user}`
    const known = await store.get(key)
    let box = known ? await sandbox.get(known) : null
    if (!box || GONE.has(box.status)) {
      // The key names the box it replaces, so concurrent first messages and
      // retries converge on one allocation instead of each creating a box.
      box = await sandbox.createIsolated({
        name: `hosted-${user.slice(0, 24)}`, idempotencyKey: known ? `hosted-${user}-after-${known}` : `hosted-${user}`,
        resources: { cpuCores: policy.cpuCores, memoryMB: policy.memoryMB, diskGB: policy.diskGB },
        backend, secrets: [], sshEnabled: false,
        egressPolicy: { mode: 'strict', allowDomains: policy.allowDomains, includeImplicitDomains: false },
        idleTimeoutSeconds: policy.idleTimeoutSeconds, maxLifetimeSeconds: policy.maxLifetimeSeconds,
        deleteAfterStoppedSeconds: policy.deleteAfterStoppedSeconds, metadata: { hostedUser: user },
      })
      await store.put(key, box.id)
    }
    if (RESUMABLE.has(box.status)) await box.resume()
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

  /** Admit a new message once: STOP/START, the free allowance, then `allow`. */
  async function admit(message: HostedMessage, user: string): Promise<Allowance> {
    const stopKey = `stop:${user}`
    if (message.channel !== 'voice' && STOP.test(message.text.trim())) { await store.put(stopKey, '1'); return { reply: NOTICE.stopped } }
    if (message.channel !== 'voice' && START.test(message.text.trim())) { await store.put(stopKey, ''); return { reply: NOTICE.started } }
    if (await store.get(stopKey)) return 'ignore'
    const dayKey = `turns:${user}:${new Date().toISOString().slice(0, 10)}`
    // KV has no atomic increment, so concurrent messages may overshoot the
    // allowance by a few; the sponsor key's budget is the hard ceiling.
    const used = Number(await store.get(dayKey) ?? 0)
    const decision = used < (config.freeTurnsPerDay ?? 20) ? 'answer'
      : config.allow ? await config.allow(message, used) : { reply: NOTICE.limit }
    if (decision === 'answer') await store.put(dayKey, String(used + 1), { expirationTtl: TWO_DAYS })
    return decision
  }

  /** Run one message in the person's box until it answers or `deadline`. */
  async function ask(message: HostedMessage, options: { deadline: number }): Promise<AskResult> {
    const text = message.text.trim()
    if (!text || text.length > 8000 || !/^[\w-]{1,120}$/.test(message.turnId)) return { state: 'declined' }
    const user = (await sha256(message.userId)).slice(0, 32)
    // Scoped to the person: a voice ticket is model-supplied, so a turn id
    // admitted for one person must not skip another person's allowance.
    const admittedKey = `turn:${user}:${message.turnId}`
    if (!await store.get(admittedKey)) {
      const decision = await admit(message, user)
      if (decision === 'ignore') return { state: 'declined' }
      if (decision !== 'answer') return { state: 'declined', reply: decision.reply }
      await store.put(admittedKey, '1', { expirationTtl: TWO_DAYS })
    }
    const box = await ensureBox(user, options.deadline)
    if (!box) return { state: 'pending' }
    // A session binds its backend when created, and the runtime would give a
    // bare session its generic default assistant. A new profile starts a new
    // conversation, so the persona always matches the one in force.
    const sessionId = `hosted-${user}-${await profileTag}`
    if (!await box.session(sessionId).status()) await box.createSession({ sessionId, retention: 'workspace', backend })
    const prompt = message.channel === 'voice' ? `[Phone call. Answer in one to three short spoken sentences.]\n${text}` : text
    for (;;) {
      const result = await box.driveConversationTurn(prompt, { sessionId, turnId: message.turnId, wallCapMs, timeoutMs: 8000 })
      if (result.state === 'completed') {
        const answer = result.text.trim()
        if (!answer) throw new HostedAgentError('empty_reply', 'The turn completed with no reply text.')
        return { state: 'answered', text: answer }
      }
      if (result.state === 'failed') throw new HostedAgentError('turn_failed', result.error)
      if (Date.now() + 2000 > options.deadline) return { state: 'pending' }
      await sleep(2000)
    }
  }

  return {
    ask,

    /**
     * One-time setup: route an Inkbox iMessage identity's messages, connected
     * to Hub under the developer's account, to `callbackUrl`, and allow the
     * one reply action on that connection. Safe to repeat.
     */
    async connect(input: { connectionId: string; identityId: string; callbackUrl: string; secret: string }) {
      const webhook = await hub.connections.inboundWebhook.get(input.connectionId)
      if (!webhook.configured) await hub.connections.inboundWebhook.create(input.connectionId, { identityId: input.identityId, imessage: true })
      await hub.permissions.set({ connectionId: input.connectionId, actionPath: IMESSAGE_REPLY, decision: 'allow' })
      const { subscription } = await hub.eventSubscriptions.create({
        clientReference: `hosted-agent:${input.connectionId}`, label: 'Hosted agent messages',
        source: { type: 'connection', connectionId: input.connectionId }, event: IMESSAGE_EVENT,
        callback: { url: input.callbackUrl, secret: input.secret },
      })
      return subscription
    },

    /** The Hub callback. Authenticates within Hub's 10 s budget and runs nothing. */
    async receive(request: Request, secret: string): Promise<{ response: Response; inbound?: HostedInbound }> {
      const authenticated = await authenticateHubEventRequest({ request, secret, maxBodyBytes: 64 * 1024 })
      if (!authenticated.ok) return { response: authenticated.response }
      const { runId, source, providerEvent } = authenticated.delivery
      const ack = new Response(null, { status: 204 })
      if (source.kind !== 'connection' || source.event !== IMESSAGE_EVENT || providerEvent.connectionId !== source.id) return { response: ack }
      return { response: ack, inbound: { runId, connectionId: source.id, event: providerEvent } }
    },

    /**
     * Answer one inbound message and send the reply through Hub. Returns
     * 'pending' while the turn still runs; call again with the same inbound.
     * On `lastAttempt`, a failure is answered with an apology instead of thrown.
     */
    async respond(inbound: HostedInbound, options: { lastAttempt?: boolean } = {}): Promise<'replied' | 'ignored' | 'pending'> {
      const normalized = normalizeConversationEvent(inbound.event)
      if (!normalized.ok) return 'ignored'
      const event = normalized.event
      const userId = normalizeAddress(event.sender.id ?? '')
      if (!userId || !event.text?.trim() || event.isGroup || event.historyOnly) return 'ignored'
      const turnId = `t-${(await sha256(inbound.runId)).slice(0, 40)}`
      let text: string
      try {
        const result = await ask({ userId, channel: 'imessage', text: event.text, turnId },
          { deadline: Date.now() + wallCapMs + 60_000 })
        if (result.state === 'pending') return 'pending'
        if (result.state === 'declined' && !result.reply) return 'ignored'
        text = result.state === 'answered' ? result.text : result.reply!
      } catch (error) {
        // A failed turn fails the same way on every retry; anything else may clear.
        if (!(error instanceof HostedAgentError) && !options.lastAttempt) throw error
        console.error(`[hosted-agent] turn=${turnId} ${describe(error)}`)
        text = NOTICE.unavailable
      }
      const plan = buildMessagingReply(inbound.event, text.slice(0, 1500), `reply-${turnId}`)
      if (!plan.ok) return 'ignored'
      // Hub replays the first result for a retry with this key and input.
      await hub.tools.invoke(plan.reply.action, plan.reply.input, { connectionId: inbound.connectionId, idempotencyKey: plan.reply.idempotencyKey })
      return 'replied'
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
      const phone = normalizeAddress(body.phone ?? '')
      if (!phone?.startsWith('+')) return json({ admit: false, say: 'Sorry, I can only take calls from a visible number.' })
      if (await store.get(`stop:${(await sha256(phone)).slice(0, 32)}`)) return json({ admit: false, say: 'You unsubscribed from this line.' })
      // ph0ny accepts only an opaque token matching ^[A-Za-z0-9_-]{16,128}$,
      // so the caller's number stays here and the token is its random key.
      const callToken = randomToken()
      await store.put(`vcall:${callToken}`, JSON.stringify({ phone, exp: Date.now() + CALL_TTL_MS }), { expirationTtl: CALL_TTL_MS / 1000 })
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
      const admitted = /^[A-Za-z0-9_-]{16,128}$/.test(token) ? await store.get(`vcall:${token}`) : null
      if (!admitted) return json({ status: 'error', error: 'call_not_admitted' }, 403)
      const call = JSON.parse(admitted) as { phone: string; exp: number }
      if (call.exp < Date.now()) return json({ status: 'error', error: 'call_expired' }, 403)
      const body = await request.json().catch(() => null) as { utterance?: string; ticket?: string } | null
      // A ticket carries its own turn id and question, so a retry after a
      // slow first step still admits and settles exactly one turn.
      const [turnId, asked] = body?.ticket ? body.ticket.split('.') : [`v-${crypto.randomUUID()}`, b64(body?.utterance ?? '')]
      if (!turnId || !asked) return json({ status: 'error', error: 'missing_utterance' }, 400)
      try {
        // ph0ny drops the tool call at its own timeout, and resuming an idle
        // box can take longer than the budget. Answer 'pending' at the
        // budget regardless; every step is idempotent by turn id, so the
        // ticket call continues where this one stopped.
        const budgetMs = config.voiceBudgetMs ?? 8000
        const result = await Promise.race([
          ask({ userId: call.phone, channel: 'voice', text: unb64(asked), turnId }, { deadline: Date.now() + budgetMs }),
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
