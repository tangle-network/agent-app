import { describe, expect, it, vi } from 'vitest'
import {
  FREE_TIER_SPEND_CAP_USD,
  getProductEntitlement,
  isProductEntitled,
  isSeatBillingEnabled,
  seatCheckoutUrl,
  createPlatformBillingHttp,
  type ProductEntitlement,
  type PlatformBillingHttp,
} from './billing'

const httpWith = (
  impl: PlatformBillingHttp['getProductEntitlement'],
): Pick<PlatformBillingHttp, 'getProductEntitlement'> => ({ getProductEntitlement: impl })

const ENT: ProductEntitlement = {
  seatStatus: 'active',
  currentPeriodEnd: '2026-07-14T00:00:00.000Z',
  lifetimeSpentUsd: 0.5,
  hasSeat: true,
  onFreeTier: false,
}

describe('isProductEntitled', () => {
  it('defines no product-funded free spend', () => {
    expect(FREE_TIER_SPEND_CAP_USD).toBe(0)
  })

  it('entitled when a seat is held', () => {
    expect(isProductEntitled({ ...ENT, hasSeat: true, onFreeTier: false })).toBe(true)
  })
  it('does not grant product access from the retired free-tier signal', () => {
    expect(isProductEntitled({ ...ENT, hasSeat: false, onFreeTier: true })).toBe(false)
  })
  it('not entitled with no seat and free tier exhausted', () => {
    expect(isProductEntitled({ ...ENT, hasSeat: false, onFreeTier: false })).toBe(false)
  })
})

describe('getProductEntitlement availability policy', () => {
  it('denies access when the flag is off, without calling the platform', async () => {
    const spy = vi.fn()
    const ent = await getProductEntitlement(httpWith(spy), 'key', 'gtm', false)
    expect(spy).not.toHaveBeenCalled()
    expect(ent.hasSeat).toBe(false)
    expect(isProductEntitled(ent)).toBe(false)
  })

  it('denies access when no user key is present', async () => {
    const spy = vi.fn()
    const ent = await getProductEntitlement(httpWith(spy), null, 'gtm', true)
    expect(spy).not.toHaveBeenCalled()
    expect(ent.hasSeat).toBe(false)
    expect(isProductEntitled(ent)).toBe(false)
  })

  it('propagates seat endpoint failures so callers can return a retryable error', async () => {
    await expect(
      getProductEntitlement(
        httpWith(async () => {
          throw new Error('seat endpoint not found')
        }),
        'key',
        'gtm',
        true,
      ),
    ).rejects.toThrow('seat endpoint not found')
  })

  it('passes through a real platform answer when reachable', async () => {
    const walled: ProductEntitlement = {
      seatStatus: 'canceled',
      currentPeriodEnd: null,
      lifetimeSpentUsd: 12,
      hasSeat: false,
      onFreeTier: false,
    }
    const ent = await getProductEntitlement(httpWith(async () => walled), 'key', 'gtm', true)
    expect(ent).toEqual(walled)
    expect(isProductEntitled(ent)).toBe(false)
  })
})

describe('isSeatBillingEnabled', () => {
  it('defaults ON when the environment is unknown', () => {
    expect(isSeatBillingEnabled({ env: {} })).toBe(true)
  })
  it('defaults ON in deployed environments', () => {
    for (const value of ['production', 'staging', 'preview']) {
      expect(isSeatBillingEnabled({ env: { APP_ENV: value } })).toBe(true)
    }
  })
  it('defaults OFF only in known development and test environments', () => {
    for (const value of ['development', 'dev', 'local', 'test']) {
      expect(isSeatBillingEnabled({ env: { APP_ENV: value } })).toBe(false)
    }
    expect(isSeatBillingEnabled({ env: { NODE_ENV: 'test' } })).toBe(false)
  })
  it('OFF for falsey values', () => {
    for (const value of ['false', '0', 'off', 'disabled', ' FALSE ']) {
      expect(isSeatBillingEnabled({ env: { SEAT_BILLING_ENABLED: value } })).toBe(false)
    }
  })
  it('ON for truthy values', () => {
    for (const v of ['true', '1', 'on', 'enabled', 'TRUE', ' On ']) {
      expect(isSeatBillingEnabled({ env: { SEAT_BILLING_ENABLED: v } })).toBe(true)
    }
  })
  it('explicit values override the environment default', () => {
    expect(
      isSeatBillingEnabled({
        env: { APP_ENV: 'development', SEAT_BILLING_ENABLED: 'true' },
      }),
    ).toBe(true)
    expect(
      isSeatBillingEnabled({
        env: { APP_ENV: 'production', SEAT_BILLING_ENABLED: 'false' },
      }),
    ).toBe(false)
  })
  it('honours a custom flag name', () => {
    expect(
      isSeatBillingEnabled({ env: { GTM_SEAT_BILLING: 'on' }, flagEnvVar: 'GTM_SEAT_BILLING' }),
    ).toBe(true)
  })
})

