/**
 * `createSandboxPrewarmer` — "this user just opened this project; start warming
 * their box" as a shell primitive, so every agent-app product gets the same
 * answer instead of forking one.
 *
 * WHY THIS IS SHELL, NOT ENGINE. The engine rule asks whether the capability
 * makes sense without a specific app's side channel. "Warm a box" does — but
 * `@tangle-network/sandbox` has no notion of a WORKSPACE. It keys boxes by an
 * opaque sandbox id; the workspace→box mapping, the harness match, and the
 * profile materialisation all live in `ensureWorkspaceSandbox` here. A
 * prewarmer is that mapping plus a scheduling policy, so it belongs beside it.
 * It is deliberately NOT a new subpath: it composes `peekWorkspaceSandbox` and
 * `ensureWorkspaceSandbox` directly and needs exactly the peers `/sandbox`
 * already needs, so a separate entry would add a second place to look for "how
 * do I get a box" and buy no peer isolation (the reason `/work-product-react`
 * is split out).
 *
 * WHAT IT IS NOT. It does not make cold starts fast — they already are.
 * Measured on the real platform (staging-sandbox, n=5, 2026-07-28): a box goes
 * from nothing to terminal-ready in 2.34–3.19 s (median 2.73 s), and an
 * already-running box answers in 1.16–2.29 s (median 1.35 s). Prewarming buys
 * ~1.4 s. The reason it matters is not latency: it is that a product which
 * only ever provisions lazily, on a path whose guard never passes, never
 * provisions AT ALL — and the UI then shows a spinner over a box that does not
 * exist and is not being created. That is the failure this primitive removes.
 *
 * ── COST POSTURE (read before adopting) ────────────────────────────────────
 * A warmed box is a REAL charge. It bills from creation until the platform's
 * idle timeout reclaims it — `SandboxRuntimeConfig`'s create-time
 * `idleTimeoutSeconds`, not anything this module sets. A product warming on
 * every project open pays that timeout for every user who opens and bounces.
 * With a 3600 s idle timeout against a ~131 s mean session life, a bounce
 * costs an hour of box time to save ~1.4 s. THAT TRADE IS USUALLY WRONG.
 *
 * So the levers are explicit and the defaults are the cheap ones:
 *   - `mode: 'resume-only'` (DEFAULT) never creates a box that does not exist.
 *     It only revives one the user already has, so the spend is bounded by
 *     boxes the user already caused. This is the safe fleet default.
 *   - `mode: 'create-or-resume'` is the owner-requested behaviour — warm on
 *     open even for a first-time user. Opt in per product, and lower the
 *     shell's `idleTimeoutSeconds` when you do.
 *   - `shouldPrewarm(scope)` is the product's own policy hook (paid tier only,
 *     returning user only, has-documents only …). Returning false costs nothing.
 *   - `failureCooldownMs` stops a hard-failing workspace from retry-storming;
 *     every retry is another create attempt, which is more spend.
 * Warm with the SAME harness the next turn will use. `ensureWorkspaceSandbox`
 * DELETES and recreates a name-matched box whose harness differs, so warming
 * `opencode` and then turning `claude-code` pays for two boxes and is slower
 * than not warming at all. The prewarm key includes the harness so the two are
 * never deduped into one.
 *
 * ── SINGLE-FLIGHT (measured, not assumed) ──────────────────────────────────
 * The sandbox platform does NOT dedupe by box name. Two concurrent
 * `POST /v1/sandboxes` with an identical name both returned HTTP 201 and left
 * two running boxes (verified against staging-sandbox, 2026-07-28). So two
 * tabs, or two isolates, racing a warm genuinely leak a box — a prewarm that
 * races is worse than no prewarm. Hence two layers:
 *   1. an in-process map, which is free and catches same-isolate races
 *      (double-mount, two requests on one isolate);
 *   2. a `claim` store the product supplies, which is the only thing that can
 *      make this correct ACROSS isolates — the usual deployment target here is
 *      Cloudflare Workers, where "same isolate" guarantees nothing.
 * `claim` is REQUIRED, with `'single-isolate-only'` as the explicit opt-out,
 * so nobody gets the unsafe behaviour by forgetting a field. Say it out loud
 * or supply a store.
 *
 * ── FAILURE IS LOUD, NEVER FATAL ───────────────────────────────────────────
 * A failed warm degrades to exactly today's lazy path: the next real request
 * calls `ensureWorkspaceSandbox` itself. It never throws into the caller's
 * render path — `completion` RESOLVES with `{ ok: false }` rather than
 * rejecting, because an unhandled rejection handed to `waitUntil` can fail the
 * request it rode in on. But it is never silent: every failure fires
 * `onEvent({ type: 'failed' })` and is readable afterwards through
 * `readiness()` as `{ status: 'failed' }`. The bug class this whole module
 * exists to kill is a soft failure that surfaces as an unusable panel ten
 * minutes later, so a warm that dies must leave a trace a product can render.
 */

