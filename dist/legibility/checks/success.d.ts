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
import type { ScannedFile } from '../scan';
import type { RawFinding, SuccessOptions } from '../types';
/** Run the unchecked-success check over one lexed file. */
export declare function checkUncheckedSuccess(file: ScannedFile, options?: SuccessOptions): RawFinding[];
