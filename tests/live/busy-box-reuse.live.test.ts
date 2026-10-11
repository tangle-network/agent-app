/**
 * LIVE: a reused box that is serving a running session is never restarted by
 * the reuse liveness gate (issue #934).
 *
 * The incident: the GTM operator box (2 cores, 4 GB) missed the `echo alive`
 * probe while it was busy, and reuse recovery stopped it. Every running turn on
 * it ended with "agent runtime restarted before the run produced a terminal
 * event".
 *
 * This test builds that state on a real box and asks the real reuse path what
 * it does:
 *
 *   1. Provision a box through `ensureWorkspaceSandbox` (default 2-core, 4 GB).
 *   2. Start a real agent session whose shell tool runs `sleep`, so the
 *      sidecar reports the session `running`.
 *   3. Make the probe miss deterministically: fill the sidecar's process table
 *      (its limit is 100) with long `sleep` processes. `echo alive` then fails
 *      with "Process limit reached", which the probe counts as a miss, the same
 *      as a timeout on a loaded box. The test asserts the miss before going on.
 *   4. Ask `ensureWorkspaceSandbox` for the box again, as a second turn would,
 *      with a 5 s probe.
 *   5. Free the process table and wait for the first session's terminal state.
 *
 * Pass: the second call does not stop and resume the box, and the first
 * session completes. Before the fix the box was stopped, resumed, and the
 * session never completed.
 *
 * Skipped unless `LIVE_SANDBOX=1` and `SANDBOX_API_KEY` are set. The session
 * runs on `LIVE_MODEL` (default `zai/glm-5.3`, a subscription model). Run:
 *
 *   LIVE_SANDBOX=1 SANDBOX_API_KEY=… pnpm vitest run tests/live/busy-box-reuse.live.test.ts
 */

import { describe, expect, it } from 'vitest'

import {
  ensureWorkspaceSandbox,
  type SandboxRuntimeConfig,
} from '../../src/sandbox/index'

const LIVE = process.env.LIVE_SANDBOX === '1' && Boolean(process.env.SANDBOX_API_KEY)
const BASE_URL = process.env.SANDBOX_API_URL ?? 'https://sandbox.tangle.tools'
const MODEL = process.env.LIVE_MODEL ?? 'zai/glm-5.3'
const HELD_SECONDS = 150
const PROCESS_TABLE_LIMIT = 100

type Box = Awaited<ReturnType<typeof ensureWorkspaceSandbox>>
type SpawnedProcess = Awaited<ReturnType<Box['process']['spawn']>>

const log = (message: string) => console.log(`[busy-box] ${new Date().toISOString()} ${message}`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function sessionStatus(box: Box, sessionId: string): Promise<string | undefined> {
  const sessions = await box.sessions()
  return sessions.find(({ info }) => info.id === sessionId)?.info.status
}

/** When the container's init process started; a stop and resume changes it,
 *  and a box left stopped reports why it cannot answer. */
async function containerBoot(box: Box): Promise<string> {
  return box.exec('ps -o lstart= -p 1', { timeoutMs: 10_000 }).then(
    (result) => result.stdout.trim(),
    (cause: Error) => `unavailable: ${cause.message}`,
  )
}

/** A box mid-stop refuses deletion for a while; retry, and say so if it stays. */
async function deleteBox(box: Box): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await box.delete()
      return
    } catch (cause) {
      if (attempt === 6) {
        log(`could not delete ${box.id}; delete it by hand: ${(cause as Error).message}`)
        return
      }
      await sleep(10_000)
    }
  }
}

