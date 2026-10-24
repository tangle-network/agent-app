# Prefer a recovered original before selecting a replacement

`createWorkspaceSandboxRecoveryManager().reconcileOriginal` belongs before any
recovery key selection or restore resolution. It reads the application's current
recovery, uses its ordinary authenticated Sandbox SDK client, and changes only
that recovery record through the store's compare-and-set operation. The store
must also provide atomic `insertIfAbsent`; reconciliation refuses legacy ports
without both operations. `record` uses CAS for an existing record and atomic
insert for absence, never an unconditional write after either operation fails. It does not
create, start, resume, ensure, snapshot, delete or cancel a sandbox.

The application supplies a server-owned `ownsOriginalBoxKey` predicate binding
this workspace to its historical box namespace. The historical key comes from
the exact original sandbox's SDK `name`; recomputing the current generation key
can select an unrelated replacement. Neither browser input nor a caller-supplied
boolean is evidence that the original recovered.

| Result | Caller obligation |
| --- | --- |
| `unchanged` | Continue existing policy. Manual decisions and already completed replacements are never switched. |
| `recovered` | Use the returned recovery with the shared key selector. The original's actual historical key wins; no older snapshot is restored into it. |
| `unverified` | Decline provisioning or using a replacement for this attempt. Missing evidence is not permission to choose stale saved work. |
| `conflict` | Decline this attempt and reload; another durable transition or a bound replacement won. Never overwrite it. |

A positive witness requires two stable ordinary SDK GETs of the exact stored
original ID around an authenticated snapshot-list GET. The original must be
`stopped` with the public `lifecycleState: suspended` and a valid `suspendedAt`.
The API defines suspended as final snapshot commit finished, and stamps
suspendedAt before the final capture. Missing stopped incarnation fields are
allowed; explicit transitioning or a changed incarnation is refused.

The newest snapshot must belong to this original, carry `pre-suspend`, report
remote synchronization `synced`, have been captured at or after this stop and
strictly after the previously recorded same-original snapshot, and satisfy the
existing shared snapshot freshness policy. A newer pending, unknown or malformed
record cannot be skipped to pick an older synced record. The snapshot envelope
uses the existing bounded JSON reader through the SDK's authenticated transport:
one response of at most 256 KiB and 256 records, with no continuation or partial
listing. It refuses oversized/truncated/ambiguous responses instead of inferring
absence. SDK GETs use the application's finite request timeout and cancellation
signal; the snapshot GET also has a finite per-request timeout.

The CAS records `original_recovered`, the original key and the exact positive
snapshot receipt. It retains the pending replacement key as invalidation evidence.
An earlier create may still be running or finish later; this transition never
asserts physical absence or deletes its outcome. A recorded replacement ID or a
concurrent completion cannot be silently replaced by the original.

Every provisioning attempt must capture its chosen key, complete through the
manager with that exact key, and **refuse to return/use its box when completion
returns undefined or conflicts** if it was a replacement attempt. Reconciliation
and key selection must use the application's existing admission boundary. A
successful old create is not authority to use a key invalidated in the recovery
record. All recovery recording must use this manager and the same atomic storage ports;
direct unconditional writes can resurrect the invalidated choice. The manager
refuses stale same-original missing-recovery records after original recovery,
and refuses replacing an already completed same-original replacement with a missing-recovery record. An existing-record CAS or
absent-state insert that loses a race throws instead of falling back to write.
This caller boundary is part of adoption, not proof granted by the pure selector.

`tests/sandbox-recovered-original.integration.test.ts` composes the actual Sandbox
SDK, a local authenticated HTTP peer and real SQLite CAS. Its source baseline
control uses the old action-only selector; the two before/after recovery cases
must fail by selecting the replacement key. Local boundary proof is not evidence
of live recovery, actual selected production snapshot or data loss.
