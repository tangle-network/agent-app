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
create a new identity with documented continuation guarantees; this PR implements
no transfer and never pretends native session state is portable.

## Executed verification

Focused source proof: 43 assertions and strict TypeScript passed. Three independent
mutations were caught: treating an unknown lock as absent, defaulting an unknown
choice and bypassing availability. The public regression tests cover the actual
exported resolver, retirement and removal from the recognized set.

Actions **38683763557**, artifact **11948919567**, regenerated the API/CODEMAP with
`pnpm docs:gen`, then passed maintained signoff at source
`411b25968b8b34aa48d851c7050a98e836761a75`.

Actions **38687307717**, artifact **11950709868**, subsequently passed maintained
signoff at source `2e2448e2d6caa28c747a61520075e0f52af57497`, including removal of the
temporary repair workflow:

- Typecheck, build, generated-project, dead-surface/knip and worker checks passed.
- Incident-class suite: **465 passed**, including browser-safe subpaths.
- Unit suite: **8,094 passed, 13 skipped**, twice with independently shuffled seeds
  **1113726259** and **2079756513**. These are two shuffled runs, not a claimed
  unshuffled run. The retained receipt contains exact commands and exit codes.
- The component catalog built and its deployment verification passed. This is
  catalog validation, not an application retirement HTTP/UI or native harness proof.

The initial failure was stale generated documentation, repaired by the maintained
generator without disabling checks. This evidence describes the exact source SHAs
above, not later documentation-only changes.

## Exact remaining work

- [x] Preserve saved identity/locks and refuse unknown or unavailable execution.
- [x] Support start/resume sets, draining and explicit empty sets.
- [x] Preserve known-different swap reporting and model compatibility.
- [x] Add public tests; run full maintained signoff and regenerate API/CODEMAP.
- [x] Remove the temporary documentation repair workflow.
- [ ] Thread real deployment availability through product admission and pickers;
      remove any caller-side pre-coercion of saved/explicit IDs.
- [ ] Replace the duplicated profile-support table with materializer-owned descriptors.
- [ ] Verify unavailable-session HTTP/UI/history behavior in a real reference product.
- [ ] Independent review, final-source validation, merge, publication, adoption and
      served behavior. No production harness is retired by this source change.

Continue agent-app **#1116**, SDK **#498** and container **#10961**, one PR per repo.
The container registry README tracks the remaining deployment-manifest, ACP backing,
profile ownership, runtime consolidation, physical-removal and native proof work.
SDK's `docs/harness-modularity.md` records its independent packed-consumer proof.
