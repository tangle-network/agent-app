import { readCookieValue, serializeCookie } from './core'

const RETENTION_SECONDS = 30 * 24 * 60 * 60
const MAX_COOKIE_BYTES = 3600
const CAMPAIGN_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const
const CLICK_FIELDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id', 'twclid'] as const
const FIELDS = [...CAMPAIGN_FIELDS, ...CLICK_FIELDS] as const

/** Untrusted acquisition hints. Never use these fields for identity or authorization. */
export interface FirstTouchAcquisition {
  parameters: Partial<Record<typeof FIELDS[number], string>>
  referrerOrigin: string | null
  landingPath: string
  firstSeenAt: number
  test: boolean
}

function bounded(value: unknown, limit = 160): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit)
  return text || undefined
}

function origin(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? url.origin : null
  } catch { return null }
}

/** Capture only campaign fields and an external origin, never URL queries or referrer paths. */
export function acquisitionFromRequest(request: Request, now = Date.now(), ignoredReferrerOrigins: readonly string[] = []): FirstTouchAcquisition | null {
  const url = new URL(request.url)
  const parameters: FirstTouchAcquisition['parameters'] = {}
  for (const field of FIELDS) {
    const value = bounded(url.searchParams.get(field))
    if (value) parameters[field] = value
  }
  const referrer = origin(request.headers.get('referer'))
  const referrerOrigin = referrer === url.origin || (referrer !== null && ignoredReferrerOrigins.includes(referrer)) ? null : referrer
  if (!Object.keys(parameters).length && !referrerOrigin) return null
  return {
    parameters,
    referrerOrigin,
    landingPath: url.pathname.slice(0, 300),
    firstSeenAt: now,
    test: url.searchParams.get('attribution_test') === '1',
  }
}

/** Reject expired, future, malformed, and oversized hints without affecting authentication. */
export function readFirstTouchAcquisition(request: Request, cookieName: string, now = Date.now()): FirstTouchAcquisition | null {
  const raw = readCookieValue(request.headers.get('cookie'), cookieName)
  if (!raw || encodeURIComponent(raw).length > MAX_COOKIE_BYTES) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const input = value as Record<string, unknown>
    if (typeof input.firstSeenAt !== 'number' || !Number.isFinite(input.firstSeenAt)
      || input.firstSeenAt > now || input.firstSeenAt < now - RETENTION_SECONDS * 1000) return null
    if (typeof input.landingPath !== 'string' || !input.landingPath.startsWith('/')
      || input.landingPath.includes('?') || input.landingPath.includes('#')) return null
    if (!input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) return null
    const parameters: FirstTouchAcquisition['parameters'] = {}
    const source = input.parameters as Record<string, unknown>
    for (const field of FIELDS) {
      const value = bounded(source[field])
      if (value) parameters[field] = value
    }
    const referrerOrigin = typeof input.referrerOrigin === 'string' ? origin(input.referrerOrigin) : null
    if (!Object.keys(parameters).length && !referrerOrigin) return null
    return { parameters, referrerOrigin, landingPath: input.landingPath.slice(0, 300), firstSeenAt: input.firstSeenAt, test: input.test === true }
  } catch { return null }
}

/** Host-only HttpOnly cookie survives a top-level sign-in round trip. First valid touch wins. */
export function firstTouchAcquisitionCookie(request: Request, cookieName: string, now = Date.now(), ignoredReferrerOrigins: readonly string[] = []): string | null {
  if (readFirstTouchAcquisition(request, cookieName, now)) return null
  const acquisition = acquisitionFromRequest(request, now, ignoredReferrerOrigins)
  if (!acquisition) return null
  const raw = JSON.stringify(acquisition)
  if (encodeURIComponent(raw).length > MAX_COOKIE_BYTES) return null
  return serializeCookie(raw, {
    name: cookieName,
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(request.url).protocol === 'https:',
    maxAgeSeconds: RETENTION_SECONDS,
  })
}
