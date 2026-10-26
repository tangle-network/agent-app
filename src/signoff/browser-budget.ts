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
 * - count only requests that reach the network: Playwright's `request` event
 *   also fires for responses served from the browser's own cache, so 0.60.148
 *   counted a cached bundle as an edge request and its totals never moved when
 *   the cache worked (creative smoke: ~1900 before and after immutable assets).
 *   `meterPage` reads Chromium's `Network.responseReceived` and skips
 *   disk-cache, prefetch-cache and service-worker responses; a 304 still counts,
 *   because a revalidation does reach the edge;
 * - wait before a navigation whenever the last 10 s already holds
 *   `REQUEST_BUDGET_PER_10S`;
 * - report the total and the busiest 10 s, and exit `NETWORK_OVER_BUDGET_EXIT`
 *   when the busiest 10 s went over the budget, so an over-budget run fails
 *   instead of passing with a note. One page load can't be paced from outside
 *   the page, so the exit code is the enforcement.
 */
import type { Page, Browser, BrowserContextOptions } from 'playwright'

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

/** The fields of Chromium's `Network.responseReceived` that say where a response came from. */
export interface CdpResponseSource {
  readonly fromDiskCache?: boolean
  readonly fromPrefetchCache?: boolean
  readonly fromServiceWorker?: boolean
}

/** True when a response was fetched over the network, so the edge saw the request. */
export function reachedNetwork(response: CdpResponseSource): boolean {
  return !response.fromDiskCache && !response.fromPrefetchCache && !response.fromServiceWorker
}

/**
 * Count the requests a page sends to the network (Chromium only). Call it before
 * the page's first navigation. Never add a route instead: Playwright turns the
 * HTTP cache off for any context with a route.
 */
export async function meterPage(page: Page, meter: RequestMeter): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  // A memory-cache hit says so in its own event, before its response event.
  const fromMemory = new Set<string>()
  cdp.on('Network.requestServedFromCache', (event: { requestId: string }) => {
    fromMemory.add(event.requestId)
  })
  cdp.on('Network.responseReceived', (event: { requestId: string; response: CdpResponseSource }) => {
    if (fromMemory.delete(event.requestId)) return
    if (reachedNetwork(event.response)) meter.record()
  })
  await cdp.send('Network.enable')
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


/** Every visual check installs its theme before opening a network-metered page. */
export async function createMeteredBrowserPage(browser: Browser, options: BrowserContextOptions, meter: RequestMeter, themeScript?: string) {
  const context = await browser.newContext(options)
  if (themeScript) {
    await context.addInitScript({ content: `(() => { const theme = ${JSON.stringify(options.colorScheme)}; ${themeScript} })()` })
  }
  const page = await context.newPage()
  await meterPage(page, meter)
  return { context, page }
}

// A transient fault on the runner's network (an interface change under WSL or Tailscale) is not the
// app failing: Creative's release of 95b26f36 passed every functional check and failed one surface
// check on net::ERR_NETWORK_CHANGED. One retry after such a fault; any other navigation error, or a
// second fault, still fails the check.
const TRANSIENT_NAVIGATION = /net::ERR_(NETWORK_CHANGED|NETWORK_IO_SUSPENDED|INTERNET_DISCONNECTED|CONNECTION_RESET|CONNECTION_CLOSED)\b/

/** Navigate a check's page to `url`, retrying once after a transient network fault. */
export async function gotoRoute(
  page: { goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<unknown> },
  url: string,
): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
  } catch (error) {
    if (!TRANSIENT_NAVIGATION.test(error instanceof Error ? error.message : String(error))) throw error
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await page.goto(url, { waitUntil: 'domcontentloaded' })
  }
}
