/**
 * Check 4 — a failure the reader never learns about.
 *
 * The shape: a `catch` that clears a loading flag, or returns a fallback, and
 * tells nobody. The request failed; the screen renders the empty state. The
 * reader is shown "No documents yet" for a network error, believes the answer,
 * and acts on it. That is worse than an error message, because it is a
 * confident wrong answer rather than a visible problem.
 *
 * ── What passes ──────────────────────────────────────────────────────────────
 *
 * The handler surfaces the failure (an error/notice state setter, a toast, an
 * injected `onError`), or rethrows / rejects so a boundary above can. Anything
 * else — an empty body, `setLoading(false)`, `return []`, a lone
 * `console.error` — is a finding. `console.error` is deliberately NOT a sink:
 * it writes to a console the reader does not have.
 *
 * ── Precision ────────────────────────────────────────────────────────────────
 *
 * Only handlers around I/O are read. A `try { JSON.parse(raw) } catch { return
 * {} }` is a legitimate fallback over a value already in hand, and reporting it
 * is exactly the noise that gets a gate switched off — so a `try` block with no
 * `await`, no request call and no `.then` is skipped entirely. A `.catch(…)`
 * handler is always on a promise, so it needs no such test.
 *
 * Three narrowings were MEASURED against two production verticals, where the
 * unnarrowed check reported 52 handlers of which 14 were real (27%) — a rate
 * that gets a check deleted, not fixed:
 *
 *  1. Only modules that can reach a browser are read ({@link READERLESS_PATHS}).
 *     31 of the 52 sat in `.server/` service modules and resource routes, where
 *     the failure IS reported — to the operator's log — and the question of what
 *     the reader is told belongs to the caller that renders. This is the single
 *     largest noise class and it is a react-router CONVENTION, not a guess:
 *     `.server` modules are compiled out of the client bundle.
 *  2. A handler that RESTORES the prior value has surfaced the failure: the
 *     control the reader just moved visibly snaps back.
 *  3. A handler that RETURNS words — `return 'unknown'`, `new Response('Invalid
 *     JSON', …)` — hands a distinguishable outcome to a caller that renders it.
 *     Words inside a `console` call do not count, for the reason above.
 *
 * The cost is stated rather than hidden: narrowing 1 gives up the real
 * one-hop defect (a service returning `[]` on a network error, which a screen
 * then renders as "nothing here"). That is a caller-side finding this check
 * cannot see from the callee, and a product that wants it back passes
 * `readerlessPaths: []`.
 */

import { enclosingBlock } from '../source'
import type { ScannedFile } from '../scan'
import { evidenceOf } from '../scan'
import type { RawFinding, SilentFailureOptions } from '../types'

/**
 * The catch body does something the reader can perceive: rethrows, rejects,
 * toasts, sets an error-shaped state, or RETURNS a failure value
 * (`fail(…)` / `failOutcome(…)` / `{ error: … }`) for a caller to render.
 */
