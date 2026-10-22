import type { ChatAttachmentInput } from '../chat-routes/wire.js'
import { messageHasTurnId } from '../stream/turn-identity.js'
import type {
  OperatorApproval,
  OperatorAssetRef,
  OperatorFile,
  OperatorFileChange,
  OperatorFileEntry,
  OperatorJournalEntry,
  OperatorRole,
  OperatorScorecard,
  OperatorThread,
  OperatorTurn,
  OperatorTurnState,
  OperatorWorkspace,
  StartTurnInput,
} from './contract.js'
import { OperatorError, type OperatorAdapter, type OperatorContext } from './server.js'
import { sha256Hex } from '../crypto/digest'

/** The message fields the adapter reads; agent-app's chat-store rows satisfy it. */
export interface ChatOperatorMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  /** Typed chat parts, such as chat-store's, are read field by field. */
  parts: ReadonlyArray<object> | null
  createdAt?: Date | string | number | null
  model?: string | null
  servedModel?: string | null
  costUsd?: number | null
  /** Usage columns as chat-store stores them; see `operatorTurnUsage` for what `inputTokens` holds. */
  inputTokens?: number | null
  cacheReadTokens?: number | null
  outputTokens?: number | null
  /** The row's product metadata, for a `failureOf` that reads a stamped turn status. */
  metadata?: Record<string, unknown> | null
}

export interface ChatOperatorThread {
  id: string
  workspaceId: string
  title: string
  updatedAt?: Date | string | number | null
}

export interface ChatOperatorWorkspace {
  id: string
  name: string
  role?: OperatorRole
  createdAt?: Date | string | number | null
}

/** A durable execution claim, separate from the chat transcript that owns results. */
export interface ChatOperatorAdmission {
  threadId: string
  /** Only an explicit refusal before a usable stream opened is recorded here. */
  refusal?: { code?: string; message: string }
}

/** Product-owned atomic storage for duplicate suppression across processes.
 * A claim with no transcript stays unknown after a crash; it never licenses a
 * second execution. This is not a completion ledger or an automatic retry queue.
 */
export interface ChatOperatorAdmissionStore<Identity> {
  get(ctx: OperatorContext<Identity>, workspaceId: string, turnId: string): Promise<ChatOperatorAdmission | null>
  claim(ctx: OperatorContext<Identity>, input: { workspaceId: string; threadId: string; turnId: string }): Promise<boolean>
  recordRefusal(ctx: OperatorContext<Identity>, input: { workspaceId: string; threadId: string; turnId: string }, refusal: { code?: string; message: string }): Promise<void>
}

