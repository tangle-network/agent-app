// Customer-hosted database gateway: the customer runs this next to their own
// database, so the database credential never leaves their infrastructure.
// An agent reaches it as a remote MCP server and can run only the named,
// parameterized operations the customer configured. Every authenticated call
// is recorded in the customer's own audit table before its result is returned.
//
// This module is runtime-neutral (Fetch API Request/Response); server.ts binds
// it to Node and Postgres.

import { createHash, timingSafeEqual } from 'node:crypto'

export type ParamType = 'string' | 'integer' | 'number' | 'boolean'

export interface OperationParam {
  name: string
  type: ParamType
  description?: string
  required?: boolean
  enum?: Array<string | number>
  maxLength?: number
}

export interface Operation {
  name: string
  description: string
  access: 'read' | 'write'
  sql: string
  params: OperationParam[]
}

export interface GatewayConfig {
  operations: Operation[]
  maxRows: number
  statementTimeoutMs: number
}

export interface TokenRecord { id: string; sha256: string }

export interface AuditEntry {
  requestId: string
  tokenId: string
  operation: string
  access: 'read' | 'write'
  arguments: Record<string, unknown>
  outcome: 'ok' | 'error'
  rowCount: number | null
  error: string | null
  durationMs: number
  clientIp: string | null
}

export interface OperationResult { rows: Record<string, unknown>[]; rowCount: number }

export interface Database {
  /** Run one operation and record its audit entry. A write and its audit row
   *  commit together; a read's rows are withheld when its audit row fails. */
  execute(op: Operation, values: unknown[], timeoutMs: number,
    audit: (result: OperationResult | Error) => AuditEntry): Promise<OperationResult>
  /** Record a call that failed before reaching the database. */
  recordFailure(entry: AuditEntry): Promise<void>
}

export interface GatewayDeps {
  config: GatewayConfig
  tokens: () => TokenRecord[] | Promise<TokenRecord[]>
  db: Database
  log?: (line: Record<string, unknown>) => void
  now?: () => number
  requestId?: () => string
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY_BYTES = 256 * 1024
const NAME = /^[a-z][a-z0-9_]{0,63}$/

export class ConfigError extends Error {}

/** Validate a parsed operations file; refuses anything ambiguous. */
export function parseConfig(raw: unknown, defaults: { maxRows?: number; statementTimeoutMs?: number } = {}): GatewayConfig {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { operations?: unknown }).operations)) {
    throw new ConfigError('operations file must be an object with an "operations" array')
  }
  const seen = new Set<string>()
  const operations = (raw as { operations: unknown[] }).operations.map((value, index): Operation => {
    const op = value as Partial<Operation>
    const where = `operations[${index}]`
    if (typeof op.name !== 'string' || !NAME.test(op.name)) throw new ConfigError(`${where}.name must match ${NAME}`)
    if (seen.has(op.name)) throw new ConfigError(`${where}.name "${op.name}" is duplicated`)
    seen.add(op.name)
    if (typeof op.description !== 'string' || !op.description.trim()) throw new ConfigError(`${where}.description is required`)
    if (op.access !== 'read' && op.access !== 'write') throw new ConfigError(`${where}.access must be "read" or "write"`)
    if (typeof op.sql !== 'string' || !op.sql.trim()) throw new ConfigError(`${where}.sql is required`)
    if (op.sql.replace(/;\s*$/, '').includes(';')) throw new ConfigError(`${where}.sql must be a single statement`)
    const params = (op.params ?? []).map((p, i) => {
      const param = p as Partial<OperationParam>
      if (typeof param.name !== 'string' || !NAME.test(param.name)) throw new ConfigError(`${where}.params[${i}].name must match ${NAME}`)
      if (!['string', 'integer', 'number', 'boolean'].includes(param.type as string)) {
        throw new ConfigError(`${where}.params[${i}].type must be string, integer, number or boolean`)
      }
      return { ...param, required: param.required !== false } as OperationParam
    })
    const placeholders = new Set([...op.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])))
    for (const n of placeholders) {
      if (n < 1 || n > params.length) throw new ConfigError(`${where}.sql uses $${n} but declares ${params.length} params`)
    }
    if (placeholders.size !== params.length) throw new ConfigError(`${where}.sql must use every declared param exactly as $1..$${params.length}`)
    return { name: op.name, description: op.description, access: op.access, sql: op.sql, params }
  })
  return {
    operations,
    maxRows: defaults.maxRows ?? 200,
    statementTimeoutMs: defaults.statementTimeoutMs ?? 5000,
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time match of a bearer token against the current token list. */
export function matchToken(token: string, tokens: TokenRecord[]): TokenRecord | null {
  const presented = Buffer.from(hashToken(token), 'hex')
  let found: TokenRecord | null = null
  for (const record of tokens) {
    const expected = Buffer.from(record.sha256, 'hex')
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) found = record
  }
  return found
}

