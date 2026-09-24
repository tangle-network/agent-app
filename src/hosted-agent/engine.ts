import type { BackendConfig, CreateSessionOptions } from '@tangle-network/sandbox'
import type { ConversationTurnOptions, ConversationTurnResult, PromptInputPart } from '@tangle-network/sandbox/core'

/**
 * The one turn engine for a hosted agent, whatever hosts it. This kit's
 * `createHostedAgent` runs on it with a key-value store, and Agent Builder
 * runs on it with its D1 enrollments, per-user keys, spaces and product
 * ingest. A host supplies those as ports; the engine owns the order of the
 * steps and what each outcome and failure means.
 *
 * One call is one non-blocking pass for one message:
 *
 *   validate -> admit once -> the person's box -> authorize -> session -> drive -> classify
 *
 * Every step is idempotent by the turn id: the sandbox's admission receipt
 * settles a repeated drive on the same turn, so a host may repeat a pass for
 * the same message any number of times and the agent runs it once.
 */

export type TurnRefusal = 'not_enrolled' | 'execution_not_ready' | 'refused' | 'unavailable'
export type TurnReply = { ok: true; text: string } | { ok: false; reason: TurnRefusal; detail?: string }
export type TurnStep = 'ensure' | 'drive' | 'turn'
/**
 * Where an unfinished turn stands. `code` is the same on every repeat of the
 * same cause, so a host can tell a stuck turn from a slow one. A transient
 * cause (a lost response, a timeout, a busy platform, a box still starting)
 * is expected to clear by itself; any other repeats until it is fixed.
 */
export interface PendingDetail { step: TurnStep; code: string; transient: boolean }
/** `cause` is what a port or the Sandbox threw, when a throw left the turn pending. */
export type TurnOutcome = TurnReply | { ok: 'pending'; detail: PendingDetail; cause?: unknown }

export const MAX_MESSAGE_CHARS = 8000
/** Identical non-transient failures in a row after which a host fails a turn. */
export const MAX_REPEATED_FAILURES = 3
/** Refusal detail when the host's `authorize` check fails. */
export const AUTHORITY_ENDED = 'authority_ended'

/** The part of a Sandbox box one turn uses. `SandboxInstance` satisfies it. */
export interface TurnBox {
  readonly id: string
  driveConversationTurn(message: string | PromptInputPart[], options: ConversationTurnOptions): Promise<ConversationTurnResult>
  session(id: string): { status(): Promise<unknown> }
  createSession(options: CreateSessionOptions): Promise<unknown>
}

/** A port throws this to report a turn that is not ready yet, such as a box still starting. */
export class TurnPending extends Error {
  constructor(readonly code: string, readonly transient: boolean) {
    super(code)
    this.name = 'TurnPending'
  }
}

/** A thrown value as a stable code plus a secret-free message for a log line. */
export interface TurnFailure { name: string; code: string; status?: number; reason?: string; message: string }

/** What a pass reports while it runs. Every hook is optional; none changes the outcome. */
export interface TurnObserver {
  /** Time one step of this pass took, whether it returned or threw. */
  span?(step: 'ensure' | 'session' | 'drive', ms: number): void
  /** The session the turn runs in, as the runtime reports it, or the backend it was created with. */
  session?(info: { harness?: string; model?: string; created: boolean }): void
  /**
   * Read a session this pass created once more, so `session` reports the
   * harness and model the runtime chose for it. It costs one request, so a
   * host asks for it only when it shows them (an owner's debug line, say).
   */
  readCreatedSession?: boolean
  /** Each drive result and the time it arrived. */
  drive?(result: ConversationTurnResult, at: number): void
  /** A failure that left the turn pending or refused. */
  failure?(step: TurnStep, failure: TurnFailure, boxId?: string): void | Promise<void>
}

/** Storage and policy a host supplies for one message. */
export interface HostedTurnPorts<Box extends TurnBox = TurnBox> {
  /**
   * Admit this turn once, before any compute. Return null to run it, or the
   * refusal. A turn admitted by an earlier pass must return null again, so a
   * retry never consumes allowance twice.
   */
  admit(): Promise<Extract<TurnReply, { ok: false }> | null>
  /** The person's running box: created, resumed or replaced as needed. Throw to report why not. */
  box(): Promise<Box>
  /** The host's own authority (a phone link, say), read after the box is ready and right before the drive. */
  authorize?(): Promise<boolean>
  /** The session this turn runs in. A session binds its backend when created, so a new persona needs a new id. */
  sessionId: string
  /** The backend a missing session is created with. Without it the runtime answers as its generic assistant. */
  backend(): Promise<BackendConfig>
  /** The message as the agent receives it: text, or text and images. */
  prompt(box: Box): Promise<string | PromptInputPart[]>
  /** Runs once the turn has a non-empty answer, before the pass returns it. */
  answered?(answer: string, box: Box): Promise<void>
  /** Map a thrown value to an outcome. Undefined leaves it to the engine's own classification. */
  classify?(error: unknown, step: 'ensure' | 'drive'): TurnOutcome | undefined
  observe?: TurnObserver
}

