# Signed shared Line dispatch

The host verifies the binding-scoped bearer before parsing a shared Line callback.
It returns an opaque `callbackCredentialId` that identifies the verified credential.
It reads the current Hub member `updatedAt` as `memberRevision`, separately from its own `grantRevision`.

The enrolled Line bridge compares the signed subject and member revision with the fresh member record.
It repeats that lookup after resolving the native enrollment target.
Before calling `admit`, it checks that the signed dispatch deadline has not expired or exceeded 60 seconds from the current time.
The deadline and member revision use canonical UTC strings with millisecond precision.

The host must repeat the following checks at its atomic durable task write:

- The credential identity still matches the current binding-scoped callback credential.
- The Hub member revision and the host grant revision still match the pinned values.
- The signed dispatch fence is the current live attempt, and its deadline has not expired.
- `(binding, messageId)` identifies at most one durable task.

A fresh fence may retry the same accepted task.
It must not create a second task for that message.
An `acceptedExecutionId` observation may omit the dispatch lease and read the existing task.
The bridge will not call `admit` for that observation.

## Local boundary proof

Synthetic callbacks against the prior source returned HTTP 200 for a stale signed member revision, an expired dispatch deadline, and a deadline expiring during an awaited read.
The corrected source returns HTTP 403 without admission in all three cases.
`pnpm exec vitest run src/agent-enrollment/application.test.ts` passed 12/12 focused tests, and `pnpm typecheck` passed.
The test isolates the unreleased Sandbox parser by preserving its proposed signed fields in a test double.
Activation requires the published parser and separate host tests of the atomic write and retry contract.
