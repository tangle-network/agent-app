import { authenticateHubEventRequest, HubClient, type HubProviderEvent } from '@tangle-network/hub-sdk'
import { buildMessagingReply, normalizeConversationEvent } from '@tangle-network/agent-integrations/conversation-events'
import type { AgentProfile, BackendConfig, SandboxInstance } from '@tangle-network/sandbox'
import { InstanceRestartingError, Sandbox } from '@tangle-network/sandbox/core'
import { runHostedTurn, TurnPending } from './engine'

export * from './engine'

/**
 * A hosted agent: a person texts or calls a line, and the agent answers from
 * that person's own isolated sandbox. The developer's Tangle API key pays for
 * every box, model turn and reply.
 *
 * The platform keeps each person's box and counts their turns: each person
 * is one Sandbox instance (`sandbox.instances`), a fresh isolated box built
 * from the published profile, and one member of a Hub allowance meter.
 * Later messages resume the same box and conversation, so text and voice
 * share one memory. A new profile starts a new session in the same box; a
 * replaced box starts a new one. Either way the person's recent conversation
 * carries over from the store.
 *
 * Every step is idempotent by the message's turn id: a retried delivery
 * settles the same sandbox turn, the same allowance admission and the same
 * Hub send. So the caller may retry any failure, and needs no dedupe table.
 */

/** Durable key-value storage for STOP state, the debug switch, call tokens and recent turns. A Cloudflare KV namespace satisfies it. */
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
  /**
   * The Platform meter that counts this agent's turns (Hub
   * `hub.allowances`). Each person is one member. Default `hosted-agent`.
   */
  meter?: string
  /**
   * Answers per person per UTC day before `allow` must decide. Default 20.
   * Written to the meter's plan when the meter has none; a plan already set
   * on the Platform wins.
   */
  freeTurnsPerDay?: number
  /**
   * Decide a new message past the free allowance when paying would lift the
   * limit (the Platform's `paywall` decision), for example reply with a
   * checkout link. Without it, or past the paid allowance, a person is told to
   * come back tomorrow. Retries of an admitted message never reach this hook.
   */
  allow?: (message: HostedMessage, usedToday: number) => Allowance | Promise<Allowance>
  /**
   * The owner's own address (E.164 phone). Only this sender can text DEBUG ON
   * or DEBUG OFF; while on, each reply to them ends with one ⚙ line naming the
   * harness, model, box, time, tokens, cost and tools of that turn.
   */
  owner?: string
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

/** What one turn reports about itself, for the owner's debug line. A figure
 *  the run did not report stays undefined and is left out of the line. */
export interface TurnTrace {
  /** Time the platform took to hand over the person's running box, such as `box 0.3s`. */
  box?: string
  harness?: string
  model?: string
  /** Sandbox clock: the run's own start to finish. */
  runMs?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  costUsd?: number
  tools?: number
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
  debugOn: 'Debug on. Each reply now ends with a ⚙ line: agent, harness, model, box, time, tokens, cost, tools and turn. Text DEBUG OFF to stop.',
  debugOff: 'Debug off. Replies no longer carry the ⚙ line.',
  stopped: 'You are unsubscribed. Text START to talk again.',
  started: 'Welcome back. Text me anytime. Reply STOP to stop.',
  limit: 'You have used today\'s free messages. Talk tomorrow!',
  unavailable: 'Sorry, I could not answer that just now. Please try again in a minute.',
} as const

const IMESSAGE_EVENT = 'inkbox.imessage.received'
const IMESSAGE_REPLY = 'inkbox.imessage.reply'
const STOP = /^(stop|stopall|unsubscribe|cancel|end|quit)$/i
const START = /^(start|unstop|resume)$/i
/** How much of a person's recent conversation a new session inherits. */
const CARRY_CHARS = 6000
const CARRY_HEAD = '[Your conversation with this person so far. Your instructions may have changed since; follow the current ones.]'
const CARRY_NOW = '[Their new message:]'

/** A person's recent turns, kept outside the box so a new session or box can continue them. */
interface Conversation {
  /** The box and session the turns last ran in. */
  at: string
  /** Oldest first: turn id, what they said, what the agent answered. */
  turns: Array<[string, string, string]>
}

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