export interface HostedTurnOptions {
  /** The run's wall-clock cap; the Sandbox cancels a turn that exceeds it. */
  wallCapMs: number
  /** How long one drive request may wait on a running turn. Default 8 s. */
  timeoutMs?: number
  /** False only reads a turn admitted earlier; it never admits or starts one. */
  allowDispatch?: boolean
  /** Keep driving a running turn until this time, instead of returning pending after one drive. */
  until?: number
  /** Wait between drives while `until` allows. Default 2 s. */
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Harness and model as the runtime reports them; the model it selected after normalization wins. */
function sessionInfo(session: unknown): { harness?: string; model?: string } {
  const s = (typeof session === 'object' && session !== null ? session : {}) as
    { backend?: unknown; model?: unknown; effectiveBackend?: { model?: unknown } | null }
  const effective = s.effectiveBackend?.model
  const model = typeof effective === 'string' && effective ? effective : typeof s.model === 'string' && s.model ? s.model : undefined
  return { ...(typeof s.backend === 'string' && s.backend ? { harness: s.backend } : {}), ...(model ? { model } : {}) }
}

const refusal = (reason: TurnRefusal, detail?: string): Extract<TurnReply, { ok: false }> => ({ ok: false, reason, ...(detail ? { detail } : {}) })
const RUNNING = new Set(['running', 'awaiting_input', 'not_admitted'])
const TRANSIENT_ERRORS = new Set(['NetworkError', 'TimeoutError', 'QuotaError', 'AbortError', 'EdgeNotReadyError'])
/**
 * The 503 codes the Sandbox SDK itself classifies as refused before dispatch
 * and safe to retry. A 503 with any other code, such as
 * HUB_CREDENTIAL_REFRESH_FAILED, has not shown it will clear by itself.
 */
const TRANSIENT_503 = new Set(['MODEL_CREDENTIAL_SUPERSEDED', 'HUB_CREDENTIAL_REFRESH_UNAVAILABLE'])

/** The code omits the message, which can carry ids or times that differ on every repeat of one cause. */
export function describeFailure(error: unknown): TurnFailure {
  const e = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>
  const name = typeof e.name === 'string' ? e.name : typeof error
  const status = typeof e.status === 'number' ? e.status : undefined
  const own = typeof e.code === 'string' ? e.code : typeof e.reason === 'string' ? e.reason : undefined
  const code = [name, own, status].filter(part => part !== undefined).join(':').replace(/[^\w.:-]/g, '_').slice(0, 100)
  const message = String(typeof e.message === 'string' ? e.message : error)
    .replace(/sk-tan-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]*|Bearer\s+\S+/g, '<redacted>').slice(0, 400)
  return { name, code, ...(status !== undefined ? { status } : {}), ...(own !== undefined ? { reason: own } : {}), message }
}

export function isTransientFailure(failure: Pick<TurnFailure, 'name' | 'status' | 'reason'>): boolean {
  return TRANSIENT_ERRORS.has(failure.name) || [408, 429, 502, 504].includes(failure.status ?? 0) ||
    (failure.status === 503 && (failure.reason === undefined || TRANSIENT_503.has(failure.reason)))
}

/**
 * The platform refuses a funded request once the paying key's budget is
 * spent. That refusal is decided, so retrying it would loop forever.
 */
const budgetExhausted = (error: unknown) => error instanceof Error && error.name === 'KeyBudgetExhaustedError'

