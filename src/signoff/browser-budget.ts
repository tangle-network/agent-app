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
 * - launch Chromium with prerender and speculative prefetch off, which also
 *   ignores the zone's `/cdn-cgi/speculation` rules;
 * - keep the HTTP cache: they never call `context.route`, because Playwright
 *   turns the cache off for a context with any route. In 0.60.141 a route that
 *   aborted the speculation rules did that, and every page reload re-downloaded
 *   every asset (creative production smoke: 1900 requests, busiest 10 s 373);
 * - count every request a context makes and wait before a navigation whenever
 *   the last 10 s already holds `REQUEST_BUDGET_PER_10S`;
 * - report the total and the busiest 10 s, and exit `NETWORK_OVER_BUDGET_EXIT`
 *   when the busiest 10 s went over the budget, so an over-budget run fails
 *   instead of passing with a note. One page load can't be paced from outside
 *   the page, so the exit code is the enforcement.
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

/** Count every request the context sends. Never add a route here: it would turn off the HTTP cache. */
export async function meterContext(context: BrowserContext, meter: RequestMeter): Promise<void> {
  context.on('request', () => meter.record())
}

/** Exit code of a check whose pages passed but whose busiest 10 s went over the budget. */
export const NETWORK_OVER_BUDGET_EXIT = 3

export function isOverBudget(count: NetworkCount, budget = REQUEST_BUDGET_PER_10S): boolean {
  return count.peak10s > budget
}

/** 0, or `NETWORK_OVER_BUDGET_EXIT` when the run went over the budget. */
export function networkExitCode(count: NetworkCount | undefined): number {
  return count && isOverBudget(count) ? NETWORK_OVER_BUDGET_EXIT : 0
}

export function formatNetworkCount(count: NetworkCount): string {
  const line = `network: ${count.requests} requests, busiest 10 s ${count.peak10s} (budget ${REQUEST_BUDGET_PER_10S})`
  return isOverBudget(count) ? `FAIL ${line}: over the shared edge budget` : line
}