function inputSchema(op: Operation) {
  const properties: Record<string, Record<string, unknown>> = {}
  for (const p of op.params) {
    properties[p.name] = {
      type: p.type,
      ...(p.description ? { description: p.description } : {}),
      ...(p.enum ? { enum: p.enum } : {}),
      ...(p.maxLength ? { maxLength: p.maxLength } : {}),
    }
  }
  return { type: 'object', properties, required: op.params.filter(p => p.required).map(p => p.name), additionalProperties: false }
}

class ArgumentError extends Error {}

/** Validate tool arguments against the operation and return positional values. */
export function bindArguments(op: Operation, args: unknown): unknown[] {
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
    throw new ArgumentError('arguments must be an object')
  }
  const input = (args ?? {}) as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!op.params.some(p => p.name === key)) throw new ArgumentError(`unknown argument "${key}"`)
  }
  return op.params.map(p => {
    const value = input[p.name]
    if (value === undefined || value === null) {
      if (p.required) throw new ArgumentError(`missing argument "${p.name}"`)
      return null
    }
    const ok = p.type === 'string' ? typeof value === 'string'
      : p.type === 'boolean' ? typeof value === 'boolean'
        : p.type === 'integer' ? Number.isSafeInteger(value)
          : typeof value === 'number' && Number.isFinite(value)
    if (!ok) throw new ArgumentError(`argument "${p.name}" must be ${p.type}`)
    if (p.enum && !p.enum.includes(value as string | number)) throw new ArgumentError(`argument "${p.name}" must be one of ${p.enum.join(', ')}`)
    if (p.maxLength && typeof value === 'string' && value.length > p.maxLength) {
      throw new ArgumentError(`argument "${p.name}" is longer than ${p.maxLength}`)
    }
    return value
  })
}

type JsonRpcId = string | number | null
interface JsonRpcRequest { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, unknown> }

function rpcResult(id: JsonRpcId, result: unknown) { return { jsonrpc: '2.0', id, result } }
function rpcError(id: JsonRpcId, code: number, message: string) { return { jsonrpc: '2.0', id, error: { code, message } } }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function toolText(payload: unknown, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError: true } : { structuredContent: payload }) }
}

