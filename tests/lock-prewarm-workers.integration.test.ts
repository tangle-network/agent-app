import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { createTestHarness } from 'wrangler'

interface BindingCall {
  channel: string
  id: string
  locationHint?: string
  path?: string
  fetchMs?: number
  handlerMs?: number
}
interface Receipt {
  outcome?: string
  report?: { legacyReady?: boolean }
  steps?: Array<{ name: string; outcome: string; ms: number }>
  bindingCalls: BindingCall[]
  acquired?: boolean
  handle?: { workspaceId: string; threadId: string; executionId: string; lockId: string }
  text?: string
}

/**
 * Real local workerd, D1, shared authorization/prewarm/chat routes, signed
 * capability protocol, and real TurnStreamDO storage. 240ms injected fixture
 * initialization is deterministic; these numbers are not Cloudflare latency.
 */
it('prewarms the default turn lock before send, reuses receipts, and preserves authorization and fencing in workerd', async () => {
  const worker = createTestHarness({ workers: [{
    configPath: fileURLToPath(new URL('./workers/lock-prewarm.wrangler.toml', import.meta.url)),
  }] })
  try {
    const { url } = await worker.listen()
    assert.equal((await fetch(new URL('/proof/seed', url), { method: 'POST' })).status, 204)
    async function invoke(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
      const response = await fetch(new URL(path, url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer editor', ...headers },
        body: JSON.stringify(body),
      })
      return { status: response.status, timing: response.headers.get('server-timing'), body: await response.json() as Receipt }
    }
    const step = (receipt: Receipt) => receipt.steps?.find(value => value.name === 'turn_lock')
    function lockMs(header: string | null) {
      const match = /(?:^|,)\s*admission\.lock;dur=([0-9.]+)/.exec(header ?? '')
      assert(match, `Missing admission.lock Server-Timing: ${header}`)
      return Number(match[1])
    }
    function assertChannel(receipt: Receipt, channel: string, region = 'enam') {
      assert(receipt.bindingCalls.length > 0)
      assert(receipt.bindingCalls.every(call => call.channel === channel && call.locationHint === region), JSON.stringify(receipt))
      assert.equal(new Set(receipt.bindingCalls.map(call => call.id)).size, 1)
    }

    const denied = await invoke('/prewarm/proof-denied', {}, { authorization: 'Bearer viewer' })
    assert.equal(denied.status, 403)
    assert.deepEqual(denied.body.bindingCalls, [], 'Denied authorization must not resolve or wake a DO')

    const cold = await invoke('/chat/proof-cold', { threadId: 'cold-thread', turnId: 'cold-turn', content: 'Cold baseline' })
    assert.equal(cold.status, 200, JSON.stringify(cold))
    assert.match(cold.body.text ?? '', /Local integration answer/)
    const coldLockMs = lockMs(cold.timing)
    assert(coldLockMs > 100, `Injected240ms initialization must be visible in cold admission.lock: ${coldLockMs}`)
    assertChannel(cold.body, 'proof-cold')

    // Browser body carries an attacker-selected workspace; the authorization
    // callback supplies the verified route workspace and shared warm must use it.
    const warm = await invoke('/prewarm/proof-warmed', { workspaceId: 'proof-forged', threadId: 'warm-thread', reason: 'composer-focus' })
    assert.equal(warm.status, 200)
    assert.equal(warm.body.outcome, 'warmed', JSON.stringify(warm))
    assert.equal(step(warm.body)?.outcome, 'miss')
    const id = warm.body.bindingCalls[0]?.id

    // New handler has no isolate success map: the real shared D1 receipt must
    // suppress another namespace.get, not merely another lock acquisition.
    const hit = await invoke('/prewarm/proof-warmed?fresh=1', { threadId: 'warm-thread' })
    assert.equal(step(hit.body)?.outcome, 'hit', JSON.stringify(hit))
    assert.deepEqual(hit.body.bindingCalls, [], 'A valid stored receipt must not re-wake the object')

    const chat = await invoke('/chat/proof-warmed', { threadId: 'warm-thread', turnId: 'warm-turn', content: 'After prewarm' })
    assert.equal(chat.status, 200, JSON.stringify(chat))
    assert.match(chat.body.text ?? '', /Local integration answer/)
    const warmLockMs = lockMs(chat.timing)
    console.info(JSON.stringify({
      proof: 'local-workerd-lock-prewarm', initialization: 'injected240ms DO constructor barrier; not measured Cloudflare cold start',
      coldAdmissionLockMs: coldLockMs, warmedAdmissionLockMs: warmLockMs, targetMs: 100,
      coldServerTiming: cold.timing, prewarmServerTiming: warm.timing, warmedServerTiming: chat.timing,
      coldBindingCalls: cold.body.bindingCalls, prewarmBindingCalls: warm.body.bindingCalls, warmedBindingCalls: chat.body.bindingCalls,
    }))
    assert(warmLockMs < 100, `Prewarmed actual route admission.lock must be <100ms: ${warmLockMs}`)
    assertChannel(warm.body, 'proof-warmed')
    assertChannel(chat.body, 'proof-warmed')
    assert(chat.body.bindingCalls.every(call => call.id === id), 'Warm and send must reach the same named object')

    const failed = await invoke('/prewarm/proof-retry?wrongSecret=1')
    assert.equal(step(failed.body)?.outcome, 'failed', JSON.stringify(failed))
    const retried = await invoke('/prewarm/proof-retry?fresh=1')
    assert.equal(step(retried.body)?.outcome, 'miss', 'Failed capability authentication must not create a success receipt')
    const retryHit = await invoke('/prewarm/proof-retry?fresh=1')
    assert.equal(step(retryHit.body)?.outcome, 'hit')
    assert.deepEqual(retryHit.body.bindingCalls, [])

    const failedLegacy = await invoke('/prewarm/proof-legacy-fails', {}, { 'x-fail-legacy': '1' })
    assert.equal(failedLegacy.body.outcome, 'failed')
    assert.equal(step(failedLegacy.body)?.outcome, 'miss', 'Independent legacy failure must not suppress the shared lock warm')
    const legacyRetry = await invoke('/prewarm/proof-legacy-fails?fresh=1')
    assert.equal(step(legacyRetry.body)?.outcome, 'hit')
    assert.deepEqual(legacyRetry.body.bindingCalls, [])

    // This is a new named object: placement hints cannot relocate an object
    // already created. Workerd observes binding options, not physical geography.
    const alternate = await invoke('/prewarm/proof-alternate?region=weur')
    assertChannel(alternate.body, 'proof-alternate', 'weur')
    const alternateChat = await invoke('/chat/proof-alternate?region=weur', {
      threadId: 'alternate-thread', turnId: 'alternate-turn', content: 'Alternate region' })
    assert.equal(alternateChat.status, 200)
    assertChannel(alternateChat.body, 'proof-alternate', 'weur')
    assert.equal(alternateChat.body.bindingCalls[0]!.id, alternate.body.bindingCalls[0]!.id)

    // Use the same default adapter as shared prewarm+chat. A warm is a peek:
    // the first acquire must succeed, contention and release fences must hold.
    const fencingWarm = await invoke('/prewarm/proof-fencing')
    const held = await invoke('/acquire/proof-fencing')
    assert.equal(held.body.acquired, true, 'Prewarm must not acquire a lock')
    assert(held.body.handle)
    const heldId = fencingWarm.body.bindingCalls[0]!.id
    assert.equal(held.body.bindingCalls[0]!.id, heldId)
    assert.equal((await invoke('/acquire/proof-fencing')).body.acquired, false, 'Same execution still conflicts')
    assert.equal((await invoke('/acquire/proof-fencing?execution=competitor')).body.acquired, false)
    const sibling = await invoke('/acquire/proof-fencing?thread=sibling&execution=sibling')
    assert.equal(sibling.body.acquired, true, 'Thread lock must not become a workspace lock')
    await invoke('/release/proof-fencing', sibling.body.handle)
    await invoke('/release/proof-fencing', { ...held.body.handle, lockId: 'wrong-lock' })
    assert.equal((await invoke('/acquire/proof-fencing?execution=competitor')).body.acquired, false,
      'Wrong lock id must not release a held lock')
    await invoke('/release/proof-fencing', held.body.handle)
    const successor = await invoke('/acquire/proof-fencing?execution=successor')
    assert.equal(successor.body.acquired, true)
    await invoke('/release/proof-fencing', held.body.handle)
    assert.equal((await invoke('/acquire/proof-fencing?execution=competitor')).body.acquired, false,
      'A stale release must not release the successor')
    const released = await invoke('/release/proof-fencing', successor.body.handle)
    assertChannel(released.body, 'proof-fencing')
    assert.equal(released.body.bindingCalls[0]!.id, heldId)
    const final = await invoke('/acquire/proof-fencing?execution=final')
    assert.equal(final.body.acquired, true)
    await invoke('/release/proof-fencing', final.body.handle)
  } finally {
    await worker.close()
  }
}, 60_000)