/** `true` for DEBUG ON, `false` for DEBUG OFF, `null` for any other text. */
export function debugCommand(text: string): boolean | null {
  const match = /^debug\s+(on|off)$/i.exec(text.trim())
  return match ? match[1]!.toLowerCase() === 'on' : null
}

const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const seconds = (ms: number) => ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`
const count = (n: number) => n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`

/** The owner's ⚙ line. `totalMs` runs from the provider's receipt of the text to now. */
export function debugFooter(agent: string, turnId: string, trace: TurnTrace, totalMs?: number): string {
  const parts = [agent]
  if (trace.harness) parts.push(trace.harness)
  if (trace.model) parts.push(trace.model.split('/').at(-1)!)
  if (trace.box) parts.push(trace.box)
  if (totalMs !== undefined) parts.push(`${seconds(totalMs)}${trace.runMs !== undefined ? ` (run ${seconds(trace.runMs)})` : ''}`)
  else if (trace.runMs !== undefined) parts.push(`run ${seconds(trace.runMs)}`)
  if (trace.inputTokens !== undefined && trace.outputTokens !== undefined) {
    parts.push(`${count(trace.inputTokens)}→${count(trace.outputTokens)} tok${trace.reasoningTokens ? ` (${count(trace.reasoningTokens)} thinking)` : ''}`)
  }
  // Zero on a turn that used tokens means the harness had no price for the model.
  if (trace.costUsd !== undefined && (trace.costUsd > 0 || !trace.outputTokens)) {
    parts.push(trace.costUsd >= 0.01 ? `$${trace.costUsd.toFixed(3)}` : `$${trace.costUsd.toPrecision(2)}`)
  }
  if (trace.tools !== undefined) parts.push(`${trace.tools} tool${trace.tools === 1 ? '' : 's'}`)
  parts.push(turnId.slice(0, 8))
  return `⚙ ${parts.join(' · ')}`
}

/** Model, tokens, cost, tools and run time from a finished turn, as far as it reports them. */
function noteResult(trace: TurnTrace, result: Record<string, unknown>, usage?: { inputTokens?: number; outputTokens?: number }) {
  // A completed turn arrives as the run's own record (`tokenUsage`, `timing`,
  // `toolInvocations`) or as the platform's cached summary (`usage`, `costUsd`).
  // Both count every prompt token; the SDK's typed usage counts only the
  // uncached tail on the summary (3 of 1,214), so it is the fallback. The
  // summary's `durationMs` is not the run time, so that shape has none.
  const reported = (result.tokenUsage ?? result.usage ?? {}) as Record<string, unknown>
  const timing = (result.timing ?? {}) as Record<string, unknown>
  const started = num(timing.startedAt), completed = num(timing.completedAt)
  if (started !== undefined && completed !== undefined) trace.runMs = completed - started
  trace.inputTokens = num(reported.inputTokens) ?? num(usage?.inputTokens)
  trace.outputTokens = num(reported.outputTokens) ?? num(usage?.outputTokens)
  trace.reasoningTokens = num(reported.reasoningTokens)
  if (result.usdKnown !== false) trace.costUsd = num(reported.cost) ?? num(result.costUsd) ?? num(result.totalCostUsd)
  if (Array.isArray(result.toolInvocations)) trace.tools = result.toolInvocations.length
}

export class HostedAgentError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HostedAgentError' }
}

