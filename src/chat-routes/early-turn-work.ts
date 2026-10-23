/** Request-owned speculative work: legacy release callbacks and opaque resource lifetimes. */
import type { ChatTurnAfterAuthorizeRelease } from './turn-route-contracts'
import { redactErrorMessage } from '../redact/index'

export interface AfterAuthorizeWork<TResource = unknown> {
  resource?: Promise<TResource>
  handOff(): void
  release(): Promise<void>
  settle(): Promise<void>
  add(release: () => void): void
}

export function earlyTurnWork<TResource>(
  started: ChatTurnAfterAuthorizeRelease<TResource> | undefined,
  log: (message: string, meta?: Record<string, unknown>) => void,
): AfterAuthorizeWork<TResource> {
  let free = typeof started === 'function' ? started : undefined
  const owned = typeof started === 'object' ? started : undefined
  void owned?.resource.catch(() => {})
  let handedOff = false
  let stopped: Promise<void> | undefined
  let also: Array<() => void> = []
  const report = (error: unknown) => log('[chat-routes] afterAuthorize release failed', { error: redactErrorMessage(error) })
  const settle = (): Promise<void> => stopped ??= (async () => {
    if (owned) await owned.dispose(await owned.resource)
  })().catch(report)
  return {
    resource: owned?.resource,
    handOff: () => { handedOff = true; free = undefined; also = [] },
    add: release => { also.push(release) },
    settle,
    release: async () => {
      const product = free
      const route = also
      free = undefined
      also = []
      for (const stop of route) stop()
      if (product) await Promise.resolve().then(product).catch(report)
      if (!handedOff) await settle()
    },
  }
}
