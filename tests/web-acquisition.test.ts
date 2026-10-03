import { describe, expect, it } from 'vitest'
import { acquisitionFromRequest, firstTouchAcquisitionCookie, readFirstTouchAcquisition } from '../src/web/index'

const now = 1_790_000_000_000
const name = 'app_acquisition'
const landing = () => new Request('https://app.example/?utm_campaign=launch&utm_source=search&gclid=click-123&secret=never-store&attribution_test=1', {
  headers: { referer: 'https://search.example/results?token=secret' },
})

describe('first-touch acquisition', () => {
  it('preserves campaign through a sign-in round trip without storing referrer secrets or auth identity', () => {
    const header = firstTouchAcquisitionCookie(landing(), name, now)!
    expect(header).toContain('HttpOnly; SameSite=Lax; Max-Age=2592000; Secure')
    expect(header).not.toContain('Domain=')
    const returned = new Request('https://app.example/app?utm_campaign=second', { headers: { cookie: header.split(';')[0]! } })
    expect(firstTouchAcquisitionCookie(returned, name, now + 1000)).toBeNull()
    expect(readFirstTouchAcquisition(returned, name, now + 1000)).toEqual({
      parameters: { utm_campaign: 'launch', utm_source: 'search', gclid: 'click-123' },
      landingPath: '/', referrerOrigin: 'https://search.example', firstSeenAt: now, test: true,
    })
    expect(header).not.toContain('secret')
  })

  it('ignores direct visits and the product configured sign-in origin, but captures campaign-only and click-only arrivals', () => {
    expect(acquisitionFromRequest(new Request('https://app.example/'), now)).toBeNull()
    expect(acquisitionFromRequest(new Request('https://app.example/app', { headers: { referer: 'https://id.example/callback?code=secret' } }), now, ['https://id.example'])).toBeNull()
    expect(acquisitionFromRequest(new Request('https://app.example/?utm_campaign=campaign-only'), now)?.parameters).toEqual({ utm_campaign: 'campaign-only' })
    expect(acquisitionFromRequest(new Request('https://app.example/?gclid=click-only'), now)?.parameters).toEqual({ gclid: 'click-only' })
  })

  it('rejects malformed, expired, future and oversized cookies and bounds retained values', () => {
    const payload = acquisitionFromRequest(landing(), now)!
    const from = (value: unknown) => new Request('https://app.example/', { headers: { cookie: `${name}=${encodeURIComponent(JSON.stringify(value))}` } })
    for (const value of [[], {}, { ...payload, firstSeenAt: now + 1 }, { ...payload, firstSeenAt: now - 2592000001 }, { ...payload, landingPath: '/?token=secret' }, { ...payload, parameters: { utm_source: 'x'.repeat(4000) } }]) {
      expect(readFirstTouchAcquisition(from(value), name, now)).toBeNull()
    }
    expect(acquisitionFromRequest(new Request(`https://app.example/?utm_source=${'x'.repeat(2000)}`), now)?.parameters.utm_source?.length).toBe(160)
  })
})