export interface ChatOperatorAdapterOptions<Identity> {
  /** Optional durable claims; without one, transcript retry detection is not an atomic admission lock. */
  admissions?: ChatOperatorAdmissionStore<Identity>
  /**
   * Set when `runTurn` forwards `attachments` in the chat request body and the
   * chat route resolves them from the workspace's store, as with
   * `resolveChatAttachments`. Without it, turns that carry attachments are refused.
   */
  acceptsAttachments?: boolean
  /** Most attachments one turn may carry; set it to the chat route's own count cap. Default `ATTACHMENT_MAX_COUNT`. */
  maxAttachments?: number
  /** The app's public origin, the base of every browser link. */
  origin: string
  /** Browser path of a conversation; defaults to `/app/<workspace>/chat/<thread>`. */
  threadPath?(workspaceId: string, threadId: string): string
  /** Browser path of a workspace; defaults to `/app/<workspace>`. */
  workspacePath?(workspaceId: string): string
  workspaces: {
    /** Apply the app's roles: `read` needs viewer access, `run` the role that may start agent work. */
    authorize(ctx: OperatorContext<Identity>, workspaceId: string, access: 'read' | 'run'): Promise<ChatOperatorWorkspace | null>
    list(ctx: OperatorContext<Identity>): Promise<ChatOperatorWorkspace[]>
    create?(ctx: OperatorContext<Identity>, input: { name: string }): Promise<ChatOperatorWorkspace>
  }
  threads: {
    /**
     * A thread this caller may read, or null. An app whose conversations
     * belong to one user (not the whole workspace) applies that here.
     */
    get(threadId: string, ctx: OperatorContext<Identity>): Promise<ChatOperatorThread | null>
    /** Insert a thread with this id for this caller; agent-app's chat store accepts a caller-assigned id. */
    create(ctx: OperatorContext<Identity>, input: { id: string; workspaceId: string; title: string }): Promise<ChatOperatorThread>
    /** Oldest first. */
    listMessages(threadId: string, ctx: OperatorContext<Identity>): Promise<ChatOperatorMessage[]>
    list?(ctx: OperatorContext<Identity>, workspaceId: string, query: { cursor?: string; limit: number }): Promise<{ threads: ChatOperatorThread[]; nextCursor: string | null }>
  }
  /**
   * Run one turn through the app's own chat route as this caller. The adapter
   * reads the response to its end, so the turn is driven exactly as a browser
   * holding its stream drives it, and the start request returns once it settles.
   * `attachments` arrives only when `acceptsAttachments` is set.
   */
  runTurn(ctx: OperatorContext<Identity>, input: {
    workspaceId: string; threadId: string; turnId: string; content: string; model?: string
    attachments?: ChatAttachmentInput[]
  }): Promise<Response>
  /** Optional authoritative status of this user-turn anchor. When supplied,
   *  missing/running status without a live lease never promotes a partial reply to success. */
  turnStatus?(ctx: OperatorContext<Identity>, workspaceId: string, threadId: string, user: ChatOperatorMessage): Promise<'running' | 'complete' | 'error' | null>
  /** Turn ids still running on a thread, or null when the app cannot tell. */
  runningTurns?(ctx: OperatorContext<Identity>, workspaceId: string, threadId: string): Promise<string[] | null>
  /** Decisions open in the workspace, or on one conversation when `threadId` is set. */
  approvals?(ctx: OperatorContext<Identity>, workspaceId: string, threadId?: string): Promise<OperatorApproval[]>
  files?: {
    list(ctx: OperatorContext<Identity>, workspaceId: string, prefix: string): Promise<OperatorFileEntry[]>
    read(ctx: OperatorContext<Identity>, workspaceId: string, path: string): Promise<OperatorFile | null>
  }
  journal?(ctx: OperatorContext<Identity>, workspaceId: string, days: number): Promise<OperatorJournalEntry[]>
  assets?: {
    /** Assets a reply references; defaults to none. */
    refs?(message: ChatOperatorMessage, workspaceId: string): OperatorAssetRef[]
    read?(ctx: OperatorContext<Identity>, workspaceId: string, assetId: string): Promise<Response | null>
  }
  scorecard?(ctx: OperatorContext<Identity>, workspaceId: string, days: number): Promise<OperatorScorecard>
  /**
   * A reply's failure. Defaults to an `error` notice (the sandbox producer's
   * `errorNotice` mode), a `turn-failure` notice or an `error` part.
   */
  failureOf?(message: ChatOperatorMessage): { code?: string; message: string } | null
  /**
   * Whether stored rows' `inputTokens` include cache reads, for
   * `operatorTurnUsage`. A row does not say which writer or version stored
   * it, so pass a boolean only when every writer of the app's rows is known
   * to follow it. Default `'unknown'` reports `inputTokens` only on rows that
   * record zero cache reads.
   */
  inputIncludesCache?: boolean | 'unknown'
}

