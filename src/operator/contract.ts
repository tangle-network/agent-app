/**
 * The standard operator API contract every agent app mounts at
 * `/api/operator/v1`. An outside agent (a Claude Code or Codex session, or
 * another app's agent) holds one scoped key per app and drives workspaces
 * through these routes; the app supplies only storage and execution.
 */

export const OPERATOR_API_VERSION = 'v1'
export const OPERATOR_API_BASE_PATH = '/api/operator/v1'

/** Key permissions, with the labels an app's API access page shows. */
export const OPERATOR_ACCESS = [
  {
    scope: 'operator:read',
    label: 'Read workspaces',
    description: 'Read workspaces, conversations, files, approvals, scorecards, and run status.',
  },
  {
    scope: 'operator:write',
    label: 'Create and edit',
    description: 'Create workspaces and conversations, and write files.',
  },
  {
    scope: 'operator:run',
    requires: ['operator:read'],
    label: 'Run agents',
    description: 'Requires read access. Start and continue agent turns, which can modify workspace files. Uses your plan and budget.',
  },
] as const

export type OperatorScope = typeof OPERATOR_ACCESS[number]['scope']

export const OPERATOR_API_SCOPES: readonly OperatorScope[] = OPERATOR_ACCESS.map(({ scope }) => scope)

export const OPERATOR_SCOPE_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  OPERATOR_ACCESS.flatMap((option) => 'requires' in option ? [[option.scope, option.requires]] : []),
)

/**
 * A key carrying one or more of these scopes reaches only the named
 * workspaces and cannot create workspaces. Keys without one keep the owner's
 * ordinary workspace access.
 */
export const OPERATOR_WORKSPACE_SCOPE_PREFIX = 'operator:workspace:'

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/

export function operatorWorkspaceScope(workspaceId: string): string {
  if (!WORKSPACE_ID.test(workspaceId)) throw new TypeError('Workspace ids contain only letters, digits, - and _')
  return `${OPERATOR_WORKSPACE_SCOPE_PREFIX}${workspaceId}`
}

/** The workspaces a key is restricted to, or null when it is unrestricted. A malformed restriction restricts to nothing. */
export function operatorKeyWorkspaces(scopes: readonly string[]): readonly string[] | null {
  const restricted = scopes.filter((scope) => scope.startsWith(OPERATOR_WORKSPACE_SCOPE_PREFIX))
  if (restricted.length === 0) return null
  return restricted
    .map((scope) => scope.slice(OPERATOR_WORKSPACE_SCOPE_PREFIX.length))
    .filter((id) => WORKSPACE_ID.test(id))
}

export type OperatorRole = 'owner' | 'admin' | 'editor' | 'viewer'

export interface OperatorAppInfo {
  /** Stable app identifier, such as `gtm` or `tax`. */
  app: string
  name: string
  apiVersion: typeof OPERATOR_API_VERSION
  /** Optional operations this app implements; absent ones answer 501. */
  capabilities: OperatorCapability[]
}

export type OperatorCapability =
  | 'workspaces.create'
  | 'threads.read'
  | 'files.read'
  | 'journal.read'
  | 'assets.read'
  | 'scorecard.read'

export interface OperatorPrincipalInfo {
  keyId: string
  scopes: string[]
  /** Workspaces the key is restricted to, or null for the owner's ordinary access. */
  workspaces: string[] | null
}

export interface OperatorWorkspace {
  id: string
  name: string
  role?: OperatorRole
  /** Browser link for a person to open the workspace. */
  url?: string
  createdAt?: string
}

export interface OperatorThread {
  id: string
  title: string
  updatedAt?: string
  url?: string
}

/**
 * `succeeded` and `failed` are settled. `input-required` waits on a person or
 * an operator decision listed in `approvals`. `unknown` means the app cannot
 * establish the state; it is never evidence of success.
 */
export type OperatorTurnState = 'queued' | 'working' | 'input-required' | 'succeeded' | 'failed' | 'unknown'

export const OPERATOR_SETTLED_STATES: readonly OperatorTurnState[] = ['succeeded', 'failed']

export interface OperatorAssetRef {
  id: string
  /** Root-relative operator route that returns the bytes. */
  path: string
  mediaType?: string
  name?: string
}

export interface OperatorFileChange {
  path: string
  action: 'created' | 'updated' | 'deleted' | 'changed'
}

export type OperatorApprovalKind = 'question' | 'permission' | 'plan' | 'hub' | 'asset' | 'review'

export interface OperatorApproval {
  id: string
  kind: OperatorApprovalKind
  title: string
  detail?: string
  threadId?: string
  /** Browser link where an authorized person decides it. */
  url?: string
  createdAt?: string
  expiresAt?: string
  /** Who can decide: an operator key with run access, an editor, or the workspace owner. */
  decidedBy: 'operator' | 'editor' | 'owner'
}

