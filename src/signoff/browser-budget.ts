/**
 * Network budget for the browser checks (`shell-alignment`, `surface-ladder`,
 * `workspace-surface`) when they run against a live site.
 *
 * Every Tangle app sits behind one Cloudflare zone that allows 1000 requests per
 * 10 s per IP, and the fleet's Beelinks and workstation share one egress IP. On
 * 2026-10-12 a production sweep of these checks sent 1533-1782 requests a minute:
 * each page load pulled every asset, and Cloudflare's speculation rules made
 * Chromium prerender every rail link as a hidden full page. It blocked a
 * production canary on another app. So the checks:
 *
 * - launch Chromium with prerender and speculative prefetch off, and abort the
 *   zone's `/cdn-cgi/speculation` rules;
 * - count every request a context makes and wait before a navigation whenever
 *   the last 10 s already holds `REQUEST_BUDGET_PER_10S`;
 * - report the total and the busiest 10 s, so a run can be checked against the
 *   edge's own count.
 */
import type { BrowserContext } from 'playwright'

/** Chromium flags that stop prerender and speculative prefetch of linked pages. */
export const QUIET_CHROMIUM_ARGS: readonly string[] = [
  '--disable-features=Prerender2,SpeculationRules,SpeculationRulesPrefetchProxy,NoStatePrefetch',
  '--disable-background-networking',
]

/** Requests per 10 s a check may send; a quarter of the shared zone limit. */
export const REQUEST_BUDGET_PER_10S = 250
const WINDOW_MS = 10_000

export interface NetworkCount {
  /** Requests the browser sent during the run. */
  readonly requests: number
  /** The most requests inside any 10 s window. */
  readonly peak10s: number
}

export interface RequestMeter {
  /** Count one request. */
  record(now?: number): void
  /** Resolve once the last 10 s holds fewer than the budget. */
  pace(): Promise<void>
  count(): NetworkCount
}

export function createRequestMeter(budget = REQUEST_BUDGET_PER_10S, sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))): RequestMeter {
  const stamps: number[] = []
  let requests = 0
  let peak10s = 0
  const trim = (now: number) => {
    while (stamps.length && now - stamps[0]! > WINDOW_MS) stamps.shift()
  }
  return {
    record(now = Date.now()) {
      requests += 1
      stamps.push(now)
      trim(now)
      peak10s = Math.max(peak10s, stamps.length)
    },
    async pace() {
      for (;;) {
        const now = Date.now()
        trim(now)
        if (stamps.length < budget) return
        await sleep(WINDOW_MS - (now - stamps[0]!) + 50)
      }
    },
    count: () => ({ requests, peak10s }),
  }
}

/** Abort the zone's speculation rules and count every request the context sends. */
export async function meterContext(context: BrowserContext, meter: RequestMeter): Promise<void> {
  await context.route('**/cdn-cgi/speculation*', (route) => route.abort())
  context.on('request', () => meter.record())
}

export function formatNetworkCount(count: NetworkCount): string {
  return `network: ${count.requests} requests, busiest 10 s ${count.peak10s} (budget ${REQUEST_BUDGET_PER_10S})`
}
