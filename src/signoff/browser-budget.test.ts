import { describe, expect, it } from 'vitest'

import { createRequestMeter, formatNetworkCount, NETWORK_OVER_BUDGET_EXIT, networkExitCode, QUIET_CHROMIUM_ARGS, reachedNetwork, REQUEST_BUDGET_PER_10S } from './browser-budget'

describe('browser check request budget', () => {
  it('counts requests and the busiest 10 s window', () => {
    const meter = createRequestMeter(100)
    for (let i = 0; i < 5; i++) meter.record(1_000 + i)
    for (let i = 0; i < 3; i++) meter.record(20_000 + i)
    expect(meter.count()).toEqual({ requests: 8, peak10s: 5 })
    expect(formatNetworkCount(meter.count())).toContain('8 requests, busiest 10 s 5')
  })

  it('waits before a navigation while the last 10 s holds the budget', async () => {
    const slept: number[] = []
    const meter = createRequestMeter(3, async (ms) => {
      slept.push(ms)
      // Time passes while the check sleeps: drop the window by recording nothing
      // and letting Date.now() move past it.
      fakeNow += ms
    })
    let fakeNow = Date.now()
    const realNow = Date.now
    Date.now = () => fakeNow
    try {
      for (let i = 0; i < 3; i++) meter.record(fakeNow)
      await meter.pace()
      expect(slept.length).toBe(1)
      expect(slept[0]).toBeGreaterThan(9_000)
      await meter.pace()
      expect(slept.length).toBe(1)
    } finally {
      Date.now = realNow
    }
  })

  it('turns off prerender and speculative prefetch', () => {
    expect(QUIET_CHROMIUM_ARGS.join(' ')).toMatch(/Prerender2/)
    expect(QUIET_CHROMIUM_ARGS.join(' ')).toMatch(/SpeculationRules/)
  })
  it('fails a run whose busiest 10 s went over the budget', () => {
    expect(networkExitCode({ requests: 1900, peak10s: 373 })).toBe(NETWORK_OVER_BUDGET_EXIT)
    expect(formatNetworkCount({ requests: 1900, peak10s: 373 })).toMatch(/^FAIL network: 1900 requests/)
    expect(networkExitCode({ requests: 400, peak10s: REQUEST_BUDGET_PER_10S })).toBe(0)
    expect(formatNetworkCount({ requests: 400, peak10s: 120 })).toMatch(/^network:/)
    expect(networkExitCode(undefined)).toBe(0)
  })

  it('counts a response only when it came over the network', () => {
    expect(reachedNetwork({})).toBe(true)
    expect(reachedNetwork({ fromDiskCache: true })).toBe(false)
    expect(reachedNetwork({ fromPrefetchCache: true })).toBe(false)
    expect(reachedNetwork({ fromServiceWorker: true })).toBe(false)
  })
})
