import { createApiKeyRequestAuth, type RequestApiKey } from '../platform/api-key-auth'
import {
  OPERATOR_API_BASE_PATH,
  OPERATOR_API_VERSION,
  matchOperatorRoute,
  operatorKeyWorkspaces,
  type OperatorApproval,
  type OperatorCapability,
  type OperatorFile,
  type OperatorFileEntry,
  type OperatorJournalEntry,
  type OperatorRouteId,
  type OperatorScorecard,
  type OperatorThread,
  type OperatorTurn,
  type OperatorWorkspace,
  type StartTurnInput,
} from './contract'

/** The verified caller of one operator request. */
export interface OperatorContext<Identity> {
  identity: Identity
  key: { keyId: string; scopes: readonly string[] }
  request: Request
}

/**
 * The app's side of the operator API: storage and execution only. Scope,
 * workspace restriction, input validation, and response shapes belong to the
 * shared handler, so every app answers the same way.
 */
export interface OperatorAdapter<Identity> {
  /**
   * Apply the app's workspace roles: `read` needs viewer access, `run` needs
   * the role that may start agent work. Null answers 404, so a key cannot
   * probe workspaces it cannot reach.
   */
  authorizeWorkspace(ctx: OperatorContext<Identity>, workspaceId: string, access: 'read' | 'run'): Promise<OperatorWorkspace | null>
  listWorkspaces(ctx: OperatorContext<Identity>): Promise<OperatorWorkspace[]>
  createWorkspace?(ctx: OperatorContext<Identity>, input: { name: string }): Promise<OperatorWorkspace>
  /** Admit the turn durably and return without waiting for it; the same turnId never starts twice. */
  startTurn(ctx: OperatorContext<Identity>, workspace: OperatorWorkspace, input: StartTurnInput): Promise<OperatorTurn>
  getTurn(ctx: OperatorContext<Identity>, workspace: OperatorWorkspace, target: { threadId: string; turnId: string }): Promise<OperatorTurn | null>
  listThreads?(ctx: OperatorContext<Identity>, workspace: OperatorWorkspace, query: { cursor?: string; limit: number }): Promise<{ threads: OperatorThread[]; nextCursor: string | null }>
  getThread?(ctx: OperatorContext<Identity>, workspace: OperatorWorkspace, threadId: string): Promise<{ thread: OperatorThread; latestTurn: OperatorTurn | null } | null>
  listApprovals(ctx: OperatorContext<Identity>, workspace: OperatorWorkspace): Promise<OperatorApproval[]>
  listJournal?(ctx: OperatorContext<Identity>, workspace: OperatorWorkspace, query: { days: number }): Promise<OperatorJournalEntry[]>
  listFiles?(ctx: OperatorContext<Identity>, workspace: OperatorWorkspace, query: { prefix: string }): Promise<OperatorFileEntry[]>
  readFile?(ctx: OperatorContext<Identity>, workspace: OperatorWorkspace, path: string): Promise<OperatorFile | null>
  /** The stored bytes, or null when the asset is not in this workspace. */
  readAsset?(ctx: OperatorContext<Identity>, workspace: OperatorWorkspace, assetId: string): Promise<Response | null>
  getScorecard?(ctx: OperatorContext<Identity>, workspace: OperatorWorkspace, query: { days: number }): Promise<OperatorScorecard>
}

export interface OperatorKeyStore<Key extends RequestApiKey, Identity> {
  /** Verify against the app's existing key store, including revocation. */
  verify(authorization: string): Promise<Key | null>
  /** Load the key owner; throw a Response to refuse a key class, such as spending-capped keys. */
  resolveIdentity(key: Key): Promise<Identity | null>
  /** Atomically count the request against the key's limits. */
  claimRequest(key: Key, requestId: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }>
}

export interface OperatorApiOptions<Key extends RequestApiKey, Identity> {
  app: { id: string; name: string }
  keys: OperatorKeyStore<Key, Identity>
  adapter: OperatorAdapter<Identity>
  basePath?: string
  /** Longest hold for a turn read with `?wait=`, in seconds. */
  maxWaitSeconds?: number
  /** Interval between state reads during a held turn read. */
  pollIntervalMs?: number
  /** Unexpected adapter failures; responses never carry their detail. */
  onError?(error: unknown, route: OperatorRouteId): void
}

