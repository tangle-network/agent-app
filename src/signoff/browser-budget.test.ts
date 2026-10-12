import { describe, expect, it } from 'vitest'

import { createRequestMeter, formatNetworkCount, QUIET_CHROMIUM_ARGS } from './browser-budget'

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
})
