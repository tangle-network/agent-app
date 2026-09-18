/** A credential-bearing client for one application origin, not a web fetch tool. */
export interface ApiKeyFetchOptions {
  origin: string
  /** Resolve from trusted client secret storage; never from an agent's arguments. */
  getApiKey(): string | Promise<string>
  fetchImpl?: typeof fetch
  /** Explicit local-development opt-in; never permits remote plaintext origins. */
  allowHttpLoopback?: boolean
}

export type ApiKeyFetch = (path: string, init?: RequestInit) => Promise<Response>

/** No redirects, cookie fallback, hidden retries, or model-selected credential destination. */
export function createApiKeyFetch(options: ApiKeyFetchOptions): ApiKeyFetch {
  const origin = new URL(options.origin)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback && options.allowHttpLoopback))) {
    throw new TypeError('API origin must be HTTPS without credentials, path, query, or fragment')
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required')
  const getApiKey = options.getApiKey

  return async (path, init = {}) => {
    // Reject URL-parser repairs and authority-relative references before resolving secrets.
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
      || /[\\\u0000-\u0020\u007f]/.test(path)) {
      throw new TypeError('API requests require a root-relative path without whitespace or backslashes')
    }
    const target = new URL(path, origin)
    if (target.origin !== origin.origin || target.username || target.password || target.hash) {
      throw new TypeError('API requests must stay on the configured origin without a fragment')
    }
    const headers = new Headers(init.headers)
    if (headers.has('authorization') || headers.has('cookie') || headers.has('proxy-authorization')) {
      throw new TypeError('Authentication headers must come from the configured secret resolver')
    }
    init.signal?.throwIfAborted()
    let apiKey: string
    try {
      apiKey = await getApiKey()
    } catch {
      throw new Error('API credential is unavailable')
    }
    if (typeof apiKey !== 'string' || !apiKey || /\s|[^\x21-\x7e]/.test(apiKey)) {
      throw new TypeError('API credential must be a nonempty printable token without whitespace')
    }
    init.signal?.throwIfAborted()
    headers.set('Authorization', `Bearer ${apiKey}`)
    let response: Response
    try {
      response = await fetchImpl(target.href, {
        ...init, headers, credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer',
      })
    } catch {
      // A failed transport does not establish that an external action did not run.
      // Do not forward an adapter's diagnostic, which could include the bearer.
      init.signal?.throwIfAborted()
      throw new Error('API transport failed; inspect retained state before retrying a write')
    }
    if (response.type === 'opaqueredirect' || response.redirected
      || (response.status >= 300 && response.status < 400 && response.status !== 304)) {
      try { await response.body?.cancel() } catch { /* Preserve the redirect refusal. */ }
      throw new Error('API redirects are not allowed')
    }
    return response
  }
}
