/**
 * The OAuth return contract shared by the browser popup and the settings
 * server. The popup appends exactly these parameters to the host's callback
 * path; the server accepts a return URL only in that shape.
 */
const HUB_CONNECT_CALLBACK_PARAMS = ['provider', 'nonce', 'context'] as const

/** True when `returnUrl` is the host's callback for `provider`, as the popup builds it. */
export function isHubConnectCallbackUrl(returnUrl: URL, callbackPath: string, provider: string): boolean {
  if (returnUrl.pathname !== callbackPath || returnUrl.hash) return false
  const keys = [...returnUrl.searchParams.keys()]
  if (keys.length !== HUB_CONNECT_CALLBACK_PARAMS.length) return false
  if (!HUB_CONNECT_CALLBACK_PARAMS.every((key) => returnUrl.searchParams.getAll(key).length === 1)) return false
  const opaque = (value: string | null) => !!value && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)
  return returnUrl.searchParams.get('provider') === provider
    && opaque(returnUrl.searchParams.get('nonce'))
    && opaque(returnUrl.searchParams.get('context'))
}
