# Harness retirement and deployment admission

A recognized harness ID is not a promise that a deployment can execute it.
Keep identities in saved sessions, profiles, receipts and historical traces. Do not
remove an identity from a shared schema just to stop launching its executable.

## Session selection

`resolveSessionHarness` preserves a non-null saved lock. Unknown identities and
invalid explicit requests throw `HarnessSelectionError` instead of selecting a
different harness. Null and undefined mean absent; an empty string is invalid.
`coerceHarness` remains a display/config convenience, not an admission function.

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

## Verification recorded for this implementation

The import-free session-selection implementation was executed under Node 22.16.0
with type stripping: 43 assertions passed. TypeScript strict checking of that
module passed. Three mutations were separately detected (each exited 1): treating
an unknown saved lock as absent, replacing unknown choices with the default, and
bypassing availability. After restoration, all 43 assertions passed again.

The public resolver delegates to that implementation. `retirement.test.ts` covers
the public export and the removal counterfactual; the existing public tests no
longer expect an explicit unknown request to fall back. Full repository Vitest,
build, generated API docs, dependency installation and deployed consumer validation
were not executed in this environment. The repository cannot be cloned here because
outbound GitHub DNS resolution fails; connector source reads/writes work.

## Completion checklist for this PR

- [x] Preserve locks when the saved identity is unknown or unavailable.
- [x] Refuse invalid explicit requests and defaults without silent substitution.
- [x] Support distinct start/resume sets, draining and explicit empty sets.
- [x] Preserve existing known-different swap reporting and model compatibility.
- [x] Add public regression tests and execute focused source mutation checks.
- [ ] Run repository install, full relevant Vitest suites, build and browser-safe checks.
- [ ] Regenerate API docs/CODEMAP using the maintained generator.
- [ ] Thread real deployment availability through product callers and their pickers.
- [ ] Replace profile-support facts duplicated here with materializer-owned descriptors.
- [ ] Verify unavailable-session HTTP/UI behavior in a real reference product.
- [ ] Complete independent review, merge, package publication and consumer adoption.

## Cross-repository roadmap

1. `agent-sdk`: keep historical identity independent of current executable support;
   remove duplicated schema/type lists without changing their accepted vocabulary.
2. `agent-container`: make backend membership a positive local declaration rather
   than the complement of every upstream known ID; scope adapter wiring to selected
   descriptors; move vendor-specific profile, auth, session and packaging facts to
   their owned integrations. Preserve secret, isolation and persistence checks.
3. `agent-runtime`: keep runtime accounting/lifecycle generic; separate read-only
   native codecs from executable adapters, and consolidate local invocation rules
   with the harness owner rather than adding another runner framework.
4. `agent-app`: use the actual catalog for admission and pickers; preserve readable
   history and explicit unavailable states.
5. Braid/products: adopt shared contracts; do not add a second taxonomy or vendor
   configuration layer. Change Braid only where an actual consumer mismatch exists.
6. Prove builds with each executable adapter absent, dependency rejection (including
   ACP backing agents), native cancellation/resume, historical decoding, package
   compatibility, and the deployed result. No existing harness is retired by this
   initiative without an explicit deployment selection.
