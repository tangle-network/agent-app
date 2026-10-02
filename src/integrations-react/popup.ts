import type { HubConnection } from '@tangle-network/hub-sdk'
import type { HubIntegrationsClient, HubIntegrationsIdentity } from './client'

export const HUB_CONNECT_CHANNEL = 'tangle:hub-connect'
export const HUB_CONNECTED_MESSAGE_TYPE = 'tangle:hub-connected'
export const HUB_CONNECT_FAILED_MESSAGE_TYPE = 'tangle:hub-connect-failed'
export const POPUP_TIMEOUT_MS = 5 * 60 * 1000
const PRE_REDIRECT_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 2500
const POPUP_FEATURES = 'popup=yes,width=520,height=680'

export type PopupConnectResult = 'connected' | 'blocked' | 'cancelled' | 'unverified' | 'unavailable'

function updatedConnection(providerId: string, before: readonly HubConnection[], after: readonly HubConnection[]): boolean {
  const previous = new Map(before.filter(connection => connection.providerId === providerId).map(connection => [connection.id, connection]))
  return after.some(connection => {
    if (connection.providerId !== providerId || connection.status !== 'active' || connection.health === 'unhealthy') return false
    const old = previous.get(connection.id)
    return !old || old.updatedAt !== connection.updatedAt || old.status !== connection.status
  })
}

function closePopup(popup: Window): void {
  try { if (!popup.closed) popup.close() } catch { /* COOP may sever the handle. */ }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value) }, error => { signal.removeEventListener('abort', onAbort); reject(error) })
  })
}

function waitForConnection(input: {
  popup: Window
  client: HubIntegrationsClient
  identity: HubIntegrationsIdentity
  providerId: string
  before: readonly HubConnection[]
  nonce: string
  contextToken: string
  signal: AbortSignal
  isCurrent: () => boolean
}): Promise<PopupConnectResult> {
  return new Promise(resolve => {
    let settled = false
    let checking = false
    let pollId: number | undefined
    let timeoutId: number | undefined
    let channel: BroadcastChannel | undefined
    const finish = (result: PopupConnectResult) => {
      if (settled) return
      settled = true
      if (pollId !== undefined) window.clearTimeout(pollId)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      input.signal.removeEventListener('abort', onAbort)
      channel?.close()
      closePopup(input.popup)
      resolve(result)
    }
    const onAbort = () => finish('cancelled')
    const check = async () => {
      if (settled || checking) return
      checking = true
      if (!input.isCurrent() || input.signal.aborted) { finish('cancelled'); return }
      try {
        const after = await input.client.connections(input.identity, input.signal)
        if (input.isCurrent() && updatedConnection(input.providerId, input.before, after)) { finish('connected'); return }
      } catch { /* A lost read is never evidence of a connection. Keep polling. */ }
      checking = false
      if (!settled) pollId = window.setTimeout(check, POLL_INTERVAL_MS)
    }
    if (input.signal.aborted) { finish('cancelled'); return }
    input.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const candidate = new BroadcastChannel(HUB_CONNECT_CHANNEL)
      candidate.onmessage = event => {
        const message = event.data as Record<string, unknown> | null
        if (!message || message.provider !== input.providerId || message.nonce !== input.nonce || message.context !== input.contextToken) return
        if (message.type === HUB_CONNECT_FAILED_MESSAGE_TYPE) finish('cancelled')
        if (message.type === HUB_CONNECTED_MESSAGE_TYPE) {
          if (pollId !== undefined) window.clearTimeout(pollId)
          void check()
        }
      }
      channel = candidate
    } catch { /* Polling covers browsers without BroadcastChannel. */ }
    pollId = window.setTimeout(check, POLL_INTERVAL_MS)
    timeoutId = window.setTimeout(() => finish('unverified'), POPUP_TIMEOUT_MS)
  })
}

/** Opens before the first await, preserving the initiating user gesture. */
export async function connectWithPopup(input: {
  client: HubIntegrationsClient
  identity: HubIntegrationsIdentity
  providerId: string
  before: readonly HubConnection[]
  callbackPath: string
  connectionParameters?: Record<string, string>
  signal: AbortSignal
  isCurrent: () => boolean
}): Promise<PopupConnectResult> {
  if (!input.callbackPath.startsWith('/') || input.callbackPath.startsWith('//')) throw new TypeError('Callback path must be local.')
  const popup = window.open('', '_blank', POPUP_FEATURES)
  if (!popup) return 'blocked'
  // Keep the parent handle for navigation while removing the provider page's opener.
  try { popup.opener = null } catch { /* Some browsers make this read-only. */ }
  const nonce = crypto.randomUUID()
  const contextToken = crypto.randomUUID()
  const callback = new URL(input.callbackPath, window.location.origin)
  callback.searchParams.set('provider', input.providerId)
  callback.searchParams.set('nonce', nonce)
  callback.searchParams.set('context', contextToken)
  const timeout = new AbortController()
  const onAbort = () => timeout.abort()
  input.signal.addEventListener('abort', onAbort, { once: true })
  const preRedirectId = window.setTimeout(() => timeout.abort(), PRE_REDIRECT_TIMEOUT_MS)
  try {
    if (!input.isCurrent()) return 'cancelled'
    const start = await withAbort(input.client.startOAuth(input.identity, input.providerId, {
      returnUrl: callback.href,
      ...(input.connectionParameters === undefined ? {} : { connectionParameters: input.connectionParameters }),
    }, timeout.signal), timeout.signal)
    if (!input.isCurrent() || input.signal.aborted) return 'cancelled'
    let redirect: URL
    try { redirect = new URL(start.redirectUrl) } catch { return 'unavailable' }
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password) return 'unavailable'
    window.clearTimeout(preRedirectId)
    const waitController = new AbortController()
    const abortWait = () => waitController.abort()
    input.signal.addEventListener('abort', abortWait, { once: true })
    if (input.signal.aborted) abortWait()
    const waiting = waitForConnection({ ...input, popup, nonce, contextToken, signal: waitController.signal })
    try {
      popup.location.href = redirect.href
      return await waiting
    } catch {
      waitController.abort()
      await waiting
      return 'unavailable'
    } finally {
      input.signal.removeEventListener('abort', abortWait)
    }
  } catch {
    return input.signal.aborted || timeout.signal.aborted ? 'cancelled' : 'unavailable'
  } finally {
    window.clearTimeout(preRedirectId)
    input.signal.removeEventListener('abort', onAbort)
    closePopup(popup)
  }
}
