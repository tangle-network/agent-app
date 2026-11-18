import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { createTestHarness } from 'wrangler'

interface ScenarioResult { acquired: boolean; ms?: number; error?: string; afterDrop?: string | null; afterStop?: string | null }

/**
 * Real local workerd and the shipped TurnStreamDO and durable turn lock (`workers/durable-stop-reconnect.worker.ts`).
 * A turn with durable Stop holds a control WebSocket to its lock's object. The object drops that socket while the lock is
 * still held, or leaves the socket's first sync unanswered. A held lock keeps its turn and its Stop: the owner reconnects
 * (up to three times), and a Stop sent while it was disconnected is replayed on the new socket. A lock released under the
 * owner still ends the turn: the object refuses the reconnect.
 */
it('reconnects a dropped durable Stop socket, replays Stop, retries an unsynced first connect, and fails closed on release', async () => {
  const worker = createTestHarness({ workers: [{
    configPath: fileURLToPath(new URL('./workers/durable-stop-reconnect.wrangler.toml', import.meta.url)),
  }] })
  try {
    const { url } = await worker.listen()
    const scenarios = ['drop', 'drop-then-stop', 'drop-then-release', 'unanswered-sync'] as const
    const results = Object.fromEntries(await Promise.all(scenarios.map(async (scenario) => {
      const response = await fetch(new URL(`/${scenario}`, url))
      const body = await response.text()
      assert.equal(response.status, 200, `${scenario}: ${body}`)
      return [scenario, JSON.parse(body) as ScenarioResult] as const
    }))) as Record<(typeof scenarios)[number], ScenarioResult>
    const report = JSON.stringify(results)

    assert.equal(results.drop.acquired, true, report)
    assert.equal(results.drop.afterDrop, null, `A dropped control socket must not end a turn whose lock is still held: ${report}`)
    assert.equal(results.drop.afterStop, 'turn_cancel_requested', `Stop reaches the turn on its reconnected socket: ${report}`)
    assert.equal(results['drop-then-stop'].afterDrop, 'turn_cancel_requested',
      `A Stop recorded while the owner was between sockets ends the turn as Stop: ${report}`)
    assert.equal(results['drop-then-release'].afterDrop, 'turn_control_unavailable',
      `A lock released under the owner still ends its turn: ${report}`)
    assert.equal(results['unanswered-sync'].acquired, true, `An unanswered first sync is retried once, not refused: ${report}`)
    assert.equal(results['unanswered-sync'].afterDrop, null, `The turn admitted on its second socket keeps running: ${report}`)
  } finally {
    await worker.close()
  }
}, 60_000)
