/**
 * Pressing Send like a person, exactly as often as it takes and never once more.
 *
 * A new-chat composer can drop a press while its model selection is still
 * resolving, and its Send control is not disabled while that gate is shut, so
 * one press can be a silent no-op and a retry is necessary. A retry is also
 * dangerous: the press creates a thread, so a press after the page has already
 * submitted asks for a second one. Pure, so the rule is a unit test.
 */

/** Paths a submission from `routePath` lands on: the route itself and its single-fetch `.data` form. */
export function routeSubmitPaths(routePath: string): string[] {
  const singleFetch = routePath.endsWith('/') ? `${routePath}_.data` : `${routePath}.data`
  return [routePath, singleFetch]
}

export interface SubmissionTracker {
  /** Whether one request is a submission from the tracked page. */
  matches(method: string, url: string): boolean
  observe(method: string, url: string): void
  /** Submissions seen so far. Above zero means the turn is on its way. */
  readonly count: number
}

/**
 * Counts submissions from the page at `routeUrl`: a POST to that route (or its
 * `.data` form), or to one of `sendPaths`, on the same origin. A POST to the
 * same path on another origin is not this composer's.
 */
export function createSubmissionTracker(routeUrl: string, sendPaths: readonly RegExp[]): SubmissionTracker {
  if (!/^https?:\/\//i.test(routeUrl)) throw new Error(`createSubmissionTracker needs the page's full URL, got "${routeUrl}"`)
  const route = new URL(routeUrl)
  const exact = new Set(routeSubmitPaths(route.pathname))
  let count = 0
  const matches = (method: string, url: string): boolean => {
    if (method !== 'POST') return false
    let parsed: URL
    try {
      parsed = new URL(url, route.origin)
    } catch {
      return false
    }
    if (parsed.origin !== route.origin) return false
    return exact.has(parsed.pathname) || sendPaths.some((p) => p.test(parsed.pathname))
  }
  return {
    matches,
    observe(method, url) {
      if (matches(method, url)) count += 1
    },
    get count() {
      return count
    },
  }
}

export interface SendDriveOps {
  /** True once a submission, or the navigation it causes, has been observed. */
  landed: () => boolean
  /** Wait until Send can take a press, without pressing it. */
  ready: () => Promise<void>
  click: () => Promise<void>
  /** Pause between presses, spent watching for the submission. */
  wait: () => Promise<void>
  attempts: number
}

/**
 * Press until the page submits. Each attempt waits for the control first and
 * takes its last look at `landed()` after that wait, so the press itself is the
 * only unguarded moment. A click failure is tolerated only once something has
 * landed: an accepted send tears the composer down mid-press.
 */
export async function clickUntilSubmitted(ops: SendDriveOps): Promise<void> {
  for (let attempt = 0; attempt < ops.attempts; attempt += 1) {
    if (ops.landed()) return
    try {
      await ops.ready()
      if (ops.landed()) return
      await ops.click()
    } catch (cause) {
      if (!ops.landed()) throw cause
    }
    if (ops.landed()) return
    await ops.wait()
  }
  if (ops.landed()) return
  throw new Error(`Send never submitted: the composer refused ${ops.attempts} presses`)
}

/**
 * Read until the value stops changing: six identical reads 500 ms apart. Every
 * caller has already seen the turn finish, so this covers render lag only.
 */
export async function settleText(
  read: () => Promise<string>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let previous: string | null = null
  let stable = 0
  for (;;) {
    const current = await read().catch(() => null)
    if (current === null) {
      stable = 0
    } else {
      stable = current === previous ? stable + 1 : 1
      previous = current
      if (stable >= 6) return current
    }
    if (Date.now() >= deadline) return previous ?? ''
    await wait(500)
  }
}

/**
 * The text a composer holds. A `<textarea>` or `<input>` (agent-app's own
 * ChatComposer) keeps typed text in `.value` and leaves `innerText` empty; a
 * contenteditable composer keeps it in `innerText`. Reading only `innerText`
 * failed every first chat turn on the default composer (Casework C1/C5).
 */
export async function composerText(box: { evaluate<R>(fn: (el: Element) => R): Promise<R> }): Promise<string> {
  return box.evaluate((el) => {
    const field = el as Element & { value?: unknown; innerText?: string }
    return typeof field.value === 'string' ? field.value : (field.innerText ?? el.textContent ?? '')
  })
}
