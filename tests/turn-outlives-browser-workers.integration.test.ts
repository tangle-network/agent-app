import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { createTestHarness } from 'wrangler'

/**
 * Real local workerd, D1, the shared chat routes and an authenticated TurnStreamDO subclass
 * (`workers/turn-outlives-browser.worker.ts`). A member's turn answers over 40 s; the browser that sent it disconnects
 * at 2 s. The answer must still be stored, the lock released and the turn replayed in full, and the turn's work must
 * have run under a turn-stream object's `waitUntil`, never the browser request's: Cloudflare cancels a Worker request's
 * `waitUntil` work soon after its client leaves, which local workerd may not do (the probe below measures it). A second
 * turn's host then loses its object after the turn started there: the request's own run is refused by the turn lock.
 */
const configPath = fileURLToPath(new URL('./workers/turn-outlives-browser.wrangler.toml', import.meta.url))
const ANSWER = [...Array.from({ length: 9 }, (_, index) => `Part ${index + 1}. `), 'Final answer.'].join('')
const MEMBER = { cookie: 'session=member' }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface State { answers: string[]; status: string | null; lock: unknown; marks: string[] }

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
    const send = (headers: Record<string, string>, signal?: AbortSignal,
      body = { threadId: 'slow-thread', turnId: 'slow-turn', content: 'Answer slowly.' }) => fetch(new URL('/chat/proof-workspace', url), {
      method: 'POST', signal, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
    const state = async (turnId: string, thread = 'slow-thread') =>
      await (await fetch(new URL(`/state/proof-workspace/${turnId}?thread=${thread}`, url))).json() as State

    const objectRequests = (marks: string[]) => marks.filter(kind => kind === 'host:object-request').length
    const anonymous = await send({})
    assert.equal(anonymous.status, 401, 'A caller with no credential is refused')
    assert.equal(objectRequests((await state('none')).marks), 0, 'A request with no credential is refused without creating a turn-stream object')
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
      return current.answers.length > 0 && current.lock === null ? current : null
    }, 'the answer row is stored and the lock released after the browser disconnected', 100_000)
    const settledAfterMs = Date.now() - disconnectedAt
    console.info(JSON.stringify({ proof: 'turn-outlives-browser', disconnectedAfterMs: disconnectedAt - sentAt, settledAfterMs, marks: [...new Set(settled.marks)] }))
    assert.deepEqual(settled.answers, [ANSWER])
    assert.equal(settled.status, 'complete')
    assert(settledAfterMs > 30_000, `The turn kept answering for more than 30 s after the browser left: ${settledAfterMs} ms`)

    const replay = await fetch(new URL(`/replay/proof-workspace/${turnId}`, url), { headers: MEMBER })
    assert.equal(replay.status, 200)
    assert.equal(replayedText(await replay.text()), ANSWER, 'A reconnect replays the whole answer')

    assert.deepEqual([...new Set(settled.marks.filter(kind => kind.startsWith('wait-until:')))], ['wait-until:object'],
      'The turn-stream object’s waitUntil held the turn’s work; the browser request’s held none of it')
    assert.deepEqual(settled.marks.filter(kind => kind.startsWith('produce:')), ['produce:object'],
      'The producer ran once, in the turn-stream object')
    assert.equal(objectRequests(settled.marks), 2,
      'Each request with a credential, the refused stranger’s and the member’s, went to its own turn-stream object')

    // The host loses its object after the turn started there, with a plain error, so the request runs the turn itself.
    // The turn lock the object holds refuses that second run: the turn runs once.
    const producedBefore = settled.marks.filter(kind => kind.startsWith('produce:')).length
    const broken = await send({ ...MEMBER, 'x-proof-host-breaks': '1' }, undefined,
      { threadId: 'break-thread', turnId: 'break-turn', content: 'Answer soon.' })
    const refusal = await broken.text()
    assert.equal(broken.status, 409, `The lock refuses the request's second run instead of streaming it: ${refusal}`)
    assert.equal((JSON.parse(refusal) as { error?: { code?: string } }).error?.code, 'workspace_turn_in_flight')
    const afterBreak = await until(async () => {
      const current = await state('none', 'break-thread')
      return current.answers.length > 0 && current.lock === null ? current : null
    }, 'the object’s turn stores its answer after its host lost it', 60_000)
    assert.deepEqual(afterBreak.answers, [ANSWER], 'The object’s turn completed and stored exactly one answer row')
    assert.deepEqual(afterBreak.marks.filter(kind => kind.startsWith('produce:')).slice(producedBefore), ['produce:object'],
      'Only the object produced the turn; the request never ran a producer')
  } finally {
    await worker.close()
  }
}, 240_000)

// The runtime check behind the proof, run on demand: does local workerd cancel a Worker request's own waitUntil work
// after its client disconnects, as Cloudflare does? It reports the last mark and never fails on it: a last mark near
// 45 s means workerd does not cancel the work, one near 32 s means it does, and 0 means the work never ran.
it.runIf(process.env.WORKERD_WAIT_UNTIL_PROBE === '1')('measures how long a Worker request’s waitUntil work runs after its client disconnects', async () => {
  // test-quality:probe-only — a measurement printed for the reader, not an assertion.
  const worker = createTestHarness({ workers: [{ configPath }] })
  try {
    const { url } = await worker.listen()
    await fetch(new URL('/seed', url), { method: 'POST' })
    const client = new AbortController()
    const sent = fetch(new URL('/probe/wait-until', url), { signal: client.signal }).catch(() => null)
    await sleep(2_000)
    client.abort()
    await sent
    await sleep(50_000)
    const { marks } = await (await fetch(new URL('/state/probe-workspace/none', url))).json() as State
    const lastMarkSecond = Math.max(0, ...marks.filter(kind => kind.startsWith('probe:')).map(kind => Number(kind.slice('probe:'.length))))
    console.info(JSON.stringify({ probe: 'workerd-wait-until-after-disconnect', disconnectedAfterMs: 2_000, plannedMarks: 45, lastMarkSecond }))
  } finally {
    await worker.close()
  }
}, 300_000)
