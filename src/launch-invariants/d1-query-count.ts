/**
 * AsyncLocalStorage counter ported from tangle-network/creative-agent,
 * commit 8e0d55449f6662dda3cfd5bbe75388d792a5cea3,
 * src/lib/.server/db/query-count.ts.
 * Source license: no license declared in that private repository. This port is
 * distributed under agent-app's MIT license (LICENSE).
 * The binding proxy remains owned by withD1LimitAlarms.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** Round trips: batch = 1; first/all/raw/run = 1 each, including failed calls. */
export interface D1QueryCounter { queries: number }
const scope = new AsyncLocalStorage<D1QueryCounter>()

/** Run work in a fresh counter scope. Async descendants retain it after work returns. */
export function withD1QueryCount<T>(work: () => T): T {
  return scope.run({ queries: 0 }, work)
}

/** The current scope's counter, shared with the turn trace and product phase logs. */
export function currentD1QueryCounter(): D1QueryCounter | undefined {
  return scope.getStore()
}

export function tallyD1Query(): void {
  const counter = scope.getStore()
  if (counter) counter.queries += 1
}