export function createHostedAgent(config: HostedAgentConfig) {
  const store = config.store
  const policy = { ...DEFAULT_BOX_POLICY, ...config.box }
  const wallCapMs = config.turnWallCapMs ?? 120_000
  const sandbox = new Sandbox({ apiKey: config.apiKey, baseUrl: config.sandboxUrl ?? 'https://sandbox.tangle.tools', timeoutMs: 20_000 })
  // The peer range admits older Sandbox minors for other subpaths; named instances arrived in 0.50.
  if (!('instances' in sandbox)) throw new HostedAgentError('sandbox_too_old', 'hosted-agent needs @tangle-network/sandbox 0.50 or later.')
  const hub = new HubClient({ baseUrl: config.hubUrl ?? 'https://id.tangle.tools', apiKey: config.apiKey })
  const profile = conversationProfile(config.profile)
  const backend: BackendConfig = { ...(config.harness ? { type: config.harness as BackendConfig['type'] } : {}), profile }
  const profileTag = sha256(JSON.stringify(profile)).then(hash => hash.slice(0, 8))

  /** The person's running box, kept by the platform. Null when the deadline passed while it starts. */
  async function ensureBox(user: string, deadline: number): Promise<SandboxInstance | null> {
    let box: SandboxInstance
    try {
      ({ box } = await sandbox.instances.ensure({
        key: `hosted:${user}`,
        profile: { version: await profileTag, backend },
        // A box this kit made before the platform kept instances keeps its files.
        adopt: await store.get(`box:${user}`) ?? undefined,
        create: {
          name: `hosted-${user.slice(0, 24)}`,
          resources: { cpuCores: policy.cpuCores, memoryMB: policy.memoryMB, diskGB: policy.diskGB },
          secrets: [], sshEnabled: false,
          egressPolicy: { mode: 'strict', allowDomains: policy.allowDomains, includeImplicitDomains: false },
          idleTimeoutSeconds: policy.idleTimeoutSeconds, maxLifetimeSeconds: policy.maxLifetimeSeconds,
          deleteAfterStoppedSeconds: policy.deleteAfterStoppedSeconds, metadata: { hostedUser: user },
        },
      }))
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

  const meter = config.meter ?? 'hosted-agent'
  const owner = config.owner ? normalizeAddress(config.owner) : null
  /** Give the meter the configured allowance once, unless it already has a plan. */
  let planned: Promise<void> | undefined
  const ensurePlan = () => planned ??= (async () => {
    if ((await hub.allowances.plan(meter)).configured) return
    await hub.allowances.setPlan(meter, { free: { turnsPerDay: config.freeTurnsPerDay ?? 20, usdPerDay: null }, paid: null,
      spendResourceType: null })
  })().catch(error => { planned = undefined; throw error })

  /** Admit a new message once: STOP/START, then the Platform's allowance, then `allow`. */
  async function admit(message: HostedMessage, user: string): Promise<Allowance> {
    const stopKey = `stop:${user}`
    if (message.channel !== 'voice' && STOP.test(message.text.trim())) { await store.put(stopKey, '1'); return { reply: NOTICE.stopped } }
    if (message.channel !== 'voice' && START.test(message.text.trim())) { await store.put(stopKey, ''); return { reply: NOTICE.started } }
    if (await store.get(stopKey)) return 'ignore'
    await ensurePlan()
    // The Platform counts atomically and never counts one turn id twice.
    const allowance = await hub.allowances.admit(meter, { member: user, role: message.userId === owner ? 'owner' : 'member',
      turnId: message.turnId, channel: message.channel })
    if (allowance.decision === 'admit') return 'answer'
    // Past the paid allowance, nothing the person buys lifts today's limit.
    return allowance.decision === 'paywall' && config.allow ? await config.allow(message, allowance.turns.used) : { reply: NOTICE.limit }
  }

  /** Run one message in the person's box until it answers or `deadline`. */
  async function ask(message: HostedMessage, options: { deadline: number; trace?: TurnTrace }): Promise<AskResult> {
    const text = message.text.trim()
    if (!text || text.length > 8000 || !/^[\w-]{1,120}$/.test(message.turnId)) return { state: 'declined' }
    const user = (await sha256(message.userId)).slice(0, 32)
    // A session binds its backend when created, and the runtime would give a
    // bare session its generic default assistant. A new profile starts a new
    // session, so the persona always matches the one in force.
    const sessionId = `hosted-${user}-${await profileTag}`
    const trace = options.trace
    const conversationKey = `convo:${user}`
    let declined: AskResult | undefined
    let conversation: Conversation | undefined, at = ''
    const outcome = await runHostedTurn({ turnId: message.turnId, text }, {
      // The allowance counts a turn id once per person and admits its retries
      // again, so a model-supplied voice ticket cannot spend another person's turn.
      async admit() {
        const decision = await admit(message, user)
        if (decision === 'answer') return null
        declined = decision === 'ignore' ? { state: 'declined' } : { state: 'declined', reply: decision.reply }
        return { ok: false, reason: 'refused', detail: 'declined' }
      },
      async box() {
        const box = await ensureBox(user, options.deadline)
        if (!box) throw new TurnPending('box_starting', true)
        return box
      },
      sessionId,
      backend: async () => backend,
      async prompt(box) {
        const asked = message.channel === 'voice' ? `[Phone call. Answer in one to three short spoken sentences.]\n${text}` : text
        // The first turn in a new session or box inherits the person's recent
        // turns. A retry before that turn completes carries them again, so a
        // failed first attempt loses nothing.
        at = `${box.id}/${sessionId}`
        const stored = await store.get(conversationKey)
        conversation = stored ? JSON.parse(stored) as Conversation : { at, turns: [] }
        const carried = conversation.at === at ? '' : conversation.turns.map(([, them, you]) => `Them: ${them}\nYou: ${you}`).join('\n')
        return carried ? `${CARRY_HEAD}\n${carried}\n${CARRY_NOW}\n${asked}` : asked
      },
      async answered(answer) {
        // Concurrent turns may drop one another's entry; the box keeps the full record.
        const turns = (conversation?.turns ?? []).filter(([id]) => id !== message.turnId)
        turns.push([message.turnId, message.channel === 'voice' ? `(on a call) ${text}` : text, answer])
        while (turns.length > 1 && JSON.stringify(turns).length > CARRY_CHARS) turns.shift()
        await store.put(conversationKey, JSON.stringify({ at, turns } satisfies Conversation))
      },
      classify: error => error instanceof HostedAgentError ? { ok: false, reason: 'unavailable', detail: error.code } : undefined,
      observe: {
        readCreatedSession: Boolean(trace),
        span(step, ms) {
          if (trace && step === 'ensure') trace.box ??= `box ${seconds(ms)}`
        },
        session(info) {
          if (!trace) return
          trace.harness = info.harness ?? config.harness
          trace.model = info.model
        },
        drive(result) {
          if (trace && result.state === 'completed') noteResult(trace, result.result, result.usage)
        },
        failure(step, failure) {
          console.error(`[hosted-agent] turn=${message.turnId} step=${step} code=${failure.code} message=${JSON.stringify(failure.message)}`)
        },
      },
    }, { wallCapMs, timeoutMs: 8000, until: options.deadline })
    if (declined) return declined
    if (outcome.ok === true) return { state: 'answered', text: outcome.text }
    // A thrown failure is rethrown, so the caller's retry policy decides it.
    if (outcome.ok === 'pending') {
      if (outcome.cause !== undefined) throw outcome.cause
      return { state: 'pending' }
    }
    const code = outcome.detail ?? outcome.reason
    throw new HostedAgentError(code === 'agent_failed' ? 'turn_failed' : code, `The turn ended without an answer (${code}).`)
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
      // Only the configured owner toggles debug; anyone else's DEBUG ON is an ordinary message.
      const isOwner = Boolean(config.owner) && normalizeAddress(config.owner!) === userId
      const debugKey = `debug:${(await sha256(userId)).slice(0, 32)}`
      const toggle = isOwner ? debugCommand(event.text) : null
      const trace: TurnTrace | undefined = isOwner && toggle === null && await store.get(debugKey) ? {} : undefined
      let text: string
      try {
        if (toggle !== null) {
          await store.put(debugKey, toggle ? '1' : '')
          text = toggle ? NOTICE.debugOn : NOTICE.debugOff
        } else {
          const result = await ask({ userId, channel: 'imessage', text: event.text, turnId },
            { deadline: Date.now() + wallCapMs + 60_000, trace })
          if (result.state === 'pending') return 'pending'
          if (result.state === 'declined' && !result.reply) return 'ignored'
          text = result.state === 'answered' ? result.text : result.reply!
          if (trace && result.state === 'answered') {
            const totalMs = event.occurredAt !== null && event.occurredAt !== undefined ? Date.now() - event.occurredAt : undefined
            text = `${text.slice(0, 1300)}\n\n${debugFooter(config.profile.name ?? 'agent', turnId, trace, totalMs)}`
          }
        }
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