/** One non-blocking pass for one message. Safe to repeat with the same turn id. */
export async function runHostedTurn<Box extends TurnBox>(turn: { turnId: string; text: string }, ports: HostedTurnPorts<Box>,
  options: HostedTurnOptions): Promise<TurnOutcome> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const observe = ports.observe ?? {}
  const allowDispatch = options.allowDispatch !== false
  const text = turn.text.trim()
  if (!text || text.length > MAX_MESSAGE_CHARS || !turn.turnId || turn.turnId.length > 200) return refusal('refused', 'invalid_message')
  const refused = await ports.admit()
  if (refused) return refused

  const timed = async <T>(step: 'ensure' | 'session' | 'drive', fn: () => Promise<T>): Promise<T> => {
    const start = now()
    try { return await fn() } finally { observe.span?.(step, now() - start) }
  }
  const failed = async (step: 'ensure' | 'drive', error: unknown, boxId?: string): Promise<TurnOutcome> => {
    const failure = describeFailure(error)
    await observe.failure?.(step, failure, boxId)
    const classified = ports.classify?.(error, step)
    if (classified) return classified
    if (error instanceof TurnPending) return { ok: 'pending', detail: { step, code: error.code, transient: error.transient } }
    if (budgetExhausted(error)) return refusal('refused', 'budget_exhausted')
    // An admission whose response was lost is retried with the same turn id;
    // the runtime's admission receipt prevents a second execution.
    return { ok: 'pending', detail: { step, code: failure.code, transient: isTransientFailure(failure) }, cause: error }
  }

  let box: Box
  try {
    box = await timed('ensure', () => ports.box())
  } catch (error) {
    return failed('ensure', error)
  }
  if (ports.authorize && !await ports.authorize()) return refusal('refused', AUTHORITY_ENDED)

  let result: ConversationTurnResult
  try {
    const prompt = await ports.prompt(box)
    const sessionId = ports.sessionId
    // The SDK would create a missing session with no profile, and the runtime
    // would then answer as its generic default assistant.
    if (allowDispatch) await timed('session', async () => {
      const session = await box.session(sessionId).status()
      if (session) {
        observe.session?.({ created: false, ...sessionInfo(session) })
        return
      }
      const backend = await ports.backend()
      await box.createSession({ sessionId, retention: 'workspace', backend })
      // A new session names its harness and model only once the runtime has created it.
      const created = observe.session && observe.readCreatedSession ? sessionInfo(await box.session(sessionId).status()) : {}
      observe.session?.({ created: true, ...(backend.type ? { harness: backend.type } : {}), ...created })
    })
    for (;;) {
      result = await timed('drive', () => box.driveConversationTurn(prompt, { sessionId, turnId: turn.turnId,
        wallCapMs: options.wallCapMs, timeoutMs: options.timeoutMs ?? 8000, allowDispatch }))
      observe.drive?.(result, now())
      const pollMs = options.pollMs ?? 2000
      if (!RUNNING.has(result.state) || options.until === undefined || now() + pollMs > options.until) break
      await sleep(pollMs)
    }
  } catch (error) {
    return failed('drive', error, box.id)
  }
  switch (result.state) {
    case 'completed': {
      const answer = result.text.trim()
      if (!answer) {
        await observe.failure?.('turn', describeFailure(new Error('The turn completed with no reply text')), box.id)
        return refusal('unavailable', 'empty_reply')
      }
      await ports.answered?.(answer, box)
      return { ok: true, text: answer }
    }
    case 'failed':
      await observe.failure?.('turn', describeFailure(Object.assign(new Error(result.error), { name: 'TurnFailed' })), box.id)
      return refusal('unavailable', 'agent_failed')
    // Interaction and plan approval are not exposed over messaging. The wall
    // cap cancels a turn that waits on one, which frees the session.
    case 'awaiting_plan_decision': return refusal('refused', 'needs_decision')
    case 'running': case 'awaiting_input': case 'not_admitted':
      return { ok: 'pending', detail: { step: 'turn', code: result.state, transient: true } }
  }
}

/**
 * Repeat passes until the turn settles, for a caller that holds a connection
 * open (a voice question, say). A turn the runtime never finishes must not
 * hold the caller forever, so `deadline` bounds the wait; `signal` stops the
 * wait only, and the admitted turn keeps running.
 */
export async function settleHostedTurn(pass: () => Promise<TurnOutcome>, options: {
  deadline: number
  pollMs?: number
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}): Promise<TurnReply> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  }))
  let last = '', repeats = 0
  for (;;) {
    if (options.signal?.aborted || now() > options.deadline) return refusal('unavailable', 'pending')
    const outcome = await pass()
    if (outcome.ok !== 'pending') return outcome
    repeats = outcome.detail.code === last ? repeats + 1 : 1
    last = outcome.detail.code
    if (!outcome.detail.transient && repeats >= MAX_REPEATED_FAILURES) return refusal('unavailable', `${outcome.detail.step}:${last}`)
    try { await sleep(options.pollMs ?? 1500, options.signal) } catch { return refusal('unavailable', 'pending') }
  }
}

/**
 * A space member who may chat only: no shell and no file writes in the shared
 * box. The profile's other settings are kept.
 */
export function chatOnlyBackend(backend: BackendConfig): BackendConfig {
  const profile = backend.profile ?? {}
  return { ...backend, profile: { ...profile,
    tools: { ...profile.tools, bash: false, edit: false, write: false },
    permissions: { ...profile.permissions, bash: 'deny', edit: 'deny' } } }
}
