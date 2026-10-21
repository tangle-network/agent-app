/**
 * The Tangle Router's media surface (`/v1/videos`, `/v1/audio/*`, chat) over
 * one configured base URL: authenticated JSON posts, job polling, and the
 * resolution of the router-relative result paths it returns for provider
 * output. A product binds it once with its router base URL, its default key,
 * and any first-party headers its calls must carry.
 */

/** A failed Router response: its HTTP status and the machine-readable `error.code` its body names, when it names one. */
export class RouterHttpError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'RouterHttpError'
    this.status = status
    this.code = code
  }
}

/** A provider result URL, with the Bearer header a fetch must send when the Router proxies it. */
export interface RouterMediaSource {
  url: string
  /** Set for router-proxied URLs; fetches must send it. Absent for public provider URLs. */
  authorization?: string
}

export interface RouterMediaClientConfig {
  /** The operator-configured router base URL, with or without a trailing `/v1`. */
  baseUrl: () => string
  /** The key used when a call passes none (a deployment-level service key). */
  defaultApiKey?: () => unknown
  /** Wraps every outgoing request's headers, for first-party identification. */
  headers?: (headers: Record<string, string>) => HeadersInit
}

export type RouterMediaClient = ReturnType<typeof createRouterMediaClient>

const NOT_CONFIGURED = 'Media generation is not configured for this deployment.'

/** The Router's `/v1` URL for a base URL given with or without it. */
export function routerV1Url(value: string): string {
  return `${routerRootUrl(value)}/v1`
}

/** A failed Router response's message, and the `error.code` its body names, when it names one. */
export async function routerResponseError(response: Response): Promise<{ message: string; code?: string }> {
  const text = await response.text()
  if (!text) return { message: response.statusText }
  try {
    const json = JSON.parse(text) as {
      error?: { message?: string; code?: unknown } | string
      message?: string
    }
    if (typeof json.error === 'string') return { message: json.error }
    const code = typeof json.error?.code === 'string' ? json.error.code : undefined
    if (typeof json.error?.message === 'string') return { message: json.error.message, code }
    if (typeof json.message === 'string') return { message: json.message, code }
  } catch {
    return { message: text.slice(0, 500) }
  }
  return { message: text.slice(0, 500) }
}

export async function routerResponseErrorMessage(response: Response): Promise<string> {
  return (await routerResponseError(response)).message
}

export function createRouterMediaClient(config: RouterMediaClientConfig) {
  const wrap = (headers: Record<string, string>): HeadersInit => config.headers?.(headers) ?? headers

  function requiredRouterApiKey(value?: unknown): string {
    const apiKey = text(value ?? config.defaultApiKey?.())
    if (!apiKey) throw new Error(NOT_CONFIGURED)
    return apiKey
  }

  function routerMediaUrl(path: string): string {
    return `${routerV1Url(config.baseUrl())}${path}`
  }

  /** The request headers for an authenticated Router call. */
  function routerHeaders(apiKey?: string, extra: Record<string, string> = {}): HeadersInit {
    return wrap({ Authorization: `Bearer ${requiredRouterApiKey(apiKey)}`, ...extra })
  }

  async function routerJson(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    apiKey?: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(routerMediaUrl(path), {
      method: 'POST',
      headers: routerHeaders(apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(pruneUndefined(body)),
      signal,
    })
    if (!response.ok) {
      const { message, code } = await routerResponseError(response)
      throw new RouterHttpError(response.status, `Router media request failed: ${response.status} ${message}`, code)
    }
    return (await response.json()) as Record<string, unknown>
  }

  async function routerMediaStatus(id: string, signal?: AbortSignal, apiKey?: string): Promise<Record<string, unknown>> {
    const response = await fetch(routerMediaUrl(`/videos/${encodeURIComponent(id)}`), {
      headers: routerHeaders(apiKey),
      signal,
    })
    if (!response.ok) {
      throw new Error(`Router media poll failed: ${response.status} ${await routerResponseErrorMessage(response)}`)
    }
    return (await response.json()) as Record<string, unknown>
  }

  /**
   * The router masks provider result URLs behind its own authenticated proxy and
   * returns them as router-relative paths (e.g. "/v1/videos/<id>/content").
   * Resolve those against the configured router base and carry the Bearer key
   * the fetch needs; absolute provider URLs (public signed CDN links) pass
   * through untouched. Protocol-relative URLs ("//host/…") are not router
   * paths — they pass through as public and fail the public-URL guard loudly.
   */
  function resolveRouterMediaSource(value: string, apiKey?: string): RouterMediaSource {
    if (!value.startsWith('/') || value.startsWith('//')) return { url: value }
    return {
      url: `${routerRootUrl(config.baseUrl())}${value}`,
      authorization: `Bearer ${requiredRouterApiKey(apiKey)}`,
    }
  }

  /** Authorized media fetches must stay on the operator-configured router origin: the Bearer key must never reach a provider-controlled host. */
  function validateRouterMediaSourceUrl(value: string): string {
    const expected = new URL(routerRootUrl(config.baseUrl())).origin
    const url = new URL(value)
    if (url.origin !== expected) {
      throw new Error(`Authorized media fetch must target the router origin ${expected}`)
    }
    return url.toString()
  }

  return {
    requiredRouterApiKey,
    routerMediaUrl,
    routerHeaders,
    routerJson,
    routerMediaStatus,
    resolveRouterMediaSource,
    validateRouterMediaSourceUrl,
  }
}

function routerRootUrl(value: string): string {
  return value.replace(/\/+$/, '').replace(/\/v1$/, '')
}

function pruneUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
