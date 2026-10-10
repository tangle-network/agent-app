// Node + Postgres binding for the gateway. Run on the customer's own host:
//
//   DATABASE_URL=postgres://tangle_agent:...@db:5432/app \
//   GATEWAY_OPERATIONS=./operations.json GATEWAY_TOKENS=./tokens.txt \
//   node src/server.ts
//
//   node src/server.ts mint-token <token-id>   # prints a token once and its tokens.txt line

import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import pg from 'pg'
import { createGateway, hashToken, parseConfig, type AuditEntry, type Database, type TokenRecord } from './gateway.ts'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

/** tokens.txt: one "<token-id> <sha256-hex>" per line; # comments allowed.
 *  Re-read when the file changes, so deleting a line revokes on the next request. */
export function tokenFile(path: string): () => TokenRecord[] {
  let cached: { mtimeMs: number; size: number; tokens: TokenRecord[] } | undefined
  return () => {
    const stat = statSync(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.tokens
    const tokens = readFileSync(path, 'utf8').split('\n').map(line => line.trim())
      .filter(line => line && !line.startsWith('#')).map((line, index) => {
        const [id, sha256, extra] = line.split(/\s+/)
        if (!id || !sha256 || extra !== undefined || !/^[0-9a-f]{64}$/.test(sha256)) {
          throw new Error(`${path}:${index + 1} must be "<token-id> <sha256-hex>"`)
        }
        return { id, sha256 }
      })
    cached = { mtimeMs: stat.mtimeMs, size: stat.size, tokens }
    return tokens
  }
}

const AUDIT_SQL = `INSERT INTO tangle_gateway_audit
  (request_id, token_id, operation, access, arguments, outcome, row_count, error, duration_ms, client_ip)
  VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`

function auditValues(entry: AuditEntry): unknown[] {
  return [entry.requestId, entry.tokenId, entry.operation, entry.access, JSON.stringify(entry.arguments),
    entry.outcome, entry.rowCount, entry.error?.slice(0, 500) ?? null, entry.durationMs, entry.clientIp]
}

export function postgresDatabase(pool: pg.Pool): Database {
  return {
    async execute(op, values, timeoutMs, audit) {
      const client = await pool.connect()
      try {
        await client.query(op.access === 'read' ? 'BEGIN READ ONLY' : 'BEGIN')
        await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`)
        let result: pg.QueryResult
        try {
          result = await client.query(op.sql, values)
        } catch (error) {
          await client.query('ROLLBACK')
          await pool.query(AUDIT_SQL, auditValues(audit(error as Error)))
          throw error
        }
        const outcome = { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? result.rows.length }
        if (op.access === 'write') {
          // The write and its audit row commit together, or neither does.
          await client.query(AUDIT_SQL, auditValues(audit(outcome)))
          await client.query('COMMIT')
        } else {
          await client.query('COMMIT')
          // A read-only transaction cannot insert; rows are withheld if this fails.
          await pool.query(AUDIT_SQL, auditValues(audit(outcome)))
        }
        return outcome
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    },
    async recordFailure(entry) {
      await pool.query(AUDIT_SQL, auditValues(entry))
    },
  }
}

async function toRequest(req: IncomingMessage, port: number): Promise<Request> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 256 * 1024 + 1) break
    chunks.push(chunk as Buffer)
  }
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
  }
  return new Request(`http://localhost:${port}${req.url ?? '/'}`, {
    method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
  })
}

function mintToken(id: string) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) throw new Error('token id must be 1-64 of A-Z a-z 0-9 _ . -')
  const token = `tdg_${randomBytes(32).toString('base64url')}`
  process.stdout.write(`Token (shown once; give it to the agent's workspace as a secret):\n${token}\n\n`)
  process.stdout.write(`Append this line to your tokens file:\n${id} ${hashToken(token)}\n`)
}

async function main() {
  if (process.argv[2] === 'mint-token') return mintToken(process.argv[3] ?? '')
  const config = parseConfig(JSON.parse(readFileSync(required('GATEWAY_OPERATIONS'), 'utf8')), {
    maxRows: Number(process.env.GATEWAY_MAX_ROWS ?? 200),
    statementTimeoutMs: Number(process.env.GATEWAY_STATEMENT_TIMEOUT_MS ?? 5000),
  })
  const tokens = tokenFile(required('GATEWAY_TOKENS'))
  tokens()
  const pool = new pg.Pool({ connectionString: required('DATABASE_URL'), max: 5 })
  // The gateway role holds INSERT only on the audit table, so probe the privilege rather than read it.
  const probe = await pool.query(`SELECT has_table_privilege('tangle_gateway_audit', 'INSERT') AS can_audit`)
  if (!probe.rows[0]?.can_audit) throw new Error('the database role cannot insert into tangle_gateway_audit; run setup.sql')
  const handle = createGateway({ config, tokens, db: postgresDatabase(pool) })
  const port = Number(process.env.PORT ?? 8787)
  const path = process.env.GATEWAY_PATH ?? '/mcp'
  // Behind a proxy that sets X-Forwarded-For, set TRUST_PROXY=1 to record the client address it reports.
  const trustProxy = process.env.TRUST_PROXY === '1'
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/healthz') { res.writeHead(200).end('ok'); return }
      if (url.pathname !== path) { res.writeHead(404).end(); return }
      const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : ''
      const response = await handle(await toRequest(req, port), forwarded || req.socket.remoteAddress || null)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      console.error(JSON.stringify({ event: 'server-error', message: (error as Error).message }))
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal error' }))
    }
  }).listen(port, () => {
    console.log(JSON.stringify({ event: 'listening', port, path, operations: config.operations.map(op => op.name) }))
  })
}

main().catch(error => {
  console.error((error as Error).message)
  process.exit(1)
})
