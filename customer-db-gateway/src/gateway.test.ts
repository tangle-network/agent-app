import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigError, createGateway, hashToken, parseConfig, type AuditEntry, type Database, type TokenRecord } from './gateway.ts'

const config = parseConfig({
  operations: [
    { name: 'list_invoices', description: 'List invoices', access: 'read',
      sql: 'SELECT id FROM vendor_invoices WHERE status = $1', params: [{ name: 'status', type: 'string', enum: ['pending', 'paid'] }] },
    { name: 'record_invoice', description: 'Record an invoice', access: 'write',
      sql: 'INSERT INTO vendor_invoices (vendor_name, amount_cents) VALUES ($1, $2) RETURNING id',
      params: [{ name: 'vendor_name', type: 'string', maxLength: 10 }, { name: 'amount_cents', type: 'integer' }] },
  ],
})

const TOKEN = 'tdg_test-token'

function harness(opts: { fail?: Error } = {}) {
  const executed: Array<{ op: string; values: unknown[] }> = []
  const audits: AuditEntry[] = []
  let tokens: TokenRecord[] = [{ id: 'majo', sha256: hashToken(TOKEN) }]
  const db: Database = {
    async execute(op, values, _timeout, audit) {
      executed.push({ op: op.name, values })
      if (opts.fail) { audits.push(audit(opts.fail)); throw opts.fail }
      const result = { rows: [{ id: 7 }], rowCount: 1 }
      audits.push(audit(result))
      return result
    },
    async recordFailure(entry) { audits.push(entry) },
  }
  const handle = createGateway({ config, db, tokens: () => tokens, log: () => {}, requestId: () => 'req-1' })
  const call = async (body: unknown, token: string | null = TOKEN) => {
    const response = await handle(new Request('http://gw/mcp', { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }), '203.0.113.9')
    return { status: response.status, body: response.status === 202 ? null : await response.json() as any }
  }
  return { call, executed, audits, revoke: () => { tokens = [] } }
}

const toolCall = (name: string, args: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

describe('authentication', () => {
  it('refuses a missing or unknown token before any database work', async () => {
    const h = harness()
    assert.equal((await h.call(toolCall('list_invoices', { status: 'pending' }), null)).status, 401)
    assert.equal((await h.call(toolCall('list_invoices', { status: 'pending' }), 'tdg_wrong')).status, 401)
    assert.equal(h.executed.length, 0)
    assert.equal(h.audits.length, 0)
  })

  it('revoking a token takes effect on the next request', async () => {
    const h = harness()
    assert.equal((await h.call(toolCall('list_invoices', { status: 'pending' }))).status, 200)
    h.revoke()
    assert.equal((await h.call(toolCall('list_invoices', { status: 'pending' }))).status, 401)
    assert.equal(h.executed.length, 1)
  })
})

describe('MCP protocol', () => {
  it('lists only configured operations, marking reads read-only', async () => {
    const { body } = await harness().call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.deepEqual(body.result.tools.map((t: any) => [t.name, t.annotations.readOnlyHint]),
      [['list_invoices', true], ['record_invoice', false]])
    assert.equal(body.result.tools[1].inputSchema.additionalProperties, false)
  })

  it('negotiates a supported protocol version and acknowledges notifications with 202', async () => {
    const h = harness()
    const init = await h.call({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
    assert.equal(init.body.result.protocolVersion, '2025-03-26')
    assert.equal((await h.call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  })
})

describe('operations', () => {
  it('binds named arguments positionally and audits the call with its token id', async () => {
    const h = harness()
    const { body } = await h.call(toolCall('record_invoice', { vendor_name: 'Luis', amount_cents: 45000 }))
    assert.deepEqual(body.result.structuredContent.rows, [{ id: 7 }])
    assert.deepEqual(h.executed, [{ op: 'record_invoice', values: ['Luis', 45000] }])
    assert.equal(h.audits[0]!.tokenId, 'majo')
    assert.equal(h.audits[0]!.outcome, 'ok')
    assert.equal(h.audits[0]!.clientIp, '203.0.113.9')
  })

  for (const [label, args] of [
    ['an unknown argument', { status: 'pending', extra: 1 }],
    ['a value outside the enum', { status: "pending' OR 1=1 --" }],
    ['a wrong type', { status: 5 }],
    ['a missing required argument', {}],
  ] as const) {
    it(`rejects ${label} without touching the database and records the refusal`, async () => {
      const h = harness()
      const { body } = await h.call(toolCall('list_invoices', args))
      assert.equal(body.result.isError, true)
      assert.equal(h.executed.length, 0)
      assert.equal(h.audits[0]!.outcome, 'error')
    })
  }

  it('rejects operations that are not configured', async () => {
    const h = harness()
    const { body } = await h.call(toolCall('drop_everything', {}))
    assert.equal(body.result.isError, true)
    assert.equal(h.executed.length, 0)
  })

  it('reports a database failure as a tool error, not rows', async () => {
    const h = harness({ fail: new Error('permission denied for table guests') })
    const { body } = await h.call(toolCall('list_invoices', { status: 'paid' }))
    assert.equal(body.result.isError, true)
    assert.match(body.result.content[0].text, /permission denied/)
    assert.equal(h.audits[0]!.outcome, 'error')
  })
})

describe('configuration', () => {
  const op = (sql: string, params: unknown[] = []) => ({ operations: [{ name: 'x', description: 'x', access: 'read', sql, params }] })
  it('refuses multiple statements', () => {
    assert.throws(() => parseConfig(op('SELECT 1; DELETE FROM t')), ConfigError)
  })
  it('refuses placeholders that do not match declared params', () => {
    assert.throws(() => parseConfig(op('SELECT $2', [{ name: 'a', type: 'string' }])), ConfigError)
    assert.throws(() => parseConfig(op('SELECT 1', [{ name: 'a', type: 'string' }])), ConfigError)
  })
})