export interface OperatorTurn {
  workspaceId: string
  threadId: string
  turnId: string
  state: OperatorTurnState
  url?: string
  executionId?: string
  model?: string
  costUsd?: number
  completedAt?: string
  /** The settled answer; null until the turn settles. */
  reply: { content: string; mediaType: string } | null
  failure: { code?: string; message: string } | null
  assets: OperatorAssetRef[]
  files: OperatorFileChange[]
  /** Decisions open on this turn's conversation. */
  approvals: OperatorApproval[]
}

export interface OperatorJournalEntry {
  path: string
  /** `YYYY-MM-DD` the entry belongs to. */
  date: string
  title?: string
  updatedAt?: string
}

export interface OperatorFileEntry {
  path: string
  updatedAt?: string
  bytes?: number
}

export interface OperatorFile {
  path: string
  content: string
  mediaType: string
  revision?: string
}

export interface OperatorMetric {
  key: string
  label: string
  /** Null when the app has no measurement; never a guessed zero. */
  value: number | null
  unit: 'count' | 'usd' | 'ratio' | 'ms'
  note?: string
}

export interface OperatorScorecard {
  workspaceId: string
  generatedAt: string
  window: { start: string; end: string; days: number }
  /** Work the agent did in the window. */
  metrics: OperatorMetric[]
  /** Business results recorded in the window, such as clicks, signups, or replies. */
  outcomes: OperatorMetric[]
  /** How the numbers are measured and what they exclude. */
  measurement: string
}

export interface OperatorErrorBody {
  error: string
  code: string
  retryable?: boolean
}

export interface StartTurnInput {
  /** Client-generated UUID. Reuse it to retry the same turn; it never starts twice. */
  turnId: string
  content: string
  /** Continue this conversation; omitted starts a new one. */
  threadId?: string
  /** Title for a new conversation. */
  title?: string
  model?: string
}

/** Route table: method, path pattern under the base path, and required scopes. */
export const OPERATOR_ROUTES = [
  { id: 'describe', method: 'GET', path: '', scopes: ['operator:read'] },
  { id: 'workspaces.list', method: 'GET', path: '/workspaces', scopes: ['operator:read'] },
  { id: 'workspaces.create', method: 'POST', path: '/workspaces', scopes: ['operator:write'] },
  { id: 'workspaces.get', method: 'GET', path: '/workspaces/:workspaceId', scopes: ['operator:read'] },
  { id: 'turns.start', method: 'POST', path: '/workspaces/:workspaceId/turns', scopes: ['operator:read', 'operator:run'] },
  { id: 'threads.list', method: 'GET', path: '/workspaces/:workspaceId/threads', scopes: ['operator:read'] },
  { id: 'threads.get', method: 'GET', path: '/workspaces/:workspaceId/threads/:threadId', scopes: ['operator:read'] },
  { id: 'turns.get', method: 'GET', path: '/workspaces/:workspaceId/threads/:threadId/turns/:turnId', scopes: ['operator:read'] },
  { id: 'approvals.list', method: 'GET', path: '/workspaces/:workspaceId/approvals', scopes: ['operator:read'] },
  { id: 'journal.list', method: 'GET', path: '/workspaces/:workspaceId/journal', scopes: ['operator:read'] },
  { id: 'files.list', method: 'GET', path: '/workspaces/:workspaceId/files', scopes: ['operator:read'] },
  { id: 'files.read', method: 'GET', path: '/workspaces/:workspaceId/file', scopes: ['operator:read'] },
  { id: 'assets.read', method: 'GET', path: '/workspaces/:workspaceId/assets/:assetId', scopes: ['operator:read'] },
  { id: 'scorecard.get', method: 'GET', path: '/workspaces/:workspaceId/scorecard', scopes: ['operator:read'] },
] as const satisfies ReadonlyArray<{ id: string; method: 'GET' | 'POST'; path: string; scopes: readonly OperatorScope[] }>

export type OperatorRouteId = typeof OPERATOR_ROUTES[number]['id']

const SEGMENT = /^[A-Za-z0-9_:.%-]{1,256}$/

/** Match a pathname under the base path to its route and decoded parameters. */
export function matchOperatorRoute(
  method: string,
  pathname: string,
  basePath: string = OPERATOR_API_BASE_PATH,
): { route: typeof OPERATOR_ROUTES[number]; params: Record<string, string> } | null {
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return null
  const rest = pathname.slice(basePath.length).replace(/\/$/, '')
  const actual = rest ? rest.split('/').slice(1) : []
  for (const route of OPERATOR_ROUTES) {
    if (route.method !== method) continue
    const pattern = route.path ? route.path.split('/').slice(1) : []
    if (pattern.length !== actual.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let index = 0; index < pattern.length; index++) {
      const expected = pattern[index]!
      const segment = actual[index]!
      if (expected.startsWith(':')) {
        if (!SEGMENT.test(segment)) { matched = false; break }
        let decoded: string
        try { decoded = decodeURIComponent(segment) } catch { matched = false; break }
        if (!decoded || decoded.includes('/')) { matched = false; break }
        params[expected.slice(1)] = decoded
      } else if (expected !== segment) {
        matched = false
        break
      }
    }
    if (matched) return { route, params }
  }
  return null
}