import type { SandboxInstance } from '@tangle-network/sandbox/core'
import type { Harness } from '../harness/index'
import {
  ensureWorkspaceSandbox,
  peekWorkspaceSandbox,
  type SandboxRuntimeConfig,
} from './index'

/** The workspace a warm targets. Mirrors `EnsureWorkspaceSandboxOptions`'
 *  identity fields — the prewarmer forwards them verbatim so a warmed box is
 *  byte-identical to the one the lazy path would have built. */
export interface SandboxPrewarmScope {
  workspaceId: string
  userId?: string
  /** Must match the harness the next turn will use — see the cost note above. */
  harness: Harness
  billingOwnerId?: string
}

/**
 * Cross-isolate claim. `acquire` must be atomic (a D1 conditional insert, a DO,
 * a KV `put` with `onlyIf`) — a read-then-write is exactly the race this exists
 * to close. `ttlSeconds` bounds a claim leaked by an isolate that died
 * mid-warm; without expiry a single crash wedges a workspace forever.
 */
export interface PrewarmClaimStore {
  /** True when THIS caller now owns the right to warm `key`. */
  acquire(key: string, ttlSeconds: number): Promise<boolean>
  /** Best-effort release. A throw here is swallowed — the TTL is the backstop. */
  release(key: string): Promise<void>
  /** Optional: lets `readiness()` report `warming` for a warm running in
   *  ANOTHER isolate. Without it, `warming` is only visible in the isolate
   *  that started it, and every other one reports `absent`. */
  isHeld?(key: string): Promise<boolean>
}

/** What `prewarm()` decided. Every value except `started` means no box was
 *  created and nothing was spent on this call. */
export type PrewarmOutcome =
  | 'started'
  | 'already-running'
  | 'already-warming'
  | 'warming-elsewhere'
  | 'declined-by-policy'
  | 'cooling-down'
  | 'absent-and-resume-only'

/** Terminal result of a warm this caller owns. Never a rejection. */
export interface PrewarmResult {
  ok: boolean
  boxId?: string
  error?: string
  /** Wall time of the warm itself, for the product's own timing trace. */
  ms: number
}

export interface PrewarmDecision {
  outcome: PrewarmOutcome
  /** Present ONLY when `outcome === 'started'`. Hand it to `ctx.waitUntil` so a
   *  client disconnect cannot kill the warm. Never rejects. */
  completion?: Promise<PrewarmResult>
}

/** Readiness for the UI. `ready`/`warming` reuse the vocabulary
 *  `createSandboxFileIndexRoute` (`/chat-routes`) and `useFileMentions`
 *  (`/web-react`) already speak, so a product renders ONE warming state rather
 *  than inventing a second spinner for boxes. */
export type SandboxReadiness =
  | { status: 'ready'; boxId: string }
  | { status: 'warming' }
  | { status: 'absent' }
  | { status: 'failed'; error: string; retryAfterMs: number }

export type PrewarmEvent =
  | { type: 'started'; key: string; workspaceId: string }
  | { type: 'succeeded'; key: string; workspaceId: string; boxId: string; ms: number }
  | { type: 'failed'; key: string; workspaceId: string; error: string; ms: number }
  | { type: 'skipped'; key: string; workspaceId: string; outcome: PrewarmOutcome }

