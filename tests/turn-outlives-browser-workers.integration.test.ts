import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { createTestHarness } from 'wrangler'

/**
 * Real local workerd, D1, the shared chat routes and an authenticated TurnStreamDO subclass
 * (`workers/turn-outlives-browser.worker.ts`). A member's turn answers over 40 s; the browser that sent it disconnects
 * at 2 s. The answer must still be stored, the lock released and the turn replayed in full, and the turn's work must
 * have run under a turn-stream object's `waitUntil`, never the browser request's: Cloudflare cancels a Worker request's
 * `waitUntil` work soon after its client leaves, which local workerd may not do (the probe below measures it).
 */
const configPath = fileURLToPath(new URL('./workers/turn-outlives-browser.wrangler.toml', import.meta.url))
const ANSWER = [...Array.from({ length: 9 }, (_, index) => `Part ${index + 1}. `), 'Final answer.'].join('')
const MEMBER = { cookie: 'session=member' }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface State { answer: string | null; status: string | null; lock: unknown; marks: string[] }

async function until<T>(read: () => Promise<T | null>, label: string, ms: number): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms: ${label}`)
    await sleep(500)
  }
}

/** The answer text a replay carries: every text event, in order. */
function replayedText(body: string): string {
  return body.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    .map(line => (line.kind === 'event' ? line.event : line) as Record<string, unknown>)
    .filter(event => event.type === 'text').map(event => String(event.text)).join('')
}

it('finishes, stores and replays a member’s turn after the browser that sent it disconnects', async () => {
  const worker = createTestHarness({ workers: [{ configPath }] })
  try {
    const { url } = await worker.listen()
    assert.equal((await fetch(new URL('/seed', url), { method: 'POST' })).status, 204)
    const send = (headers: Record<string, string>, signal?: AbortSignal) => fetch(new URL('/chat/proof-workspace', url), {
      method: 'POST', signal, headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ threadId: 'slow-thread', turnId: 'slow-turn', content: 'Answer slowly.' }),
    })
    const state = async (turnId: string) =>
      await (await fetch(new URL(`/state/proof-workspace/${turnId}`, url))).json() as State

    const refused = await send({ cookie: 'session=stranger' })
    assert.equal(refused.status, 401, 'A caller without the member cookie is refused before any turn starts')

    const browser = new AbortController()
    const sentAt = Date.now()
    const response = await send(MEMBER, browser.signal)
    assert.equal(response.status, 200)
    const turnId = response.headers.get('x-turn-id')
    assert(turnId, 'The turn names its replay handle')
    assert.equal((await response.body!.getReader().read()).done, false, 'The browser received the turn marker')
    await sleep(Math.max(0, 2_000 - (Date.now() - sentAt)))
    browser.abort()
    const disconnectedAt = Date.now()

    const settled = await until(async () => {
      const current = await state(turnId)
      return current.answer !== null && current.lock === null ? current : null
    }, 'the answer row is stored and the lock released after the browser disconnected', 100_000)
    const settledAfterMs = Date.now() - disconnectedAt
    console.info(JSON.stringify({ proof: 'turn-outlives-browser', disconnectedAfterMs: disconnectedAt - sentAt, settledAfterMs, marks: [...new Set(settled.marks)] }))
    assert.equal(settled.answer, ANSWER)
    assert.equal(settled.status, 'complete')
    assert(settledAfterMs > 30_000, `The turn kept answering for more than 30 s after the browser left: ${settledAfterMs} ms`)

    const replay = await fetch(new URL(`/replay/proof-workspace/${turnId}`, url), { headers: MEMBER })
    assert.equal(replay.status, 200)
    assert.equal(replayedText(await replay.text()), ANSWER, 'A reconnect replays the whole answer')

    assert.deepEqual([...new Set(settled.marks.filter(kind => kind.startsWith('wait-until:')))], ['wait-until:object'],
      'The turn-stream object’s waitUntil held the turn’s work; the browser request’s held none of it')
    assert.deepEqual(settled.marks.filter(kind => kind.startsWith('produce:')), ['produce:object'],
      'The producer ran once, in the turn-stream object')
  } finally {
    await worker.close()
  }
}, 180_000)

// The runtime check behind the proof, run on demand: does local workerd cancel a Worker request's own waitUntil work
// after its client disconnects, as Cloudflare does? A last mark near 45 s means it does not.
it.runIf(process.env.WORKERD_WAIT_UNTIL_PROBE === '1')('measures how long a Worker request’s waitUntil work runs after its client disconnects', async () => {
  const worker = createTestHarness({ workers: [{ configPath }] })
  try {
    const { url } = await worker.listen()
    assert.equal((await fetch(new URL('/seed', url), { method: 'POST' })).status, 204)
    const client = new AbortController()
    const response = await fetch(new URL('/probe/wait-until', url), { signal: client.signal })
    assert.equal((await response.body!.getReader().read()).done, false)
    await sleep(2_000)
    client.abort()
    await sleep(50_000)
    const { marks } = await (await fetch(new URL('/state/probe-workspace/none', url))).json() as State
    const lastMarkSecond = Math.max(0, ...marks.filter(kind => kind.startsWith('probe:')).map(kind => Number(kind.slice('probe:'.length))))
    console.info(JSON.stringify({ probe: 'workerd-wait-until-after-disconnect', disconnectedAfterMs: 2_000, plannedMarks: 45, lastMarkSecond,
      workerdCancelsWaitUntil: lastMarkSecond < 40 }))
    assert(lastMarkSecond > 0, 'The probe’s waitUntil work started')
  } finally {
    await worker.close()
  }
}, 120_000)
