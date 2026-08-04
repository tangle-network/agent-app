/**
 * Check 3 — success reported before the response was read.
 *
 * The shipped defect: a Settings page that answered "Saved" to a 404. `fetch`
 * resolves on 404 — it only rejects on a transport failure — so a handler that
 * awaits it and then celebrates has not checked anything. The reader is told
 * their change is stored; it is not; nothing in the UI ever says otherwise.
 *
 * ── What is required for a pass ──────────────────────────────────────────────
 *
 * Somewhere in the same function body, the response is INSPECTED: `res.ok`,
 * `res.status`, a destructured `{ ok }`, or a guard call the product names in
 * `success.okGuards`. Reading `await res.json()` is not inspection — a 404 body
 * parses fine.
 *
 * Two failing shapes, reported with different messages because the fixes
 * differ:
 *
 *   1. awaited but unchecked —  `await fetch(url, {…}); toast.success('Saved')`
 *   2. never awaited —          `fetch(url, {…}); setSaved(true)`
 *
 * ── Precision ────────────────────────────────────────────────────────────────
 *
 * Scope is the enclosing FUNCTION body, not the file: a component with a fetch
 * in one handler and a success in another must not report. The trigger is
 * narrow on both ends — only calls the product declares as HTTP (default:
 * `fetch`, which is the only one in the standard library that resolves on a
 * failed request), and only success signals that are unambiguous: `toast.success`,
 * a `set…Saved/Success/Done/Sent/Submitted(true)` setter, or a status setter
 * given a success word. A wrapper that throws on a bad status is correct by
 * construction and is not a default trigger; a wrapper that does NOT throw is
 * the same bug one level down, so a product wraps `fetch` by adding its wrapper
 * to `httpCalls`.
 */

import { enclosingFunctionBlock } from '../source'
import type { ScannedFile } from '../scan'
import { evidenceOf } from '../scan'
import type { RawFinding, SuccessOptions } from '../types'

/** Callees that resolve on a failed request instead of throwing. */
const DEFAULT_HTTP_CALLS: readonly string[] = ['fetch']

/** `toast.success(…)` and friends: the reader has been told it worked. */
const SUCCESS_CALLS = new Set(['toast.success', 'toast.ok', 'notifySuccess'])

/** `setSaved(true)`, `setSubmitted(true)`, `setIsDone(true)` … */
const SUCCESS_SETTER = /^set[A-Za-z]*(saved|success|succeeded|done|complete|completed|sent|submitted|confirmed)$/i

/** A status setter is a success signal only when its argument says so. */
const STATUS_SETTER = /^set[A-Za-z]*(status|state|phase|stage|message|notice)$/i
const SUCCESS_WORD = /^(saved|success|succeeded|done|sent|complete|completed|updated|created|ok)\b/i

/** The response was read for its outcome, not just its body. */
const INSPECTS_RESPONSE = /\.\s*(ok|status|statusText)\b|\{[^}\n]*\b(ok|status)\b[^}\n]*\}\s*=/