describe.skipIf(!LIVE)('LIVE: busy reused box', () => {
  it(
    'a box serving a running session is not restarted when the reuse probe misses',
    async () => {
      const workspaceId = `busy-${Date.now().toString(36)}`
      const shell: SandboxRuntimeConfig = {
        credentials: () => ({ apiKey: process.env.SANDBOX_API_KEY!, baseUrl: BASE_URL }),
        name: (id) => `agent-app-live-${id}`.slice(0, 63),
        metadata: (harness) => ({ harness }),
        connectedIntegrationIds: async () => [],
        env: async () => ({}),
        files: async () => [],
        secrets: async () => [],
        profile: () => ({ name: 'busy-box-reuse' }) as ReturnType<SandboxRuntimeConfig['profile']>,
        livenessProbe: { execTimeoutMs: 5_000, cacheTtlMs: 0 },
      }

      let box: Box | undefined
      const spawned: SpawnedProcess[] = []
      try {
        box = await ensureWorkspaceSandbox(shell, { workspaceId, harness: 'opencode' })
        log(`provisioned ${box.id}`)

        const sessionId = `held-${workspaceId}`
        await box.dispatchPrompt(
          `Use your bash tool to run exactly this command and wait for it to finish: ` +
            `sleep ${HELD_SECONDS} && echo held-turn-done . ` +
            `After it finishes, reply with the single word: finished`,
          { sessionId, model: MODEL },
        )
        let toolRunning = false
        for (let i = 0; i < 40 && !toolRunning; i++) {
          await sleep(3_000)
          const status = await sessionStatus(box, sessionId)
          if (status !== 'running') throw new Error(`held session is ${status ?? 'missing'} before the probe`)
          const ps = await box.exec(`pgrep -f "sleep ${HELD_SECONDS}" || true`, { timeoutMs: 10_000 })
          toolRunning = ps.stdout.trim().length > 0
        }
        expect(toolRunning, 'the held session started its shell tool').toBe(true)
        log(`session ${sessionId} is running its shell tool`)

        const bootBefore = await containerBoot(box)
        for (let i = 0; i < PROCESS_TABLE_LIMIT + 5; i++) {
          try {
            spawned.push(await box.process.spawn('sleep 900'))
          } catch (cause) {
            log(`process table full after ${spawned.length} spawns: ${(cause as Error).message}`)
            break
          }
        }
        const probe = await box.exec('echo alive', { timeoutMs: 5_000 }).then(
          () => 'answered',
          (cause: Error) => cause.message,
        )
        log(`echo alive on the busy box: ${probe}`)
        expect(probe, 'the busy box misses the liveness probe').not.toBe('answered')
        expect(await sessionStatus(box, sessionId)).toBe('running')

        const progress: string[] = []
        const second = await ensureWorkspaceSandbox(shell, {
          workspaceId,
          harness: 'opencode',
          onProgress: (event) => progress.push(`${event.step}:${event.status}:${event.message ?? ''}`),
        }).then(
          (reused) => ({ reusedId: reused.id }),
          (cause: Error) => ({ error: `${cause.name}: ${cause.message}` }),
        )
        log(`second ensure: ${JSON.stringify(second)}; progress: ${JSON.stringify(progress)}`)

        await Promise.allSettled(spawned.map((process) => process.kill()))
        spawned.length = 0

        let finalStatus: string | undefined
        for (let i = 0; i < 80; i++) {
          const read = await box.sessions().then(
            (sessions) => ({ status: sessions.find(({ info }) => info.id === sessionId)?.info.status ?? 'missing', count: sessions.length }),
            (cause: Error) => ({ error: cause.message }),
          )
          if ('error' in read) {
            log(`session list unavailable: ${read.error}`)
          } else {
            if (read.status !== finalStatus) log(`held session is ${read.status} (${read.count} sessions on the box)`)
            finalStatus = read.status
            if (finalStatus !== 'running' && finalStatus !== 'queued') break
          }
          await sleep(3_000)
        }
        const bootAfter = await containerBoot(box)
        log(`held session final status: ${finalStatus}; container boot ${bootBefore} -> ${bootAfter}`)

        expect(progress.filter((event) => event.startsWith('container-start')), 'no stop and resume').toEqual([])
        if ('reusedId' in second) expect(second.reusedId).toBe(box.id)
        else expect(second.error).toMatch(/^SandboxBoxBusyError/)
        expect(bootAfter, 'the container was not restarted').toBe(bootBefore)
        expect(finalStatus, 'the running session reached its own terminal state').toBe('completed')
      } finally {
        await Promise.allSettled(spawned.map((process) => process.kill()))
        if (box) await deleteBox(box)
      }
    },
    900_000,
  )
})
