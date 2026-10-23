import type { DurableWorkspaceKeyManagerOptions } from './identity-bound'

export function createWorkspaceKeyLocks(
  leaseWaitMs: number,
  options: DurableWorkspaceKeyManagerOptions,
  now: () => Date,
  leaseMs: number,
  leasePollMs: number,
  leaseRenewIntervalMs: number,
  operationId: () => string,
  sleep: (ms: number) => Promise<void>,
) {
  const localLocks = new Map<string, Promise<void>>()

  async function withLocalLock<T>(scope: string, work: () => Promise<T>): Promise<T> {
    const previous = localLocks.get(scope) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    localLocks.set(scope, current)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (localLocks.get(scope) === current) localLocks.delete(scope)
    }
  }

  async function withDurableLease<T>(
    scope: string,
    work: () => Promise<T>,
    onLeaseLost?: () => Promise<void>,
  ): Promise<T> {
    const leaseOperationId = operationId()
    const startedAt = Date.now()
    let acquired = false
    while (!acquired && Date.now() - startedAt <= leaseWaitMs) {
      acquired = await options.store.acquireLease(scope, leaseOperationId, now(), leaseMs)
      if (!acquired) await sleep(leasePollMs)
    }
    if (!acquired) throw new Error('workspace child-key issuance is busy; retry the request')

    let stopped = false
    let leaseLost: Error | null = null
    let leaseTimer: ReturnType<typeof setTimeout> | undefined
    let renewalPromise: Promise<void> | undefined
    const scheduleRenewal = () => {
      if (stopped || leaseLost) return
      leaseTimer = setTimeout(() => {
        leaseTimer = undefined
        const renewal = (async () => {
          try {
            if (!await options.store.renewLease(scope, leaseOperationId, now(), leaseMs)) {
              leaseLost = new Error('workspace child-key lease was lost during reconciliation')
              return
            }
            scheduleRenewal()
          } catch (error) {
            leaseLost = error instanceof Error ? error : new Error('workspace child-key lease renewal failed')
          }
        })()
        renewalPromise = renewal
        void renewal.finally(() => {
          if (renewalPromise === renewal) renewalPromise = undefined
        }).catch(() => undefined)
      }, leaseRenewIntervalMs)
    }
    scheduleRenewal()

    let workError: unknown
    let leaseLossCleanupError: unknown
    try {
      const result = await work()
      if (leaseLost) throw leaseLost
      return result
    } catch (error) {
      workError = error
      throw error
    } finally {
      stopped = true
      if (leaseTimer) clearTimeout(leaseTimer)
      if (renewalPromise) await renewalPromise
      if (leaseLost && onLeaseLost) {
        try {
          await onLeaseLost()
        } catch (error) {
          leaseLossCleanupError = error
        }
      }
      try {
        await options.store.releaseLease(scope, leaseOperationId)
      } catch (error) {
        if (workError === undefined) throw error
      }
      if (workError === undefined && leaseLossCleanupError) {
        throw new Error('workspace child-key lease was lost and cleanup failed', { cause: leaseLossCleanupError })
      }
      if (workError === undefined && leaseLost) throw leaseLost
    }
  }
  return { withLocalLock, withDurableLease }
}
