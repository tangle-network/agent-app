# Warming a box when the user opens a project

A user opens a project, does nothing for ten minutes, clicks **Terminal** — and
gets a spinner over a box that does not exist. That is not a slow cold start.
Cold starts are fast: **2.34–3.19 s** from nothing to terminal-ready
(staging-sandbox, n=5, 2026-07-28). It is a product that never provisions at
all, because the only provisioning path is lazy and its guard never passes.

`createSandboxPrewarmer` (`@tangle-network/agent-app/sandbox`) is the shell
answer, so tax, gtm, legal, creative and workcomp stop each writing their own.

## The shape

```ts
import { createSandboxPrewarmer } from '@tangle-network/agent-app/sandbox'

const prewarmer = createSandboxPrewarmer(shell, {
  claim: d1Claim(env.DB),        // cross-isolate single-flight — see below
  mode: 'resume-only',           // DEFAULT; 'create-or-resume' also builds new boxes
  onEvent: (e) => console.log('[prewarm]', e.type, e),
})
```

Two calls, both non-blocking:

```ts
// The project-open route. Never await the provisioning itself.
export async function loader({ context }) {
  const decision = await prewarmer.prewarm({ workspaceId: userId, harness: 'opencode' })
  if (decision.completion) context.cloudflare.ctx.waitUntil(decision.completion)
  return json({ project })
}

// The status route the terminal/composer polls.
export async function readiness() {
  return Response.json(await prewarmer.readiness({ workspaceId: userId, harness: 'opencode' }))
}
```

`readiness()` returns `{status:'ready',boxId}`, `{status:'warming'}`,
`{status:'absent'}` or `{status:'failed',error,retryAfterMs}` — the same
`ready`/`warming` words `createSandboxFileIndexRoute` and `useFileMentions`
already speak, so the UI keeps ONE warming state instead of a second spinner.
**`absent` and `failed` must not render as a spinner.** That conflation is the
original bug: a dead panel that claims to be provisioning.

## The claim store is the whole correctness argument

The platform does **not** dedupe by box name. Two concurrent
`POST /v1/sandboxes` with an identical name both returned HTTP 201 and left two
running boxes (measured, staging-sandbox, 2026-07-28). Two tabs racing a warm
leak a paid box, so `claim` has no default — supply a store, or write
`claim: 'single-isolate-only'` and own the fact that you only get per-isolate
dedupe. On Workers, "same isolate" guarantees nothing.

`acquire` must be **atomic**. A read-then-write is the exact race this closes:

```ts
function d1Claim(db: D1Database): PrewarmClaimStore {
  return {
    async acquire(key, ttlSeconds) {
      const now = Math.floor(Date.now() / 1000)
      // One statement. The conditional upsert IS the lock: it succeeds only
      // when no live claim exists, so exactly one isolate can come back with
      // a changed row.
      const res = await db
        .prepare(
          `INSERT INTO sandbox_prewarm_claims (key, expires_at) VALUES (?1, ?2)
           ON CONFLICT(key) DO UPDATE SET expires_at = ?2
           WHERE sandbox_prewarm_claims.expires_at < ?3`,
        )
        .bind(key, now + ttlSeconds, now)
        .run()
      return (res.meta.changes ?? 0) > 0
    },
    async release(key) {
      await db.prepare('DELETE FROM sandbox_prewarm_claims WHERE key = ?1').bind(key).run()
    },
    async isHeld(key) {
      const row = await db
        .prepare('SELECT 1 FROM sandbox_prewarm_claims WHERE key = ?1 AND expires_at >= ?2')
        .bind(key, Math.floor(Date.now() / 1000))
        .first()
      return row != null
    },
  }
}
```

```sql
CREATE TABLE IF NOT EXISTS sandbox_prewarm_claims (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
```

The TTL is not decoration: it is what releases a claim held by an isolate that
died mid-warm. Without it one crash wedges a workspace forever. `isHeld` is
optional and only affects reporting — without it, a warm running in another
isolate reads as `absent` rather than `warming`.