const CALL_RE = /(?<![\w$.])((?:new\s+)?[A-Za-z_$][\w$.]*)\s*\(/g

interface CallSite {
  readonly name: string
  /** Offset of the callee's first character. */
  readonly start: number
  /** Offset of the `(`. */
  readonly parenStart: number
  /** Offset just past the matching `)`, or -1 when unbalanced. */
  readonly parenEnd: number
}

/** Every call site in one file, read off the MASKED text so strings can't match. */
function callSites(masked: string): CallSite[] {
  const sites: CallSite[] = []
  CALL_RE.lastIndex = 0
  for (const match of masked.matchAll(CALL_RE)) {
    const name = (match[1] ?? '').replace(/^new\s+/, '')
    const start = match.index ?? 0
    const parenStart = start + (match[0]?.length ?? 1) - 1
    sites.push({ name, start, parenStart, parenEnd: matchingParen(masked, parenStart) })
  }
  return sites
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

/** Run the unchecked-success check over one lexed file. */
export function checkUncheckedSuccess(file: ScannedFile, options: SuccessOptions = {}): RawFinding[] {
  const httpCalls = new Set([...DEFAULT_HTTP_CALLS, ...(options.httpCalls ?? [])].map((call) => call.toLowerCase()))
  const okGuards = new Set((options.okGuards ?? []).map((guard) => guard.toLowerCase()))
  const extraSignals = new Set((options.extraSuccessSignals ?? []).map((signal) => signal.toLowerCase()))
  const masked = file.scan.masked

  const sites = callSites(masked)
  const requests = sites.filter((site) => httpCalls.has(site.name.toLowerCase()))
  if (requests.length === 0) return []

  const findings: RawFinding[] = []
  const reported = new Set<number>()

  for (const request of requests) {
    const scope = enclosingFunctionBlock(masked, request.start) ?? { start: 0, end: masked.length }
    if (reported.has(scope.start)) continue

    const body = masked.slice(scope.start, scope.end)
    if (INSPECTS_RESPONSE.test(body)) continue
    if (sites.some((site) => okGuards.has(site.name.toLowerCase()) && within(site.start, scope))) continue

    const signal = sites.find((site) => within(site.start, scope) && isSuccessSignal(file, site, extraSignals))
    if (!signal) continue

    reported.add(scope.start)
    const awaited = isAwaited(masked, request.start) || isChained(masked, request.parenEnd)
    findings.push({
      check: 'unchecked-success',
      offset: signal.start,
      message: awaited
        ? `"${signal.name}(…)" reports success, but nothing in this function reads the response's ok/status — ${request.name} resolves on a 404 as happily as on a 200.`
        : `"${signal.name}(…)" reports success before ${request.name}(…) has settled — the request is not awaited, so the outcome cannot be known yet.`,
      remedy: awaited
        ? `Check the response first: const res = await ${request.name}(…); if (!res.ok) { show the failure } else { ${signal.name}(…) }.`
        : `Await the request, then branch on res.ok. If it is deliberately fire-and-forget, say "sending" rather than "sent".`,
      evidence: evidenceOf(file.text, lineStart(file, signal.start), signal.parenEnd > 0 ? signal.parenEnd : signal.start),
    })
  }

  return findings
}

function within(offset: number, scope: { start: number; end: number }): boolean {
  return offset >= scope.start && offset < scope.end
}

function lineStart(file: ScannedFile, offset: number): number {
  const { line } = file.positionAt(offset)
  return file.lineStarts[line - 1] ?? offset
}

/** Is this call one that tells the reader the operation worked? */
function isSuccessSignal(file: ScannedFile, site: CallSite, extraSignals: ReadonlySet<string>): boolean {
  const name = site.name
  if (SUCCESS_CALLS.has(name) || extraSignals.has(name.toLowerCase())) return true
  const argument = firstArgument(file, site)
  if (SUCCESS_SETTER.test(name)) return argument.literal === null ? argument.code === 'true' : true
  if (STATUS_SETTER.test(name)) return argument.literal !== null && SUCCESS_WORD.test(argument.literal.trim())
  return false
}

/** The first argument as written: its string value when literal, else its code. */
function firstArgument(file: ScannedFile, site: CallSite): { literal: string | null; code: string } {
  const literal = file.scan.segments.find(
    (segment) =>
      (segment.kind === 'string' || segment.kind === 'template') &&
      segment.start > site.parenStart &&
      (site.parenEnd === -1 || segment.end <= site.parenEnd),
  )
  const code = file.scan.masked
    .slice(site.parenStart + 1, site.parenEnd > 0 ? site.parenEnd - 1 : site.parenStart + 40)
    .trim()
  // A literal only counts as THE first argument when no code precedes it. The
  // quote or backtick opening it is not code — the lexer blanks a literal's
  // VALUE and leaves its delimiter standing.
  const literalIsFirst =
    literal !== undefined &&
    file.scan.masked
      .slice(site.parenStart + 1, literal.start)
      .replace(/['"`]/g, '')
      .trim() === ''
  return { literal: literalIsFirst && literal ? literal.value : null, code }
}

function isAwaited(masked: string, callStart: number): boolean {
  return /\bawait\s*$/.test(masked.slice(Math.max(0, callStart - 12), callStart))
}

function isChained(masked: string, parenEnd: number): boolean {
  if (parenEnd <= 0) return false
  return /^\s*\.\s*(then|catch|finally)\b/.test(masked.slice(parenEnd, parenEnd + 24))
}