export interface OperatorApi {
  /** True when the request addresses this API's base path. */
  matches(request: Request): boolean
  handle(request: Request): Promise<Response>
}

/** A refusal with a stable code; adapters throw it for expected failures. */
export class OperatorError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
    readonly retryable = false,
  ) {
    super(message ?? code)
    this.name = 'OperatorError'
  }
}

const TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const THREAD_ID = /^[A-Za-z0-9_-]{1,256}$/
const MAX_BODY_BYTES = 128 * 1024
const MAX_CONTENT_BYTES = 64 * 1024
const START_FIELDS = new Set(['turnId', 'content', 'threadId', 'title', 'model'])

const NO_STORE = { 'cache-control': 'private, no-store' }

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE })
}

function refusal(status: number, code: string, error: string, retryable = false): Response {
  return json({ error, code, ...(retryable ? { retryable } : {}) }, status)
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number, name: string): number {
  if (value === null || value === '') return fallback
  if (!/^\d{1,6}$/.test(value)) throw new OperatorError('operator.invalid_input', 400, `${name} must be a whole number`)
  const parsed = Number(value)
  if (parsed < min || parsed > max) throw new OperatorError('operator.invalid_input', 400, `${name} must be between ${min} and ${max}`)
  return parsed
}

/** Workspace-relative paths only: no absolute, parent, empty, or backslash segments. */
function relativePath(value: string | null, name: string, { allowEmpty }: { allowEmpty: boolean }): string {
  const path = value ?? ''
  if (path === '' && allowEmpty) return ''
  if (!path || path.length > 1024 || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new OperatorError('operator.invalid_path', 400, `${name} must be a workspace-relative path`)
  }
  const segments = path.replace(/\/$/, '').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new OperatorError('operator.invalid_path', 400, `${name} must be a workspace-relative path`)
  }
  return path
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) throw new OperatorError('operator.body_too_large', 413, 'Request body is too large')
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new OperatorError('operator.body_too_large', 413, 'Request body is too large')
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new OperatorError('operator.invalid_json', 400, 'Body must be a JSON object') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OperatorError('operator.invalid_json', 400, 'Body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function optionalString(body: Record<string, unknown>, name: string, max: number): string | undefined {
  const value = body[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new OperatorError('operator.invalid_input', 400, `${name} must be a nonempty string of at most ${max} characters`)
  }
  return value.trim()
}

/** Identity and destination come from the key and the path; the body can only describe the work. */
function parseStartTurn(body: Record<string, unknown>): StartTurnInput {
  const unknown = Object.keys(body).filter((field) => !START_FIELDS.has(field))
  if (unknown.length) throw new OperatorError('operator.invalid_input', 400, `Unknown fields: ${unknown.join(', ')}`)
  if (typeof body.turnId !== 'string' || !TURN_ID.test(body.turnId)) {
    throw new OperatorError('operator.invalid_input', 400, 'turnId must be a client-generated UUID')
  }
  if (typeof body.content !== 'string' || !body.content.trim()) {
    throw new OperatorError('operator.invalid_input', 400, 'content must be a nonempty string')
  }
  if (new TextEncoder().encode(body.content).byteLength > MAX_CONTENT_BYTES) {
    throw new OperatorError('operator.invalid_input', 400, `content must be at most ${MAX_CONTENT_BYTES} bytes`)
  }
  const threadId = optionalString(body, 'threadId', 256)
  if (threadId !== undefined && !THREAD_ID.test(threadId)) {
    throw new OperatorError('operator.invalid_input', 400, 'threadId contains only letters, digits, - and _')
  }
  const title = optionalString(body, 'title', 200)
  const model = optionalString(body, 'model', 200)
  return {
    turnId: body.turnId.toLowerCase(),
    content: body.content,
    ...(threadId === undefined ? {} : { threadId }),
    ...(title === undefined ? {} : { title }),
    ...(model === undefined ? {} : { model }),
  }
}