describe('seatCheckoutUrl', () => {
  it('builds a platform-rooted checkout URL carrying the product', () => {
    expect(seatCheckoutUrl('https://id.tangle.tools', 'creative')).toBe(
      'https://id.tangle.tools/app/billing/seat/checkout?product=creative',
    )
  })
  it('strips trailing slashes and encodes the product', () => {
    expect(seatCheckoutUrl('https://id.tangle.tools/', 'a/b')).toBe(
      'https://id.tangle.tools/app/billing/seat/checkout?product=a%2Fb',
    )
  })
})

describe('createPlatformBillingHttp.getProductEntitlement transport', () => {
  it('unwraps the {success,data} envelope and derives onFreeTier off hasSeat', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe(
        'https://id.tangle.tools/v1/billing/product-entitlement?product=gtm',
      )
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            seatStatus: 'active',
            currentPeriodEnd: '2026-07-14T00:00:00.000Z',
            lifetimeSpentUsd: 3.2,
            hasSeat: true,
            // platform also true, but a held seat must force onFreeTier false
            onFreeTier: true,
            offer: {
              currency: 'usd',
              interval: 'month',
              recurring: {
                priceCents: 100_000,
                includedCreditsCents: 10_000,
              },
              introductory: {
                priceCents: 2_000,
                includedCreditsCents: 1_000,
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const http = createPlatformBillingHttp({
      baseUrl: 'https://id.tangle.tools',
      serviceToken: 'svc',
      productSlug: 'gtm',
      fetchImpl,
    })
    const ent = await http.getProductEntitlement('user-key', 'gtm')
    expect(ent.hasSeat).toBe(true)
    expect(ent.onFreeTier).toBe(false)
    expect(ent.lifetimeSpentUsd).toBe(3.2)
    expect(ent.offer).toEqual({
      currency: 'usd',
      interval: 'month',
      recurring: {
        priceCents: 100_000,
        includedCreditsCents: 10_000,
      },
      introductory: {
        priceCents: 2_000,
        includedCreditsCents: 1_000,
      },
    })
    expect(http.seatCheckoutUrl('gtm')).toBe(
      'https://id.tangle.tools/app/billing/seat/checkout?product=gtm',
    )
  })

  it('defaults missing fields safely (no seat → seatStatus none)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch
    const http = createPlatformBillingHttp({
      baseUrl: 'https://id.tangle.tools',
      serviceToken: 'svc',
      productSlug: 'gtm',
      fetchImpl,
    })
    const ent = await http.getProductEntitlement('user-key', 'gtm')
    expect(ent).toEqual({
      seatStatus: 'none',
      currentPeriodEnd: null,
      lifetimeSpentUsd: 0,
      hasSeat: false,
      onFreeTier: false,
    })
  })

  it('discards a stale platform free-tier grant when no paid seat exists', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              seatStatus: 'none',
              hasSeat: false,
              onFreeTier: true,
              lifetimeSpentUsd: 0,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch
    const http = createPlatformBillingHttp({
      baseUrl: 'https://id.tangle.tools',
      serviceToken: 'svc',
      productSlug: 'gtm',
      fetchImpl,
    })

    const ent = await http.getProductEntitlement('user-key', 'gtm')

    expect(ent.onFreeTier).toBe(false)
    expect(isProductEntitled(ent)).toBe(false)
  })
})
