---
"@tangle-network/agent-app": minor
---

Add cloud artifacts to `/workspace-apps`: agent pages, dashboards and small apps snapshotted into object storage so they open while the box is asleep. `collectCloudArtifactBundle`, `prepareCloudArtifact` and `storeCloudArtifact` gather an HTML output and its local files into a content-addressed version (`static`, `worker` when `_worker.js` is present, or `openui`). `createCloudArtifactOrigin` serves them on a separate origin with a CSP sandbox and runs `_worker.js` in a Worker Loader isolate with no network and only the bindings the product grants. `createCloudArtifactViewUrl` mints short-lived view links and `createCloudArtifactShareToken` revocable public links. `/workspace-apps/react` adds `CloudArtifactFrame` and `CloudArtifactSharePanel`.