function capabilities<Identity>(adapter: OperatorAdapter<Identity>): OperatorCapability[] {
  const present: Array<[OperatorCapability, unknown]> = [
    ['workspaces.create', adapter.createWorkspace],
    ['threads.read', adapter.getThread ?? adapter.listThreads],
    ['files.read', adapter.readFile ?? adapter.listFiles],
    ['journal.read', adapter.listJournal],
    ['assets.read', adapter.readAsset],
    ['scorecard.read', adapter.getScorecard],
  ]
  return present.filter(([, implemented]) => typeof implemented === 'function').map(([name]) => name)
}

function unsupported(): never {
  throw new OperatorError('operator.unsupported', 501, 'This app does not implement this operation')
}

/** A held turn read returns as soon as the turn settles or waits on a decision. */
function needsAttention(turn: OperatorTurn): boolean {
  return turn.state === 'succeeded' || turn.state === 'failed' || turn.state === 'input-required' || turn.approvals.length > 0
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve()
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

/**
 * Mount the standard operator API. Requests must carry a Bearer key: there is
 * no browser-cookie fallback, so a page session never reaches these routes.
 */
export function createOperatorApi<Key extends RequestApiKey, Identity>(
  options: OperatorApiOptions<Key, Identity>,
): OperatorApi {
  const basePath = (options.basePath ?? OPERATOR_API_BASE_PATH).replace(/\/$/, '')
  const maxWaitSeconds = Math.max(0, Math.min(options.maxWaitSeconds ?? 25, 55))
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 2_000)
  const { adapter } = options

  function matches(request: Request): boolean {
    const { pathname } = new URL(request.url)
    return pathname === basePath || pathname.startsWith(`${basePath}/`)
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const match = matchOperatorRoute(request.method, url.pathname, basePath)
    if (!match) return refusal(404, 'operator.route_not_found', 'No operator route matches this method and path')
    const { route, params } = match
    if (request.headers.get('Authorization') === null) {
      return refusal(401, 'operator.unauthenticated', 'An operator API key is required')
    }

    let verified: { identity: Identity; key: Key }
    try {
      const authenticate = createApiKeyRequestAuth<Key, { identity: Identity; key: Key }>({
        verify: (authorization) => options.keys.verify(authorization),
        requiredScope: () => route.scopes,
        resolveIdentity: async (key) => {
          const identity = await options.keys.resolveIdentity(key)
          return identity === null || identity === undefined ? null : { identity, key }
        },
        claimRequest: (key, requestId) => options.keys.claimRequest(key, requestId),
      })
      const result = await authenticate(request)
      if (!result) return refusal(401, 'operator.unauthenticated', 'An operator API key is required')
      verified = result
    } catch (error) {
      if (error instanceof Response) return error
      options.onError?.(error, route.id)
      return refusal(503, 'operator.auth_unavailable', 'Key verification is unavailable', true)
    }

    const ctx: OperatorContext<Identity> = {
      identity: verified.identity,
      key: { keyId: verified.key.keyId, scopes: [...verified.key.scopes] },
      request,
    }
    const restriction = operatorKeyWorkspaces(verified.key.scopes)

    try {
      if (route.id === 'describe') {
        return json({
          app: {
            app: options.app.id, name: options.app.name, apiVersion: OPERATOR_API_VERSION,
            capabilities: capabilities(adapter),
          },
          principal: { keyId: ctx.key.keyId, scopes: [...ctx.key.scopes], workspaces: restriction ? [...restriction] : null },
        })
      }
      if (route.id === 'workspaces.list') {
        const listed = await adapter.listWorkspaces(ctx)
        return json({ workspaces: restriction ? listed.filter((workspace) => restriction.includes(workspace.id)) : listed })
      }
      if (route.id === 'workspaces.create') {
        if (restriction) {
          throw new OperatorError('operator.workspace_restricted', 403, 'A workspace-restricted key cannot create workspaces')
        }
        if (!adapter.createWorkspace) unsupported()
        const body = await readJsonBody(request)
        const unknown = Object.keys(body).filter((field) => field !== 'name')
        if (unknown.length) throw new OperatorError('operator.invalid_input', 400, `Unknown fields: ${unknown.join(', ')}`)
        const name = optionalString(body, 'name', 120)
        if (!name) throw new OperatorError('operator.invalid_input', 400, 'name is required')
        return json({ workspace: await adapter.createWorkspace(ctx, { name }) }, 201)
      }

      const workspaceId = params.workspaceId!
      if (restriction && !restriction.includes(workspaceId)) {
        throw new OperatorError('operator.workspace_not_found', 404, 'Workspace not found')
      }
      const workspace = await adapter.authorizeWorkspace(ctx, workspaceId, route.id === 'turns.start' ? 'run' : 'read')
      if (!workspace) throw new OperatorError('operator.workspace_not_found', 404, 'Workspace not found')

      switch (route.id) {
        case 'workspaces.get':
          return json({ workspace })
        case 'turns.start': {
          const input = parseStartTurn(await readJsonBody(request))
          return json({ turn: await adapter.startTurn(ctx, workspace, input) }, 202)
        }
        case 'threads.list': {
          if (!adapter.listThreads) unsupported()
          const limit = boundedInteger(url.searchParams.get('limit'), 25, 1, 100, 'limit')
          const cursor = url.searchParams.get('cursor') ?? undefined
          if (cursor !== undefined && (cursor.length > 512 || !cursor)) {
            throw new OperatorError('operator.invalid_input', 400, 'cursor is invalid')
          }
          return json(await adapter.listThreads(ctx, workspace, { limit, ...(cursor ? { cursor } : {}) }))
        }
        case 'threads.get': {
          if (!adapter.getThread) unsupported()
          const found = await adapter.getThread(ctx, workspace, params.threadId!)
          if (!found) throw new OperatorError('operator.thread_not_found', 404, 'Thread not found')
          return json(found)
        }
        case 'turns.get': {
          const target = { threadId: params.threadId!, turnId: params.turnId! }
          const wait = boundedInteger(url.searchParams.get('wait'), 0, 0, maxWaitSeconds, 'wait')
          const deadline = Date.now() + wait * 1000
          let turn = await adapter.getTurn(ctx, workspace, target)
          while (turn && !needsAttention(turn) && Date.now() + pollIntervalMs <= deadline && !request.signal.aborted) {
            await sleep(pollIntervalMs, request.signal)
            turn = await adapter.getTurn(ctx, workspace, target)
          }
          if (!turn) throw new OperatorError('operator.turn_not_found', 404, 'Turn not found')
          return json({ turn })
        }
        case 'approvals.list':
          return json({ approvals: await adapter.listApprovals(ctx, workspace) })
        case 'journal.list': {
          if (!adapter.listJournal) unsupported()
          const days = boundedInteger(url.searchParams.get('days'), 7, 1, 90, 'days')
          return json({ entries: await adapter.listJournal(ctx, workspace, { days }) })
        }
        case 'files.list': {
          if (!adapter.listFiles) unsupported()
          const prefix = relativePath(url.searchParams.get('prefix'), 'prefix', { allowEmpty: true })
          return json({ files: await adapter.listFiles(ctx, workspace, { prefix }) })
        }
        case 'files.read': {
          if (!adapter.readFile) unsupported()
          const path = relativePath(url.searchParams.get('path'), 'path', { allowEmpty: false })
          const file = await adapter.readFile(ctx, workspace, path)
          if (!file) throw new OperatorError('operator.file_not_found', 404, 'File not found')
          return json({ file })
        }
        case 'assets.read': {
          if (!adapter.readAsset) unsupported()
          const response = await adapter.readAsset(ctx, workspace, params.assetId!)
          if (!response) throw new OperatorError('operator.asset_not_found', 404, 'Asset not found')
          const headers = new Headers(response.headers)
          headers.set('cache-control', 'private, no-store')
          headers.delete('set-cookie')
          return new Response(response.body, { status: response.status, headers })
        }
        case 'scorecard.get': {
          if (!adapter.getScorecard) unsupported()
          const days = boundedInteger(url.searchParams.get('days'), 7, 1, 90, 'days')
          return json({ scorecard: await adapter.getScorecard(ctx, workspace, { days }) })
        }
      }
      return refusal(404, 'operator.route_not_found', 'No operator route matches this method and path')
    } catch (error) {
      if (error instanceof OperatorError) return refusal(error.status, error.code, error.message, error.retryable)
      if (error instanceof Response) return error
      options.onError?.(error, route.id)
      return refusal(500, 'operator.internal', 'The operation failed', true)
    }
  }

  return { matches, handle }
}
