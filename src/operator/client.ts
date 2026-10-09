import { createApiKeyFetch } from '../web/api-key-fetch.js'
import {
  OPERATOR_API_BASE_PATH,
  type OperatorApproval,
  type OperatorAppInfo,
  type OperatorErrorBody,
  type OperatorFile,
  type OperatorFileEntry,
  type OperatorJournalEntry,
  type OperatorPrincipalInfo,
  type OperatorScorecard,
  type OperatorThread,
  type OperatorTurn,
  type OperatorWorkspace,
  type StartTurnInput,
} from './contract.js'

export type OperatorResult<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; status: number; code: string; error: string; retryable: boolean }

export interface OperatorClientOptions {
  /** The app's origin, such as `https://gtm.tangle.tools`. */
  origin: string
  /** Resolve the key from trusted secret storage on each request; never from model output. */
  getApiKey(): string | Promise<string>
  fetchImpl?: typeof fetch
  allowHttpLoopback?: boolean
  basePath?: string
}

export interface WaitForTurnOptions {
  /** Total time to follow the turn. */
  timeoutMs: number
  /** Server hold per request, in seconds; the server caps it. */
  waitSeconds?: number
  signal?: AbortSignal
}

export interface OperatorClient {
  describe(): Promise<OperatorResult<{ app: OperatorAppInfo; principal: OperatorPrincipalInfo }>>
  listWorkspaces(): Promise<OperatorResult<OperatorWorkspace[]>>
  createWorkspace(input: { name: string }): Promise<OperatorResult<OperatorWorkspace>>
  getWorkspace(workspaceId: string): Promise<OperatorResult<OperatorWorkspace>>
  /** Omitting turnId generates one; retry with the returned turn's id. */
  startTurn(workspaceId: string, input: Omit<StartTurnInput, 'turnId'> & { turnId?: string }): Promise<OperatorResult<OperatorTurn>>
  getTurn(workspaceId: string, threadId: string, turnId: string, options?: { waitSeconds?: number; signal?: AbortSignal }): Promise<OperatorResult<OperatorTurn>>
  /** Follow until the turn settles, waits on a decision, or the timeout passes; the last read is returned. */
  waitForTurn(workspaceId: string, threadId: string, turnId: string, options: WaitForTurnOptions): Promise<OperatorResult<OperatorTurn>>
  listThreads(workspaceId: string, query?: { cursor?: string; limit?: number }): Promise<OperatorResult<{ threads: OperatorThread[]; nextCursor: string | null }>>
  getThread(workspaceId: string, threadId: string): Promise<OperatorResult<{ thread: OperatorThread; latestTurn: OperatorTurn | null }>>
  listApprovals(workspaceId: string): Promise<OperatorResult<OperatorApproval[]>>
  listJournal(workspaceId: string, query?: { days?: number }): Promise<OperatorResult<OperatorJournalEntry[]>>
  listFiles(workspaceId: string, query?: { prefix?: string }): Promise<OperatorResult<OperatorFileEntry[]>>
  readFile(workspaceId: string, path: string): Promise<OperatorResult<OperatorFile>>
  /** The raw asset response; the caller reads and bounds its body. */
  readAsset(workspaceId: string, assetId: string, init?: { signal?: AbortSignal }): Promise<OperatorResult<Response>>
  getScorecard(workspaceId: string, query?: { days?: number }): Promise<OperatorResult<OperatorScorecard>>
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

async function failure(response: Response): Promise<OperatorResult<never>> {
  let body: Partial<OperatorErrorBody> = {}
  try { body = await response.json() as Partial<OperatorErrorBody> } catch { /* A non-JSON refusal keeps its status. */ }
  return {
    succeeded: false,
    status: response.status,
    code: typeof body.code === 'string' ? body.code : `http_${response.status}`,
    error: typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    retryable: body.retryable === true || response.status === 429 || response.status >= 500,
  }
}

function transportFailure(error: unknown): OperatorResult<never> {
  const aborted = error instanceof Error && error.name === 'AbortError'
  return {
    succeeded: false,
    status: 0,
    code: aborted ? 'operator.aborted' : 'operator.transport_failed',
    // createApiKeyFetch never forwards transport diagnostics, which could carry the key.
    error: error instanceof Error ? error.message : 'Operator transport failed',
    retryable: !aborted,
  }
}

const SETTLED = new Set(['succeeded', 'failed', 'input-required'])

/** A typed client for one app's operator API. */
export function createOperatorClient(options: OperatorClientOptions): OperatorClient {
  const basePath = (options.basePath ?? OPERATOR_API_BASE_PATH).replace(/\/$/, '')
  const request = createApiKeyFetch({
    origin: options.origin,
    getApiKey: options.getApiKey,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.allowHttpLoopback ? { allowHttpLoopback: true } : {}),
  })