export interface SandboxPrewarmerOptions {
  /** Cross-isolate single-flight, or the explicit acknowledgement that you are
   *  accepting per-isolate dedupe only. No default — see the header. */
  claim: PrewarmClaimStore | 'single-isolate-only'
  /** `'resume-only'` (default) never creates a box that does not exist.
   *  `'create-or-resume'` warms from nothing — the expensive one. */
  mode?: 'resume-only' | 'create-or-resume'
  /** Product policy gate. Not called when a box is already running. */
  shouldPrewarm?(scope: SandboxPrewarmScope): boolean | Promise<boolean>
  /** Observability seam. A failed warm MUST be visible somewhere. */
  onEvent?(event: PrewarmEvent): void
  /** Claim lifetime. Default 180 s — comfortably over a cold create. */
  claimTtlSeconds?: number
  /** Suppress re-warming a workspace that just failed. Default 60_000 ms. */
  failureCooldownMs?: number
  /** Clock seam for tests. */
  now?(): number
}

export interface SandboxPrewarmer {
  /**
   * Non-blocking warm. The returned promise settles as soon as the DECISION is
   * known (at most one `list()` against the platform, plus a claim `acquire`);
   * the provisioning itself rides on `completion`. On a render path either
   * ignore the returned promise or run the whole call inside `waitUntil` — do
   * not await `completion` before responding.
   */
  prewarm(scope: SandboxPrewarmScope): Promise<PrewarmDecision>
  /** Zero-provisioning status read for a UI. Never creates or resumes. */
  readiness(scope: SandboxPrewarmScope): Promise<SandboxReadiness>
  /** Clear a recorded failure so the next `prewarm` retries immediately. */
  clearFailure(scope: SandboxPrewarmScope): void
}

/** Identity of a warm. Harness is part of it because `ensureWorkspaceSandbox`
 *  destroys and rebuilds a box whose harness does not match. */
