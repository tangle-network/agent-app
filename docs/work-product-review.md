# Version-bound work-product review

A review applies to the document revision the reviewer actually saw. Work products may reuse their record ID after `changes_requested` and `reopen`; the version is therefore part of the review identity.

Use the existing review route with the `id` and `version` returned by the detail endpoint:

```ts
await fetch(reviewEndpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: displayedRecord.id,
    version: displayedRecord.version,
    verdict: 'approve',
  }),
})
```

Reviewer identity and workspace authority still come from the product's authenticated `authorize` seam. The browser's version is a compare condition, not permission. A malformed version returns 400; a changed revision or non-ready record returns 409 `VERDICT_CONFLICT`. Refresh the document and ask the reviewer to decide again. Do not silently retry the old decision against a new version.

`service.applyVerdict(id, { expectedVersion, verdict, reviewedBy, note? })` provides the same condition to non-HTTP callers. The service snapshots the scalar verdict fields before awaiting storage. Its update guards and history entry use the same original record snapshot. Submission and exception transitions also reuse their original snapshot rather than reloading a newer record to authorize an older patch.

## Compatibility and ownership

`version` / `expectedVersion` are additive. Legacy callers that omit them retain their current-record behavior, but the HTTP route still binds its workspace-checked snapshot through the service call. That protects in-flight changes; it cannot establish which revision an old client displayed before making its request. Review UIs should send the version, and independently measured human acceptance must not infer a displayed revision from an unversioned legacy request.

Store implementations keep the existing `{status, version}` compare-and-swap contract. No new database columns, review tokens, approval broker or lock service are required. The existing single-writer discipline for accumulating a draft still applies; this change does not serialize arbitrary simultaneous edits within an unchanged status/version. Prior-approved supersession and audit append remain the existing store operations, not a newly claimed multi-record transaction.

Product hooks run only after a successful transition. A version conflict runs neither verdict nor export hooks. This does not make an external email, export or outcome webhook transactionally durable with the approval: use the product's existing durable history/delivery mechanisms when connecting those effects. Reviewer acceptance, provider delivery and business success remain different observations.

## Executable proof

On the repository's configured Node runtime with `node:sqlite` support and installed dependencies:

```sh
pnpm build
node scripts/prove-work-product-review.mjs
```

The proof creates a temporary SQLite database, opens two connections and serves the actual review routes over loopback HTTP. Another service instance performs actual request-changes/reopen/resubmit transitions while selected reads are paused. It checks stale browser versions, in-flight review and submission races, route-to-service fencing, malformed versions, competing reviewers, and normal approval/supersession behavior. Temporary resources are removed in `finally`.

Copy that script into the audited baseline checkout and run without flags: its protected behavior must fail. `--baseline` is only a diagnostic reproduction of the known old outcomes; its success is never release evidence.

Documents, reviewer identity and the SQLite persistence port are fixtures. No model or provider is called. This proves the exercised protocol and state transitions, not a deployed consumer's authentication, semantic document quality, transactionally delivered business effects, or routing improvements. Run the existing work-product tests and repository signoff on the exact committed head before merge, then qualify each consumer with the published package and its real UI.