  async function call<T>(
    path: string,
    pick: (body: Record<string, unknown>) => T,
    init: RequestInit = {},
  ): Promise<OperatorResult<T>> {
    let response: Response
    try {
      response = await request(`${basePath}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      })
    } catch (error) {
      return transportFailure(error)
    }
    if (!response.ok) return failure(response)
    try {
      return { succeeded: true, value: pick(await response.json() as Record<string, unknown>) }
    } catch {
      return { succeeded: false, status: response.status, code: 'operator.invalid_response', error: 'The response was not the expected JSON', retryable: true }
    }
  }

  const query = (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams()
    for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(name, String(value))
    const text = search.toString()
    return text ? `?${text}` : ''
  }

  const client: OperatorClient = {
    describe: () => call('', (body) => body as unknown as { app: OperatorAppInfo; principal: OperatorPrincipalInfo }),
    listWorkspaces: () => call('/workspaces', (body) => body.workspaces as OperatorWorkspace[]),
    createWorkspace: (input) => call('/workspaces', (body) => body.workspace as OperatorWorkspace, {
      method: 'POST', body: JSON.stringify({ name: input.name }),
    }),
    getWorkspace: (workspaceId) => call(`/workspaces/${segment(workspaceId)}`, (body) => body.workspace as OperatorWorkspace),
    startTurn: (workspaceId, input) => call(`/workspaces/${segment(workspaceId)}/turns`, (body) => body.turn as OperatorTurn, {
      method: 'POST', body: JSON.stringify({ ...input, turnId: input.turnId ?? crypto.randomUUID() }),
    }),
    getTurn: (workspaceId, threadId, turnId, opts = {}) => call(
      `/workspaces/${segment(workspaceId)}/threads/${segment(threadId)}/turns/${segment(turnId)}${query({ wait: opts.waitSeconds })}`,
      (body) => body.turn as OperatorTurn,
      opts.signal ? { signal: opts.signal } : {},
    ),
    async waitForTurn(workspaceId, threadId, turnId, opts) {
      const deadline = Date.now() + opts.timeoutMs
      const waitSeconds = opts.waitSeconds ?? 25
      let last: OperatorResult<OperatorTurn> | null = null
      while (true) {
        const remaining = Math.floor((deadline - Date.now()) / 1000)
        const started = Date.now()
        last = await client.getTurn(workspaceId, threadId, turnId, {
          waitSeconds: Math.max(0, Math.min(waitSeconds, remaining)),
          ...(opts.signal ? { signal: opts.signal } : {}),
        })
        if (!last.succeeded) {
          if (!last.retryable || Date.now() >= deadline || opts.signal?.aborted) return last
          await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, Math.max(0, deadline - Date.now()))))
          continue
        }
        if (SETTLED.has(last.value.state) || last.value.approvals.length > 0) return last
        if (Date.now() >= deadline || opts.signal?.aborted) return last
        // A server that does not hold the read still gets a bounded request rate.
        if (Date.now() - started < 1_000) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, Math.max(0, deadline - Date.now()))))
        }
      }
    },
    listThreads: (workspaceId, q = {}) => call(
      `/workspaces/${segment(workspaceId)}/threads${query({ cursor: q.cursor, limit: q.limit })}`,
      (body) => ({ threads: body.threads as OperatorThread[], nextCursor: (body.nextCursor as string | null) ?? null }),
    ),
    getThread: (workspaceId, threadId) => call(
      `/workspaces/${segment(workspaceId)}/threads/${segment(threadId)}`,
      (body) => ({ thread: body.thread as OperatorThread, latestTurn: (body.latestTurn as OperatorTurn | null) ?? null }),
    ),
    listApprovals: (workspaceId) => call(`/workspaces/${segment(workspaceId)}/approvals`, (body) => body.approvals as OperatorApproval[]),
    listJournal: (workspaceId, q = {}) => call(
      `/workspaces/${segment(workspaceId)}/journal${query({ days: q.days })}`,
      (body) => body.entries as OperatorJournalEntry[],
    ),
    listFiles: (workspaceId, q = {}) => call(
      `/workspaces/${segment(workspaceId)}/files${query({ prefix: q.prefix })}`,
      (body) => body.files as OperatorFileEntry[],
    ),
    readFile: (workspaceId, path) => call(
      `/workspaces/${segment(workspaceId)}/file${query({ path })}`,
      (body) => body.file as OperatorFile,
    ),
    async readAsset(workspaceId, assetId, init = {}) {
      let response: Response
      try {
        response = await request(`${basePath}/workspaces/${segment(workspaceId)}/assets/${segment(assetId)}`, init.signal ? { signal: init.signal } : {})
      } catch (error) {
        return transportFailure(error)
      }
      if (!response.ok) return failure(response)
      return { succeeded: true, value: response }
    },
    getScorecard: (workspaceId, q = {}) => call(
      `/workspaces/${segment(workspaceId)}/scorecard${query({ days: q.days })}`,
      (body) => body.scorecard as OperatorScorecard,
    ),
  }
  return client
}
