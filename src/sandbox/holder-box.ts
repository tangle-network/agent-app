import type { SandboxInstance } from '@tangle-network/sandbox'
import type { HolderBoxReport } from '../turn-stream/adapters'

/** The cap on reading a held lock's box: the read runs inside a member's request. */
export const HOLDER_BOX_READ_TIMEOUT_MS = 5_000

/**
 * Read the box a held lock's turn ran work on, for `reconcileTurnLockFromStoreAndBox`. Only an active execution counts
 * as live work: the runtime can return a finished session with no status, which the SDK reads as running. `find` must
 * never provision or resume a box; a box that is absent or not running runs nothing. No answer within the cap is
 * `timeout`, a failed read is `unreachable`, and the policy then applies its own bound instead of the lock's TTL.
 */
export async function readHolderBoxSessions(
  find: () => Promise<Pick<SandboxInstance, 'status' | 'sessions'> | null | undefined>,
): Promise<HolderBoxReport> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = (async () => {
    const box = await find()
    if (!box || box.status !== 'running') return { live: 0, sessions: 0 }
    const sessions = await box.sessions()
    return { live: sessions.filter(({ info }) => !!info.activeExecutionId).length, sessions: sessions.length }
  })()
  try {
    return await Promise.race([read, new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), HOLDER_BOX_READ_TIMEOUT_MS) })])
  } catch {
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }
}
