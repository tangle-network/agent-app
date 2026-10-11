# Workspace export

`@tangle-network/agent-app/workspace-export` gives a workspace owner one button that downloads all of the workspace's data as a zip.
The product declares where the data lives; the module runs the export, keeps credentials out, and serves the archive.

## What the owner gets

```
manifest.json            schema, counts per source, every file with size and SHA-256, the redaction policy, table coverage
README.txt               how to read and verify the archive
data/<source>.ndjson     one JSON object per line, one file per table or record type
data/<source>.json       single documents, such as connection metadata
files/<source>/...       uploaded and generated files at their original paths
sandbox/<source>.tar.gz  the agent's workspace filesystem
```

## Wiring it into a product

1. Declare the sources for one workspace in `plan`.
   - `d1WorkspaceTables` discovers every table with a workspace column. Tables keyed through a parent take a `scoped` WHERE clause; tables left out on purpose go in `exclude` with a reason. Every other table appears in the coverage report as `unscoped`, so new migrations cannot silently drop out of the export.
   - `r2Files` and `kvFiles` export object and KV prefixes. A prefix must end at a workspace boundary (`ws-1/`).
   - An `archive` source returns the sandbox workspace as a `.tar.gz` stream from the Sandbox SDK (`box.fs.openArchive(dir)`), or `null` when the workspace has no box.
   - A `json` source returns one document, such as Hub connection metadata.
   - Decrypt product-encrypted columns in `transform` (or in a custom `rows()`); the owner receives plaintext of their own data.
2. Mount `createWorkspaceExport(...).route` under one path, such as `/api/workspaces/:id/exports/*`, and pass the remainder as `path`.
3. Implement `authorize` from the authenticated session. Return `{ userId, role }`; only `role === 'owner'` is accepted.
4. Render `WorkspaceExportPanel` from `workspace-export/react` on the owner's settings page.

The archive storage needs an R2 bucket (`createR2ExportStorage`) and an HMAC secret for download links.
Pass the product's own keys as `knownSecrets` so they are masked even when they have no recognizable prefix.

## How it runs

Each source is a unit. A files source that has more than 200 files, or that runs past the request budget, continues in the next request from a saved cursor, so no request exceeds the Workers subrequest limit. `POST {mount}` creates the job; the panel calls `POST {mount}/:id/advance`, which runs pending units for about 20 seconds per call.
A unit that starts always finishes, and the job record is updated with a compare-and-swap lease, so two tabs cannot run the same unit.
A closed tab pauses the export; reopening the panel resumes it.
A unit that fails three times fails the export, and the owner starts a new one.

Every entry streams through the credential masks, records CRC-32, SHA-256 and sizes, and is stored as segments of at most 8 MiB.
The download route stitches the segments into one zip with an exact `Content-Length`; nothing is buffered beyond one segment.
A sandbox archive is decompressed, checked and recompressed inside one request, which cost 32.5 s of CPU for a 224 MB box in production. Set `[limits] cpu_ms = 300000` in the app's `wrangler.toml` so large workspaces fit. A request that dies inside a unit still counts as an attempt, so an export fails visibly rather than stalling.

Exports hold decrypted data, so they are deleted after 24 hours (`retentionMs`); the owner can delete one sooner, or export again.

## Secrets

Credentials never enter an archive:
- column and JSON-key names that hold credentials (`password`, `*_token`, `*api_key`, `*_ciphertext`, `encrypted_*`, `*bearer*`) become `"[redacted]"`, including keys nested inside JSON columns;
- credential-shaped values (provider key prefixes, JWTs, private keys) and the product's `knownSecrets` are masked in rows, files and sandbox files;
- known credential files inside the sandbox tar (`.git-credentials`, `.netrc`, `.npmrc`, `.codex/auth.json`, `.ssh/id_*`, ...) are overwritten with `*`;
- connections are exported as metadata only.

Error messages stored on a job pass through the same mask, and the routes never log source data.

## Authorization

- Every route except download requires the owner. No principal returns 403; an authorizer that throws returns 503.
- Writes require a same-origin request (`Origin` and `Sec-Fetch-Site`).
- The download link is an HMAC-signed URL bound to one workspace and one export, valid for 15 minutes. The progress endpoint issues a fresh link each time the owner asks.