const iso = (value: Date | string | number | null | undefined): string | undefined => {
  if (value === null || value === undefined) return undefined
  const date = value instanceof Date ? value : new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

function partsOf(message: ChatOperatorMessage): ReadonlyArray<Record<string, unknown>> {
  return (message.parts ?? []) as ReadonlyArray<Record<string, unknown>>
}

function defaultFailure(message: ChatOperatorMessage): { code?: string; message: string } | null {
  for (const part of partsOf(message)) {
    const errorNotice = part.type === 'notice' && part.noticeKind === 'error'
    const notice = errorNotice || (part.type === 'notice' && (part.noticeKind === 'turn-failure' || part.kind === 'turn-failure'))
    if (!notice && part.type !== 'error') continue
    const detail = text(part.message) ?? text(part.text) ?? text(part.error) ?? 'The turn failed'
    // An error notice always names a reason, so a caller can tell failures apart.
    const code = typeof part.code === 'string' ? part.code : errorNotice ? 'turn.error' : undefined
    return { ...(code ? { code } : {}), message: detail }
  }
  return null
}

function fileChanges(message: ChatOperatorMessage): OperatorFileChange[] {
  const files: OperatorFileChange[] = []
  for (const part of partsOf(message)) {
    if (part.type !== 'session-artifact' || typeof part.path !== 'string') continue
    const action = part.action === 'created' || part.action === 'updated' || part.action === 'deleted' ? part.action : 'changed'
    if (!files.some((file) => file.path === part.path)) files.push({ path: part.path, action })
  }
  return files
}

function turnIdOf(message: ChatOperatorMessage): string | null {
  for (const part of partsOf(message)) {
    if (typeof part.turnId === 'string' && part.turnId) return part.turnId
  }
  return null
}

/**
 * The operator turn usage of a stored assistant row, for `OperatorTurn.usage`.
 * `cachedInputTokens` is the row's `cacheReadTokens` and `outputTokens` its
 * `outputTokens`, each when the row has it. `inputTokens` is reported only as
 * the prompt NOT read from cache, and a row does not record whether its
 * `inputTokens` already excludes cache reads: the Router lane subtracts them
 * before storing since 0.60.248 and included them before, and the sandbox
 * lanes store the split their upstream reports. A missing `cacheReadTokens`
 * is unknown, not 0. So:
 * - `'unknown'` (the default) reports the row's `inputTokens` only when
 *   `cacheReadTokens` is a recorded 0, and omits it otherwise;
 * - `inputIncludesCache: false` reports the row's `inputTokens`, with or
 *   without a recorded `cacheReadTokens`;
 * - `inputIncludesCache: true` reports `inputTokens - cacheReadTokens` when
 *   `cacheReadTokens` is recorded and the difference is not negative, and
 *   omits it otherwise.
 * `cachedInputTokens` and `outputTokens` are reported whenever the row
 * records them, independent of `inputTokens`.
 * A count that is not a finite number is omitted, never zeroed; a row with no
 * count gives `undefined`. An app that builds its own operator turns from such
 * rows calls this rather than mapping them itself.
 */
export function operatorTurnUsage(
  row: Pick<ChatOperatorMessage, 'inputTokens' | 'cacheReadTokens' | 'outputTokens'>,
  options: { inputIncludesCache?: boolean | 'unknown' } = {},
): OperatorTurn['usage'] {
  const count = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const input = count(row.inputTokens)
  const cached = count(row.cacheReadTokens)
  const output = count(row.outputTokens)
  const includes = options.inputIncludesCache ?? 'unknown'
  const uncached = input === undefined ? undefined
    : includes === false ? input
    : includes === true ? (cached !== undefined && input - cached >= 0 ? input - cached : undefined)
    : cached === 0 ? input
    : undefined
  const usage: NonNullable<OperatorTurn['usage']> = {
    ...(uncached !== undefined ? { inputTokens: uncached } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

async function drain(response: Response, signal: AbortSignal): Promise<void> {
  if (!response.body) return
  const reader = response.body.getReader()
  const stop = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', stop, { once: true })
  try {
    while (!(await reader.read()).done) { /* The turn is driven by reading its stream. */ }
  } finally {
    signal.removeEventListener('abort', stop)
    reader.releaseLock()
  }
}

/**
 * The operator adapter for an app built on agent-app's chat stack: threads and
 * messages from its chat store, turns through its own chat route. The app
 * supplies its workspace roles and, optionally, files, journal, approvals,
 * assets, and a scorecard.
 */
export function createChatOperatorAdapter<Identity>(options: ChatOperatorAdapterOptions<Identity>): OperatorAdapter<Identity> {
  const origin = options.origin.replace(/\/$/, '')
  const threadUrl = (workspaceId: string, threadId: string) =>
    origin + (options.threadPath?.(workspaceId, threadId) ?? `/app/${workspaceId}/chat/${threadId}`)
  const workspaceView = (workspace: ChatOperatorWorkspace): OperatorWorkspace => ({
    id: workspace.id,
    name: workspace.name,
    ...(workspace.role ? { role: workspace.role } : {}),
    url: origin + (options.workspacePath?.(workspace.id) ?? `/app/${workspace.id}`),
    ...(iso(workspace.createdAt) ? { createdAt: iso(workspace.createdAt)! } : {}),
  })
  const threadView = (thread: ChatOperatorThread): OperatorThread => ({
    id: thread.id, title: thread.title, url: threadUrl(thread.workspaceId, thread.id),
    ...(iso(thread.updatedAt) ? { updatedAt: iso(thread.updatedAt)! } : {}),
  })

  async function threadIn(ctx: OperatorContext<Identity>, workspaceId: string, threadId: string): Promise<ChatOperatorThread | null> {
    const thread = await options.threads.get(threadId, ctx)
    return thread && thread.workspaceId === workspaceId ? thread : null
  }

  async function turnOf(ctx: OperatorContext<Identity>, workspaceId: string, threadId: string, turnId: string): Promise<OperatorTurn | null> {
    const messages = await options.threads.listMessages(threadId, ctx)
    const userIndex = messages.findIndex((message) => message.role === 'user' && messageHasTurnId(message, turnId))
    if (userIndex < 0) return null
    const later = messages.slice(userIndex + 1)
    const nextUser = later.findIndex((message) => message.role === 'user')
    const window = nextUser < 0 ? later : later.slice(0, nextUser)
    const assistant = [...window].reverse().find((message) => message.role === 'assistant') ?? null
    const latest = nextUser < 0
    const running = latest && options.runningTurns ? await options.runningTurns(ctx, workspaceId, threadId) : []
    const status = options.turnStatus ? await options.turnStatus(ctx, workspaceId, threadId, messages[userIndex]!) : undefined
    const terminal = status === undefined || status === 'complete' || status === 'error'
    const turn: OperatorTurn = {
      workspaceId, threadId, turnId, state: 'unknown', url: threadUrl(workspaceId, threadId),
      reply: null, failure: null, assets: [], files: [], approvals: [],
    }
    let state: OperatorTurnState = running === null ? 'unknown' : running.length > 0 ? 'working' : 'unknown'
    if (assistant) {
      turn.files = fileChanges(assistant)
      turn.assets = options.assets?.refs?.(assistant, workspaceId) ?? []
      const model = assistant.servedModel ?? assistant.model
      if (model) turn.model = model
      if (typeof assistant.costUsd === 'number') turn.costUsd = assistant.costUsd
      const usage = operatorTurnUsage(assistant, { inputIncludesCache: options.inputIncludesCache ?? 'unknown' })
      if (usage) turn.usage = usage
      if (state !== 'working' && terminal) {
        const failure = (options.failureOf ?? defaultFailure)(assistant) ?? (status === 'error' ? { code: 'turn.error', message: 'The turn failed; retained text may be partial' } : null)
        if (failure) {
          state = 'failed'
          turn.failure = failure
        } else if (assistant.content.trim()) {
          state = 'succeeded'
          turn.reply = { content: assistant.content, mediaType: 'text/markdown' }
        }
        const completedAt = iso(assistant.createdAt)
        if (completedAt && (state === 'succeeded' || state === 'failed')) turn.completedAt = completedAt
      }
    } else if (state !== 'working' && terminal && (!latest || status === 'error' || status === 'complete')) {
      state = 'failed'
      turn.failure = { code: status === 'error' ? 'turn.error' : 'turn.no_reply', message: 'The turn ended without a reply' }
    }
    turn.state = state
    if (state !== 'succeeded' && state !== 'failed' && options.approvals) {
      turn.approvals = await options.approvals(ctx, workspaceId, threadId)
    }
    return turn
  }

  async function admittedTurn(ctx: OperatorContext<Identity>, workspaceId: string, turnId: string, admission: ChatOperatorAdmission): Promise<OperatorTurn> {
    if (!(await threadIn(ctx, workspaceId, admission.threadId))) throw new OperatorError('operator.turn_identity_conflict', 409)
    const persisted = await turnOf(ctx, workspaceId, admission.threadId, turnId)
    if (persisted) return persisted
    return {
      workspaceId, threadId: admission.threadId, turnId, state: admission.refusal ? 'failed' : 'unknown',
      url: threadUrl(workspaceId, admission.threadId), reply: null, failure: admission.refusal ?? null,
      assets: [], files: [], approvals: [],
    }
  }

  async function ensureThread(ctx: OperatorContext<Identity>, workspaceId: string, input: StartTurnInput): Promise<string> {
    const id = (await sha256Hex(`operator-thread\0${ctx.key.keyId}\0${workspaceId}\0${input.turnId}`)).slice(0, 32)
    const existing = await options.threads.get(id, ctx)
    if (existing) {
      if (existing.workspaceId !== workspaceId) throw new OperatorError('operator.turn_identity_conflict', 409, 'This turn id belongs to another conversation')
      return id
    }
    const title = (input.title ?? input.content.split('\n').find((line) => line.trim()) ?? 'New conversation').trim().slice(0, 80)
    try {
      await options.threads.create(ctx, { id, workspaceId, title })
    } catch (error) {
      // A concurrent retry may have inserted the same id first.
      if (!(await threadIn(ctx, workspaceId, id))) throw error
    }
    return id
  }

  const adapter: OperatorAdapter<Identity> = {
    ...(options.acceptsAttachments === true ? { acceptsAttachments: true } : {}),
    ...(options.maxAttachments === undefined ? {} : { maxAttachments: options.maxAttachments }),
    async authorizeWorkspace(ctx, workspaceId, access) {
      const workspace = await options.workspaces.authorize(ctx, workspaceId, access)
      return workspace ? workspaceView(workspace) : null
    },
    async listWorkspaces(ctx) {
      return (await options.workspaces.list(ctx)).map(workspaceView)
    },
    async startTurn(ctx, workspace, input) {
      const priorAdmission = await options.admissions?.get(ctx, workspace.id, input.turnId)
      if (priorAdmission) {
        if (input.threadId && input.threadId !== priorAdmission.threadId) throw new OperatorError('operator.turn_identity_conflict', 409)
        return admittedTurn(ctx, workspace.id, input.turnId, priorAdmission)
      }
      let threadId = input.threadId
      if (threadId === undefined) {
        threadId = await ensureThread(ctx, workspace.id, input)
      } else if (!(await threadIn(ctx, workspace.id, threadId))) {
        throw new OperatorError('operator.thread_not_found', 404, 'Thread not found')
      }
      // A retried start whose turn is already recorded reads it instead of running again.
      const existing = await turnOf(ctx, workspace.id, threadId, input.turnId)
      if (existing) return existing
      const target = { workspaceId: workspace.id, threadId, turnId: input.turnId }
      if (options.admissions && !(await options.admissions.claim(ctx, target))) {
        const raced = await options.admissions.get(ctx, workspace.id, input.turnId)
        if (!raced) throw new OperatorError('operator.admission_unavailable', 503, 'Admission state is unavailable', true)
        if (raced.threadId !== threadId) throw new OperatorError('operator.turn_identity_conflict', 409)
        return admittedTurn(ctx, workspace.id, input.turnId, raced)
      }
      const response = await options.runTurn(ctx, {
        workspaceId: workspace.id, threadId, turnId: input.turnId, content: input.content,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown }
        // Apps answer `{ error, code }` or `{ error: { code, message } }`.
        const nested = body.error && typeof body.error === 'object' ? body.error as { code?: unknown; message?: unknown } : {}
        const failure = {
          code: typeof body.code === 'string' ? body.code : typeof nested.code === 'string' ? nested.code : `operator.chat_${response.status}`,
          message: typeof body.error === 'string' ? body.error : typeof nested.message === 'string' ? nested.message : 'The app refused the turn',
        }
        if (options.admissions) {
          await options.admissions.recordRefusal(ctx, target, failure)
          return admittedTurn(ctx, workspace.id, input.turnId, { threadId, refusal: failure })
        }
        throw new OperatorError(failure.code, response.status, failure.message, response.status === 429 || response.status >= 500)
      }
      await drain(response, ctx.request.signal)
      return await turnOf(ctx, workspace.id, threadId, input.turnId) ?? {
        workspaceId: workspace.id, threadId, turnId: input.turnId, state: 'unknown', url: threadUrl(workspace.id, threadId),
        reply: null, failure: null, assets: [], files: [], approvals: [],
      }
    },
    async getTurn(ctx, workspace, target) {
      if (!(await threadIn(ctx, workspace.id, target.threadId))) return null
      const persisted = await turnOf(ctx, workspace.id, target.threadId, target.turnId)
      if (persisted) return persisted
      const admission = await options.admissions?.get(ctx, workspace.id, target.turnId)
      return admission?.threadId === target.threadId ? admittedTurn(ctx, workspace.id, target.turnId, admission) : null
    },
    async getThread(ctx, workspace, threadId) {
      const thread = await threadIn(ctx, workspace.id, threadId)
      if (!thread) return null
      const messages = await options.threads.listMessages(threadId, ctx)
      const lastUser = [...messages].reverse().find((message) => message.role === 'user')
      const turnId = lastUser ? turnIdOf(lastUser) : null
      return { thread: threadView(thread), latestTurn: turnId ? await turnOf(ctx, workspace.id, threadId, turnId) : null }
    },
    listApprovals: (ctx, workspace) => options.approvals ? options.approvals(ctx, workspace.id) : Promise.resolve([]),
  }
  if (options.workspaces.create) {
    const create = options.workspaces.create
    adapter.createWorkspace = async (ctx, input) => workspaceView(await create(ctx, input))
  }
  if (options.threads.list) {
    const list = options.threads.list
    adapter.listThreads = async (ctx, workspace, query) => {
      const page = await list(ctx, workspace.id, query)
      return { threads: page.threads.map(threadView), nextCursor: page.nextCursor }
    }
  }
  if (options.files) {
    const files = options.files
    adapter.listFiles = (ctx, workspace, query) => files.list(ctx, workspace.id, query.prefix)
    adapter.readFile = (ctx, workspace, path) => files.read(ctx, workspace.id, path)
  }
  if (options.journal) {
    const journal = options.journal
    adapter.listJournal = (ctx, workspace, query) => journal(ctx, workspace.id, query.days)
  }
  if (options.assets?.read) {
    const read = options.assets.read
    adapter.readAsset = (ctx, workspace, assetId) => read(ctx, workspace.id, assetId)
  }
  if (options.scorecard) {
    const scorecard = options.scorecard
    adapter.getScorecard = (ctx, workspace, query) => scorecard(ctx, workspace.id, query.days)
  }
  return adapter
}