## Cost — decide this deliberately

A warmed box bills from creation until the platform's idle timeout reclaims it
(`SandboxRuntimeConfig`'s create-time `idleTimeoutSeconds`). Against a 3600 s
timeout and a ~131 s mean session life, warming for a user who bounces costs an
hour of box time to save ~1.4 s. **Usually the wrong trade**, which is why:

| Lever | Default | Spend |
|---|---|---|
| `mode: 'resume-only'` | yes | only revives boxes the user already caused |
| `mode: 'create-or-resume'` | opt-in | warms from nothing — pair with a lower `idleTimeoutSeconds` |
| `shouldPrewarm(scope)` | none | your gate: paid tier, returning user, has-documents |
| `failureCooldownMs` | 60 000 | stops a failing workspace retry-storming (each retry is a create) |

Warm with the **same harness** the next turn will use.
`ensureWorkspaceSandbox` deletes and recreates a name-matched box whose harness
differs, so warming `opencode` then turning `claude-code` pays for two boxes and
is slower than not warming.

## Failure

A failed warm degrades to exactly the lazy path — the next real request
provisions as it does today. `completion` **resolves** `{ok:false}` rather than
rejecting, because an unhandled rejection handed to `waitUntil` can fail the
request it rode in on. It is never silent: `onEvent({type:'failed'})` fires and
`readiness()` reports `failed` with a `retryAfterMs`, so the UI can say so
instead of spinning.

## Prewarm on page open: the route and the hook

Every product warms the same way: the browser asks when a member opens a
workspace page, and the server decides what to warm.

```ts
// Server. `authorize` is the only product code: authenticate the member the
// way your other routes do, and return the warm for the box they would use.
import { createWorkspacePrewarmRoute } from '@tangle-network/agent-app/sandbox'

// Create it once per isolate: single-flight and the success memory live in it.
const prewarm = createWorkspacePrewarmRoute<AppContext>({
  authorize: async ({ request, context: c }) => {
    if (!sameOrigin(request)) return { status: 'denied', response: Response.json({ error: 'Origin mismatch' }, { status: 403 }) }
    const member = await requireMember(c.env, request)
    if (!member) return { status: 'denied', response: Response.json({ error: 'Authentication required' }, { status: 401 }) }
    return {
      status: 'allowed',
      key: member.workspaceId,
      warm: async () => {
        const decision = await prewarmer.prewarm({ workspaceId: member.workspaceId, harness: 'opencode' })
        await decision.completion
        return { outcome: decision.outcome }
      },
    }
  },
  onEvent: (event) => console.log('[prewarm]', event),
})
app.post('/api/workspaces/:id/prewarm', (c) => prewarm(c.req.raw, c))
```

```tsx
// Browser. Fires on open from a visible tab, at most once a minute per
// workspace, and again when focus enters the composer.
import { ChatComposer, useWorkspacePrewarm } from '@tangle-network/agent-app/web-react'

const prewarm = useWorkspacePrewarm({ url: `/api/workspaces/${id}/prewarm`, enabled: signedIn })
<ChatComposer onFocusWithin={prewarm.reassert} … />
```

The route awaits the warm inside the request rather than handing it to
`waitUntil`: a suspended box can take longer to resume than the 30 s Cloudflare
grants after a response. It collapses concurrent requests for one `key` in an
isolate, answers `recent` for 30 s after a success, refuses crawler and
prefetch requests before authorizing, and answers a failed warm with
`{ outcome: 'failed' }` and no error text. Across isolates the warm itself must
be idempotent, so resume an existing box or use a claim store for creation.

What the warm does is product policy. Resume the box the next turn will use,
and prepare only what that turn would prepare under the same authority checks.
The in-box OpenCode server prewarm is a separate Sandbox platform switch
(`SANDBOX_OPENCODE_PREWARM_ENABLED` with the warm-server cohort); a product
route does not duplicate it.