const ERROR_SINK =
  /\bthrow\b|\breject\s*\(|\btoast\b|\bfail[A-Za-z]*\s*\(|\b(set|show|render|display|report|surface|push|add|emit|on)[A-Za-z]*(error|failure|failed|problem|issue|notice|warning|message|banner|alert|toast)\s*\(|\b(error|failure|message|notice)\s*[:=][^=]/i

/** `console.log/warn/error(…)` — writes to a console the reader does not have. */
const CONSOLE_CALL = /\bconsole\s*\.\s*[a-z]+\s*\([^()]*(\([^()]*\)[^()]*)*\)/g

/**
 * The handler put the value the reader was looking at back. The control snaps
 * back on screen, which IS the failure being reported — measured on a plan-mode
 * toggle and a settings switch in two products.
 */
const RESTORES_STATE = /\b(set|restore|revert|roll)[A-Za-z]*\s*\(\s*(prev|previous|original|before|last|old)[A-Za-z]*\s*[,)]/i

/**
 * The handler returns something with WORDS in it — `return 'unknown'`,
 * `return new Response('Invalid JSON', { status: 400 })`, a result object
 * carrying a summary — which is a distinguishable outcome for a caller to
 * render, not a silent one. Run over a body whose `console` calls have already
 * been removed, so words written to a log never count.
 */
function returnsWords(bodyWithoutConsole: string): boolean {
  const at = bodyWithoutConsole.search(/\breturn\b/)
  return at !== -1 && /['"`]/.test(bodyWithoutConsole.slice(at))
}

/**
 * I/O in the guarded block — what makes a failure worth surfacing.
 *
 * `localStorage` and `navigator` are deliberately NOT here. A storage write
 * that fails in private mode loses a preference, not an answer; the shipped
 * instance is a theme toggle whose choice applies immediately and only fails to
 * persist, and reporting it teaches a team that this check does not know what a
 * failure is.
 */
const IO_IN_TRY = /\bawait\b|\.\s*then\s*\(|\bfetch\s*\(|\bXMLHttpRequest\b/

/** Reading a body off something already in hand: `res.json()`, `req.text()`. */
const BODY_READ_AFTER_AWAIT = /^[\s(]*[\w$.\s()]*?\.\s*(json|text|formData|arrayBuffer|blob)\s*\(\s*\)/

/**
 * Is the guarded block ONLY a body parse? That is a fallback over bytes already
 * in hand, not a request that failed — the same rule {@link isRequestChain}
 * applies to `.catch`, applied to `try`/`catch`, because
 * `try { body = await request.clone().json() } catch { body = {} }` is the
 * shipped shape four times across two products and none of them is a defect.
 */
function parseOnlyTry(tryBody: string): boolean {
  if (/\bfetch\s*\(|\.\s*then\s*\(|\bXMLHttpRequest\b/.test(tryBody)) return false
  const awaits = [...tryBody.matchAll(/\bawait\b/g)]
  if (awaits.length === 0) return false
  return awaits.every((match) => BODY_READ_AFTER_AWAIT.test(tryBody.slice((match.index ?? 0) + 'await'.length)))
}

/**
 * Paths whose modules cannot render. `.server` is react-router's server-only
 * convention (compiled out of the client bundle) and `routes/api.` its resource
 * -route naming; a `catch` in either reports to an operator, not to a reader.
 */
export const READERLESS_PATHS: readonly string[] = ['/.server/', '/routes/api.']

const CATCH_RE = /\bcatch\s*(?:\(([^)]*)\)\s*)?\{/g
const PROMISE_CATCH_RE = /\.\s*catch\s*\(/g

/** Run the silent-failure check over one lexed file. */
export function checkSilentFailure(file: ScannedFile, options: SilentFailureOptions = {}): RawFinding[] {
  const extraSinks = (options.extraErrorSinks ?? []).map((sink) => sink.toLowerCase())
  const readerless = options.readerlessPaths ?? READERLESS_PATHS
  if (readerless.some((marker) => file.path.includes(marker))) return []

  const masked = file.scan.masked
  const findings: RawFinding[] = []

  const surfaced = (body: string): boolean => {
    if (ERROR_SINK.test(body) || RESTORES_STATE.test(body)) return true
    if (returnsWords(body.replace(CONSOLE_CALL, ' '))) return true
    return extraSinks.some((sink) => body.toLowerCase().includes(sink))
  }

  CATCH_RE.lastIndex = 0
  for (const match of masked.matchAll(CATCH_RE)) {
    const braceAt = (match.index ?? 0) + (match[0]?.length ?? 1) - 1
    const block = blockFrom(masked, braceAt)
    if (block === null) continue
    const body = masked.slice(block.start + 1, block.end - 1)
    if (surfaced(body)) continue
    // The caught error carried outward — `return failOutcome(err(e))` — is
    // surfacing it through a value this check cannot follow, so it passes.
    // Carrying it into `console.warn(e)` and nowhere else is not.
    if (carriesError(body, match[1])) continue

    const guarded = tryBlockBefore(masked, match.index ?? 0)
    if (guarded === null || !IO_IN_TRY.test(guarded)) continue
    if (parseOnlyTry(guarded)) continue

    findings.push({
      check: 'silent-failure',
      offset: match.index ?? 0,
      message:
        body.trim().length === 0
          ? 'This catch swallows the failure entirely — the request failed and the screen will render as if it returned nothing.'
          : 'This catch never surfaces the failure — the reader sees an empty result, not a problem they can act on.',
      remedy:
        'Set an error state this screen renders (with a retry), or rethrow so a boundary above can. A console line is not a sink — the reader has no console.',
      evidence: evidenceOf(file.text, match.index ?? 0, block.end, 80),
    })
  }

  PROMISE_CATCH_RE.lastIndex = 0
  for (const match of masked.matchAll(PROMISE_CATCH_RE)) {
    const parenAt = (match.index ?? 0) + (match[0]?.length ?? 1) - 1
    const end = matchingParen(masked, parenAt)
    if (end === -1) continue
    const body = masked.slice(parenAt + 1, end - 1)
    if (body.trim().length === 0) continue
    if (surfaced(body)) continue
    if (!isRequestChain(masked, match.index ?? 0)) continue
    // `.catch(handleFailure)` hands the failure to a named function this check
    // cannot follow; only an inline handler is read.
    if (!/=>|\bfunction\b/.test(body)) continue

    findings.push({
      check: 'silent-failure',
      offset: match.index ?? 0,
      message: 'This .catch() handler discards the failure — the promise rejects and nothing on screen changes.',
      remedy:
        'Surface it: set the error state this view renders, or rethrow. If the failure is genuinely ignorable, suppress with a reason saying why.',
      evidence: evidenceOf(file.text, match.index ?? 0, end, 80),
    })
  }

  return findings.sort((left, right) => left.offset - right.offset)
}

/**
 * Is the promise this `.catch` is attached to a REQUEST?
 *
 * The dominant `.catch` in this fleet is `await res.json().catch(() => ({}))` —
 * 31 of 39 in one product — and it is not a legibility defect: it is a fallback
 * for a body that may not be JSON, on a response whose status the caller
 * already read. Reporting those buries the ones that matter. So the chain must
 * start at a request: `fetch(url).then(…).catch(() => null)` hides a network
 * failure and is reported; a parse fallback is not.
 *
 * The chain is walked BACKWARDS as an expression, not scanned back to the
 * nearest line break. That is the difference between finding the defect and
 * not: the shipped shape is written one call per line —
 *
 *     fetch('/api/templates')
 *       .then((r) => r.json())
 *       .then((data) => { setTemplates(data.templates ?? []); setLoading(false) })
 *       .catch(() => setLoading(false))
 *
 * — so a line-anchored scan sees only whitespace before `.catch`, finds no
 * `fetch`, and reports nothing. Two production screens (a template library and
 * a billing page) render a network failure as an empty list for exactly that
 * reason, and both were invisible to the line-anchored rule.
 */
function isRequestChain(masked: string, catchAt: number): boolean {
  const chain = masked.slice(chainStart(masked, catchAt), catchAt)
  if (!/\bfetch\s*\(/.test(chain)) return false
  return !/\.\s*(json|text|blob|arrayBuffer|formData)\s*\(\s*\)\s*$/.test(chain)
}

/**
 * Walk backwards over a member/call chain to the identifier it starts at,
 * jumping over balanced `(…)` / `[…]` so arguments, arrow bodies and line
 * breaks inside the chain are stepped over rather than terminating the walk.
 */
function chainStart(masked: string, from: number): number {
  let at = from
  for (;;) {
    // Trim at the TOP of every step, not once at the start: a fluent chain puts
    // a line break between `)` and the next `.`, and a walk that only trims on
    // entry stops at the first of them.
    at = trimmedEnd(masked, at)
    if (at <= 0) return 0
    const ch = masked[at - 1]
    if (ch === ')' || ch === ']') {
      const open = matchingOpenBefore(masked, at - 1)
      if (open === -1) return at
      at = trimmedEnd(masked, open)
      continue
    }
    if (ch !== undefined && /[\w$]/.test(ch)) {
      let start = at - 1
      while (start > 0 && /[\w$]/.test(masked[start - 1] ?? '')) start--
      const beforeIdent = trimmedEnd(masked, start)
      if (beforeIdent > 0 && masked[beforeIdent - 1] === '.') {
        at = beforeIdent - 1
        continue
      }
      return start
    }
    return at
  }
}

/** The largest index `i <= from` whose preceding character is not whitespace. */
function trimmedEnd(masked: string, from: number): number {
  let at = from
  while (at > 0 && /\s/.test(masked[at - 1] ?? '')) at--
  return at
}

/** Index of the `(` or `[` matching the closer at `close`, or -1. */
function matchingOpenBefore(masked: string, close: number): number {
  const closer = masked[close]
  const opener = closer === ')' ? '(' : '['
  let depth = 0
  for (let i = close; i >= 0; i--) {
    const ch = masked[i]
    if (ch === closer) depth++
    else if (ch === opener) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Does the body use the caught binding somewhere other than a console call?
 * A destructuring or typed binding (`catch (e: unknown)`) reduces to its name.
 */
function carriesError(body: string, binding: string | undefined): boolean {
  const name = /^[A-Za-z_$][\w$]*/.exec((binding ?? '').trim())?.[0]
  if (name === undefined) return false
  const withoutConsole = body.replace(CONSOLE_CALL, ' ')
  return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(withoutConsole)
}

/** The `{ … }` block whose opening brace is at `braceAt`. */
function blockFrom(masked: string, braceAt: number): { start: number; end: number } | null {
  let depth = 0
  for (let i = braceAt; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { start: braceAt, end: i + 1 }
    }
  }
  return null
}

function matchingParen(masked: string, open: number): number {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * The body of the `try` this `catch` belongs to. Returns null when the catch is
 * not preceded by a try block (a `.catch` was matched, or the source is
 * malformed) — the caller treats that as "not I/O" and skips.
 */
function tryBlockBefore(masked: string, catchAt: number): string | null {
  const before = masked.slice(0, catchAt).trimEnd()
  if (!before.endsWith('}')) return null
  const block = enclosingBlock(masked, before.length - 1)
  if (block === null) return null
  const head = masked.slice(Math.max(0, block.start - 8), block.start)
  if (!/\btry\s*$/.test(head)) return null
  return masked.slice(block.start, block.end)
}
