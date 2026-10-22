import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { createWorkspacePrewarmRoute, type WorkspacePrewarmResponse, type WorkspaceWarmStep } from './prewarm-route'
import { createD1WarmReceiptStore, warmKey, warmReceiptId, WARM_RECEIPT_TABLE_DDL, type WarmReceiptD1Like } from './warm-receipts'

const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0 Safari/537.36'

/** A real SQLite behind the narrow D1 shape, shared by every route instance as D1 is shared by every isolate. */
function d1(db: DatabaseSync): WarmReceiptD1Like {
  return {
    prepare(query: string) {
      const stmt = db.prepare(query)
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              return (stmt.get(...(values as never[])) as T | undefined) ?? null
            },
            async run() {
              return stmt.run(...(values as never[]))
            },
          }
        },
      }
    },
  }
}

function post(body: Record<string, unknown> = { reason: 'page-open' }): Request {
  return new Request('https://app.test/api/workspaces/w1/prewarm', {
    method: 'POST',
    headers: { 'user-agent': BROWSER, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('stepped warm with receipts', () => {
  it('warms each step once, answers hit from any isolate until its key changes or its receipt expires', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(WARM_RECEIPT_TABLE_DDL)
    const receipts = createD1WarmReceiptStore(d1(db))
    let clock = 1_000_000
    const runs: string[] = []
    let vaultHead = 'head-1'
    const seen: Array<{ reason: string; threadId?: string }> = []
    const route = () => createWorkspacePrewarmRoute({
      receipts,
      now: () => clock,
      authorize: async ({ reason, threadId }) => {
        seen.push({ reason, ...(threadId ? { threadId } : {}) })
        const step = (name: string, key: string, ttlMs: number, fail = false): WorkspaceWarmStep => ({
          name, key, ttlMs,
          run: async () => {
            runs.push(name)
            if (fail) throw new Error(`${name} down`)
            return { name }
          },
        })
        return {
          status: 'allowed',
          steps: [
            step('session', await warmKey({ userId: 'u1', workspaceId: 'w1' }), 600_000),
            step('vault_heads', await warmKey({ workspaceId: 'w1', head: vaultHead }), 600_000),
            step('tool_catalog', await warmKey({ userId: 'u1' }), 60_000),
            ...(threadId ? [step('thread', await warmKey({ threadId }), 60_000, threadId === 'broken')] : []),
          ],
        }
      },
    })
    const call = async (body?: Record<string, unknown>) => {
      const response = await route()(post(body))
      const json = (await response.json()) as WorkspacePrewarmResponse
      return { json, timing: response.headers.get('server-timing') ?? '', outcomes: Object.fromEntries((json.steps ?? []).map(s => [s.name, s.outcome])) }
    }

    const first = await call()
    expect(first.json.outcome).toBe('warmed')
    expect(first.outcomes).toEqual({ session: 'miss', vault_heads: 'miss', tool_catalog: 'miss' })
    expect(runs.sort()).toEqual(['session', 'tool_catalog', 'vault_heads'])

    // A new route instance is another isolate: only the shared receipts can answer.
    runs.length = 0
    clock += 30_000
    const second = await call({ reason: 'heartbeat' })
    expect(second.json.outcome).toBe('recent')
    expect(second.outcomes).toEqual({ session: 'hit', vault_heads: 'hit', tool_catalog: 'hit' })
    expect(runs).toEqual([])
    expect(second.timing).toContain('warm.session;dur=0;desc="hit"')

    // A changed vault head re-warms that step only; the catalog's 60 s receipt has expired.
    vaultHead = 'head-2'
    clock += 31_000
    const third = await call()
    expect(third.outcomes).toEqual({ session: 'hit', vault_heads: 'miss', tool_catalog: 'miss' })
    expect(runs.sort()).toEqual(['tool_catalog', 'vault_heads'])

    // Composer focus names its thread; a failed step writes no receipt and is tried again next time.
    runs.length = 0
    const focus = await call({ reason: 'composer-focus', threadId: 'broken' })
    expect(focus.json.outcome).toBe('failed')
    expect(focus.outcomes).toMatchObject({ thread: 'failed', session: 'hit' })
    expect(seen.at(-1)).toEqual({ reason: 'composer-focus', threadId: 'broken' })
    expect(await receipts.get(warmReceiptId('thread', await warmKey({ threadId: 'broken' })))).toBeNull()
    runs.length = 0
    await call({ reason: 'composer-focus', threadId: 'broken' })
    expect(runs).toEqual(['thread'])

    // The receipt carries the step's report for the turn to read at send.
    expect(await receipts.get(warmReceiptId('vault_heads', await warmKey({ head: 'head-2', workspaceId: 'w1' }))))
      .toMatchObject({ report: { name: 'vault_heads' } })
  })
})
