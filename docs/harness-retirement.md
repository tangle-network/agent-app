# Harness retirement and deployment admission

A recognized harness ID is not a promise that a deployment can execute it. Keep
identities in saved sessions, profiles, receipts and traces. Retire execution through
deployment admission, not by deleting history from shared schemas.

## Session selection

`resolveSessionHarness` preserves a non-null saved lock. Unknown identities,
malformed explicit requests and unavailable selections throw `HarnessSelectionError`
instead of selecting a different harness. Only null and undefined mean absent.
`coerceHarness` is a display/config convenience: never apply it to a saved or explicit
requested identity before admission.

Derive availability on the authenticated server, not from a request body:

```ts
const resolved = resolveSessionHarness({
  sessionHarness: savedSession.harness,
  requested: request.harness,
  workspaceDefault,
  availability: {
    newSessions: ['codex'],
    existingSessions: ['codex', 'pi'],
  },
})
```

Codex is enabled, Pi is draining, and other known harnesses are unavailable. Omitted
`existingSessions` inherits `newSessions`; an empty set denies all operations of that
kind. Omitted `availability` deliberately retains the previous known-ID admission
behavior for compatibility. Products must supply the real sets to restrict execution.

A known different request returns `swapAttempted: true` while retaining the saved
lock; the caller must reject that attempt before execution. An unavailable default
is an error, not permission to choose another runner. Model compatibility remains a
separate required check.

Show a retired session's history and unavailable state. Explicit transfer would
create a new identity with documented continuation guarantees; no transfer is
implemented, and native session state is never presented as portable.
