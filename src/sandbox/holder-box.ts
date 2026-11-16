import type { SandboxInstance } from '@tangle-network/sandbox'
import type { HolderBoxReport } from '../turn-stream/adapters'

/** The cap on reading a held lock's box: the read runs inside a member's request. */
export const HOLDER_BOX_READ_TIMEOUT_MS = 5_000

/**
 * Read the box a held lock's turn ran work on, for `reconcileTurnLockFromStoreAndBox`. Live work is the sidecar's own
 * verdict (`hasActiveExecution`, computed against its execution tracker, kept by the SDK in `info.raw`): a finished
 * session can keep a stale `activeExecutionId`, and the SDK reads a session without a status as running. The id counts
 * only when an older sidecar sends no verdict. `find` must never provision or resume a box; a box that is absent or not
 * running runs nothing. No answer within the cap is `timeout`, a failed read is `unreachable` (logged with its class),
 * and the policy then applies its own bound instead of the lock's TTL.
 */
export async function readHolderBoxSessions(
  find: () => Promise<Pick<SandboxInstance, 'status' | 'sessions'> | null | undefined>,
): Promise<HolderBoxReport> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = (async () => {
    const box = await find()
    if (!box || box.status !== 'running') return { live: 0, sessions: 0 }
    const sessions = await box.sessions()
    const live = sessions.filter(({ info }) => {
      const verdict = (info as { raw?: { hasActiveExecution?: unknown } }).raw?.hasActiveExecution
      return typeof verdict === 'boolean' ? verdict : !!info.activeExecutionId
    })
    return { live: live.length, sessions: sessions.length }
  })()
  try {
    return await Promise.race([read, new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), HOLDER_BOX_READ_TIMEOUT_MS) })])
  } catch (error) {
    console.warn('[turn-lock] holder box read failed', { class: 'box_unreachable', error: error instanceof Error ? error.name : 'unknown' })
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }
}