/** Build the gateway's request handler. Mount it at the MCP path. */
export function createGateway(deps: GatewayDeps): (request: Request, clientIp?: string | null) => Promise<Response> {
  const log = deps.log ?? (line => console.log(JSON.stringify(line)))
  const now = deps.now ?? Date.now
  const nextId = deps.requestId ?? (() => crypto.randomUUID())
  const byName = new Map(deps.config.operations.map(op => [op.name, op]))
  const tools = deps.config.operations.map(op => ({
    name: op.name,
    description: `${op.description} (${op.access === 'read' ? 'read-only' : 'writes data'})`,
    inputSchema: inputSchema(op),
    annotations: { readOnlyHint: op.access === 'read', destructiveHint: false },
  }))

  async function callTool(id: JsonRpcId, params: Record<string, unknown>, tokenId: string, clientIp: string | null) {
    const requestId = nextId()
    const started = now()
    const name = params.name
    const op = typeof name === 'string' ? byName.get(name) : undefined
    const args = (params.arguments ?? {}) as Record<string, unknown>
    const entry = (outcome: 'ok' | 'error', rowCount: number | null, error: string | null): AuditEntry => ({
      requestId, tokenId, operation: typeof name === 'string' ? name.slice(0, 64) : '(none)', access: op?.access ?? 'read',
      arguments: args && typeof args === 'object' ? args : {}, outcome, rowCount, error, durationMs: now() - started, clientIp,
    })
    if (!op) {
      const failure = entry('error', null, 'unknown operation')
      await deps.db.recordFailure(failure)
      log({ event: 'call', ...failure })
      return rpcResult(id, toolText({ error: `Unknown operation. Available: ${[...byName.keys()].join(', ')}` }, true))
    }
    let values: unknown[]
    try {
      values = bindArguments(op, args)
    } catch (error) {
      const failure = entry('error', null, (error as Error).message)
      await deps.db.recordFailure(failure)
      log({ event: 'call', ...failure })
      return rpcResult(id, toolText({ error: (error as Error).message }, true))
    }
    let recorded: AuditEntry | undefined
    try {
      const result = await deps.db.execute(op, values, deps.config.statementTimeoutMs, outcome => {
        recorded = outcome instanceof Error ? entry('error', null, outcome.message) : entry('ok', outcome.rowCount, null)
        return recorded
      })
      const truncated = result.rows.length > deps.config.maxRows
      const payload = { operation: op.name, rowCount: result.rowCount, rows: result.rows.slice(0, deps.config.maxRows),
        ...(truncated ? { truncated: true } : {}), requestId }
      log({ event: 'call', ...recorded })
      return rpcResult(id, toolText(payload))
    } catch (error) {
      log({ event: 'call', ...(recorded ?? entry('error', null, (error as Error).message)) })
      return rpcResult(id, toolText({ error: (error as Error).message, requestId }, true))
    }
  }

  async function dispatch(message: JsonRpcRequest, tokenId: string, clientIp: string | null) {
    const id = message.id ?? null
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion
        const protocolVersion = typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]
        return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'customer-db-gateway', version: '0.1.0' },
          instructions: 'Each tool is a fixed operation on the business database. Call only what the task needs.' })
      }
      case 'ping': return rpcResult(id, {})
      case 'tools/list': return rpcResult(id, { tools })
      case 'tools/call': return callTool(id, message.params ?? {}, tokenId, clientIp)
      default: return rpcError(id, -32601, `Method not found: ${String(message.method)}`)
    }
  }

  return async (request, clientIp = null) => {
    if (request.method !== 'POST') return json({ error: 'Use POST with MCP JSON-RPC.' }, 405, { allow: 'POST' })
    const auth = request.headers.get('authorization') ?? ''
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1]
    const match = token ? matchToken(token, await deps.tokens()) : null
    if (!match) {
      log({ event: 'denied', reason: token ? 'unknown or revoked token' : 'missing bearer token', clientIp, at: new Date(now()).toISOString() })
      return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' })
    }
    const length = Number(request.headers.get('content-length') ?? '0')
    if (length > MAX_BODY_BYTES) return json(rpcError(null, -32600, 'Request too large'), 413)
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return json(rpcError(null, -32600, 'Request too large'), 413)
    let body: unknown
    try { body = JSON.parse(text) } catch { return json(rpcError(null, -32700, 'Parse error'), 400) }
    const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[]
    const responses = []
    for (const message of messages) {
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        responses.push(rpcError(null, -32600, 'Invalid Request'))
        continue
      }
      if (message.id === undefined) continue // notification: no response body
      responses.push(await dispatch(message, match.id, clientIp))
    }
    if (responses.length === 0) return new Response(null, { status: 202 })
    return json(Array.isArray(body) ? responses : responses[0])
  }
}