function prewarmKey(scope: SandboxPrewarmScope): string {
  return `${scope.workspaceId}::${scope.harness}`
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createSandboxPrewarmer(
  shell: SandboxRuntimeConfig,
  options: SandboxPrewarmerOptions,
): SandboxPrewarmer {
  const mode = options.mode ?? 'resume-only'
  const claimTtlSeconds = options.claimTtlSeconds ?? 180
  const failureCooldownMs = options.failureCooldownMs ?? 60_000
  const now = options.now ?? (() => Date.now())
  const claim = options.claim === 'single-isolate-only' ? null : options.claim

  const inFlight = new Map<string, Promise<PrewarmResult>>()
  const failures = new Map<string, { error: string; until: number }>()

  const emit = (event: PrewarmEvent): void => {
    try {
      options.onEvent?.(event)
    } catch {
      // An observability seam must never take down the warm it is reporting on.
    }
  }

  async function releaseClaim(key: string): Promise<void> {
    if (!claim) return
    try {
      await claim.release(key)
    } catch {
      // Best effort by contract — the TTL is what actually guarantees release.
    }
  }

  /**
   * Owns the box work for one warm. Resolves; never rejects.
   *
   * Clears `inFlight` in its own `finally`, BEFORE the returned promise
   * settles, so the invariant a caller can rely on is: once `completion`
   * resolves, the key is free. Deferring the delete to a `.finally()` chained
   * outside would leave it queued one microtask later, and a caller that
   * awaits `completion` and immediately re-warms would get a stale
   * `already-warming` instead of a real decision.
   */
  async function runWarm(
    key: string,
    scope: SandboxPrewarmScope,
    holdsClaim: boolean,
  ): Promise<PrewarmResult> {
    const startedAt = now()
    emit({ type: 'started', key, workspaceId: scope.workspaceId })
    try {
      const box: SandboxInstance = await ensureWorkspaceSandbox(shell, {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        harness: scope.harness,
        billingOwnerId: scope.billingOwnerId,
      })
      const ms = now() - startedAt
      failures.delete(key)
      emit({ type: 'succeeded', key, workspaceId: scope.workspaceId, boxId: box.id, ms })
      return { ok: true, boxId: box.id, ms }
    } catch (err) {
      const ms = now() - startedAt
      const error = errText(err)
      // Recorded, not thrown: the next real request still takes the lazy path,
      // and `readiness()` can now tell the UI the warm failed instead of
      // leaving it to spin over a box that is never coming.
      failures.set(key, { error, until: now() + failureCooldownMs })
      emit({ type: 'failed', key, workspaceId: scope.workspaceId, error, ms })
      return { ok: false, error, ms }
    } finally {
      inFlight.delete(key)
      if (holdsClaim) await releaseClaim(key)
    }
  }

  return {
    async prewarm(scope: SandboxPrewarmScope): Promise<PrewarmDecision> {
      const key = prewarmKey(scope)

      // Synchronous guards first — these run before any `await`, so two calls
      // in one isolate cannot both get past this point.
      if (inFlight.has(key)) {
        emit({ type: 'skipped', key, workspaceId: scope.workspaceId, outcome: 'already-warming' })
        return { outcome: 'already-warming' }
      }
      const failure = failures.get(key)
      if (failure && now() < failure.until) {
        emit({ type: 'skipped', key, workspaceId: scope.workspaceId, outcome: 'cooling-down' })
        return { outcome: 'cooling-down' }
      }

      // Reserve the key for THIS isolate before the first await. The reservation
      // is a placeholder the real warm replaces; without it, two concurrent
      // callers would both suspend on `peek` and both proceed.
      let settle: (result: PrewarmResult) => void = () => {}
      const reservation = new Promise<PrewarmResult>((resolve) => {
        settle = resolve
      })
      inFlight.set(key, reservation)

      const abandon = (outcome: PrewarmOutcome): PrewarmDecision => {
        inFlight.delete(key)
        settle({ ok: false, error: outcome, ms: 0 })
        emit({ type: 'skipped', key, workspaceId: scope.workspaceId, outcome })
        return { outcome }
      }

      try {
        // Cheapest question first: is it already running? Costs one list() and
        // no claim, so the common "user reopens a warm project" path spends
        // nothing.
        const peek = await peekWorkspaceSandbox(shell, {
          workspaceId: scope.workspaceId,
          userId: scope.userId,
        })
        if (peek.status === 'running') return abandon('already-running')
        if (peek.status === 'absent' && mode === 'resume-only') {
          return abandon('absent-and-resume-only')
        }

        if (options.shouldPrewarm) {
          const allowed = await options.shouldPrewarm(scope)
          if (!allowed) return abandon('declined-by-policy')
        }

        let holdsClaim = false
        if (claim) {
          holdsClaim = await claim.acquire(key, claimTtlSeconds)
          if (!holdsClaim) return abandon('warming-elsewhere')
        }

        // The key is already reserved above; `runWarm` owns clearing it.
        const warm = runWarm(key, scope, holdsClaim)
        void warm.then(settle)
        return { outcome: 'started', completion: warm }
      } catch (err) {
        // A peek/policy/claim failure is a failed warm like any other: recorded,
        // surfaced, and degraded to the lazy path.
        const error = errText(err)
        inFlight.delete(key)
        failures.set(key, { error, until: now() + failureCooldownMs })
        settle({ ok: false, error, ms: 0 })
        emit({ type: 'failed', key, workspaceId: scope.workspaceId, error, ms: 0 })
        return { outcome: 'cooling-down' }
      }
    },

    async readiness(scope: SandboxPrewarmScope): Promise<SandboxReadiness> {
      const key = prewarmKey(scope)
      // A running box outranks a recorded failure: the failure may be stale
      // (a later warm, or the lazy path, may have succeeded since).
      const peek = await peekWorkspaceSandbox(shell, {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
      })
      if (peek.status === 'running') return { status: 'ready', boxId: peek.box.id }

      if (inFlight.has(key)) return { status: 'warming' }
      if (claim?.isHeld) {
        try {
          if (await claim.isHeld(key)) return { status: 'warming' }
        } catch {
          // An unreadable claim store must not turn a status read into a 500.
        }
      }

      const failure = failures.get(key)
      if (failure && now() < failure.until) {
        return { status: 'failed', error: failure.error, retryAfterMs: failure.until - now() }
      }

      // A stopped box is not 'absent' to the platform, but to a user staring at
      // a dead terminal the distinction is meaningless: neither can serve them
      // until something warms it.
      return { status: 'absent' }
    },

    clearFailure(scope: SandboxPrewarmScope): void {
      failures.delete(prewarmKey(scope))
    },
  }
}
