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
import type { ScannedFile } from '../scan';
import type { RawFinding, SilentFailureOptions } from '../types';
/**
 * Paths whose modules cannot render. `.server` is react-router's server-only
 * convention (compiled out of the client bundle) and `routes/api.` its resource
 * -route naming; a `catch` in either reports to an operator, not to a reader.
 */
export declare const READERLESS_PATHS: readonly string[];
/** Run the silent-failure check over one lexed file. */
export declare function checkSilentFailure(file: ScannedFile, options?: SilentFailureOptions): RawFinding[];
