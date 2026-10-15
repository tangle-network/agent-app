# Harness retirement and deployment admission

A recognized harness ID is not a promise that a deployment can execute it.
Keep identities in saved sessions, profiles, receipts and historical traces. Do not
remove an identity from a shared schema just to stop launching its executable.

## Session selection

`resolveSessionHarness` preserves a non-null saved lock. Unknown identities and
invalid explicit requests throw `HarnessSelectionError` instead of selecting a
different harness. Null and undefined mean absent; an empty string is invalid.
`coerceHarness` remains a display/config convenience, not an admission function.
Do not coerce a saved or explicitly requested ID before passing it to the resolver.

A product derives availability from its authenticated deployment catalog:

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

Here Codex is enabled, Pi is draining, and other known harnesses are retired or
unavailable. Omitted `existingSessions` inherits `newSessions`; an empty set denies
all operations of that kind. Omitted `availability` preserves the previous known-ID
admission behavior for compatibility, so products must supply it to enforce a
restricted deployment. Never accept either set from the request body.

A known different requested harness still returns `swapAttempted: true` while
preserving the saved lock. The caller must reject that attempt before execution.
An unavailable default is an error, not permission to choose another installed
runner. Model compatibility checks remain a separate required boundary.

For a retired session, show its history and the unavailable state. An explicit
transfer creates a new session with its own identity and documented continuation
guarantees; this PR does not implement transfer or pretend native state is portable.

## Executed verification

The import-free session-selection implementation passed 43 assertions under Node
22.16.0 and strict TypeScript checking. Three mutations were independently detected:
treating an unknown saved lock as absent, substituting the default for an unknown
choice, and bypassing availability. Restored source passed all 43 assertions again.

The public resolver delegates to that implementation. `retirement.test.ts` covers
the public export and physical removal from the recognized set; the existing tests
no longer expect an explicit unknown request to fall back.

GitHub Actions run **38683763557**, artifact **11948919567**, regenerated the public
API documents with `pnpm docs:gen` and ran the maintained signoff against commit
`411b25968b8b34aa48d851c7050a98e836761a75`. The retained receipt records:

- Typecheck, build, generated-project checks and dead-surface/knip checks passed.
- The incident-class suite passed all 465 tests, including browser-safe subpaths.
- The full test suite passed **8,094 tests**, with 13 skipped, in both its normal
  and shuffled order.
- The maintained preflight gate exited zero.

The earlier signoff failed only because generated API docs were stale; the maintained
generator repaired them. No tests or gates were disabled. The temporary documentation
repair workflow was subsequently removed. These are source/package checks, not
proof of deployed availability, native execution or a real-product browser flow.

## Completion checklist for this PR

- [x] Preserve locks when the saved identity is unknown or unavailable.
- [x] Refuse invalid explicit requests and defaults without silent substitution.
- [x] Support distinct start/resume sets, draining and explicit empty sets.
- [x] Preserve existing known-different swap reporting and model compatibility.
- [x] Add public regression tests and execute focused source mutation checks.
- [x] Run repository install, full Vitest suites, build and browser-safe checks.
- [x] Regenerate API docs/CODEMAP using the maintained generator.
- [x] Remove the temporary documentation repair workflow.
- [ ] Thread real deployment availability through product callers and their pickers;
      check that callers do not pre-coerce saved identities or explicit requests.
- [ ] Replace profile-support facts duplicated here with materializer-owned descriptors.
- [ ] Verify unavailable-session HTTP/UI behavior in a real reference product.
- [ ] Complete independent review, merge, package publication and consumer adoption.

## Cross-repository roadmap

1. `agent-sdk` (#498): preserve historical identity independently of executable
   support; derive the type from its schema; accept additive capability catalogs
   without granting unfamiliar execution. Full package/consumer proof is recorded
   in that PR's `docs/harness-modularity.md`.
2. `agent-container` (#10961): declare backend vocabulary positively; scope adapter
   wiring to selected descriptors; move vendor-specific profile, auth, session and
   packaging facts into their integrations. Preserve secret, isolation and persistence
   checks. Registry omission is not physical package/image removal.
3. `agent-runtime`: keep accounting/lifecycle generic; separate read-only native
   codecs from executable adapters and consolidate local invocation rules with the
   harness owner rather than adding another runner framework.
4. `agent-app`: use the actual deployment catalog for admission and pickers; preserve
   readable history and explicit unavailable states.
5. Braid/products: adopt shared contracts, not a second taxonomy or vendor
   configuration layer. Change Braid only where a real consumer mismatch exists.
6. Prove builds with each executable adapter absent, dependency rejection (including
   ACP backing agents), native cancellation/resume, historical decoding, package
   compatibility, and the deployed result. This initiative does not retire an
   existing production harness merely because its implementation was refactored.
