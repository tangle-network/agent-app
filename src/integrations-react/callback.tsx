import { useEffect, useState } from 'react'
import { HUB_CONNECTED_MESSAGE_TYPE, HUB_CONNECT_CHANNEL, HUB_CONNECT_FAILED_MESSAGE_TYPE, localAppUrl } from './popup'

export interface HubConnectCallbackPageProps {
  /** Local settings destination owned by the consuming app. */
  returnHref: string
}

/** The callback only signals completion; the opener verifies fresh Hub state. */
export function HubConnectCallbackPage({ returnHref }: HubConnectCallbackPageProps) {
  const [phase, setPhase] = useState<'checking' | 'returned' | 'failed'>('checking')
  const [reason, setReason] = useState('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const provider = params.get('provider')
    const nonce = params.get('nonce')
    const context = params.get('context')
    if (!provider || !nonce || !context) { setReason('This connection callback is incomplete.'); setPhase('failed'); return }
    const failure = params.get('error_description') || params.get('error')
    try {
      const channel = new BroadcastChannel(HUB_CONNECT_CHANNEL)
      channel.postMessage({ type: failure ? HUB_CONNECT_FAILED_MESSAGE_TYPE : HUB_CONNECTED_MESSAGE_TYPE, provider, nonce, context })
      channel.close()
    } catch { /* The opener also polls the authoritative connection list. */ }
    if (failure) { setReason(failure.slice(0, 200)); setPhase('failed'); return }
    window.close()
    const timer = window.setTimeout(() => setPhase('returned'), 150)
    return () => window.clearTimeout(timer)
  }, [])

  const destination = localAppUrl(returnHref)
  const localReturn = destination ? `${destination.pathname}${destination.search}${destination.hash}` : '/'
  return <main aria-live="polite" style={{ maxWidth: 560, margin: '20vh auto', padding: 24, textAlign: 'center' }}>
    {phase === 'checking' ? <p>Checking your connection…</p> : phase === 'returned'
      ? <p>Return to the app to check your connection. You can close this window.</p>
      : <p>Could not complete the connection. {reason}</p>}
    <a href={localReturn}>Return to integrations</a>
  </main>
}
