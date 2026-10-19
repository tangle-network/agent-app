# Cloud artifacts

A cloud artifact is a page, dashboard or small app an agent made, copied out of the box into object storage when it is produced.
It opens from a link while the box is asleep, and its owner can share it publicly and turn the link off again.
The module is `@tangle-network/agent-app/workspace-apps`; the browser parts are `/workspace-apps/react`.

## Pick the smallest kind

| Case | Kind | Where it runs |
| --- | --- | --- |
| HTML, CSS, JS and media with no server code: reports, dashboards, review pages | `static` | Files stream from the object store. No box, no isolate. |
| A page that needs server logic | `worker` | The bundle has `_worker.js` (`export default { fetch(request, env) }`) at its root. A request that matches no file runs it in a Worker Loader isolate with no network, CPU and subrequest limits, and only the bindings the product grants. |
| A declarative OpenUI view (`render_ui`) | `openui` | The product renders the JSON with its own OpenUI renderer. It has no script, so it may render on the product origin. |
| A dev server that must run on the box | `WorkspaceAppRecord` preview | The existing preview link, live only while the box is awake. |

Worker Loader needs the Workers Paid plan, a `worker_loaders` binding and, to grant RPC bindings through `ctx.exports`, the `enable_ctx_exports` compatibility flag.
Server code in a `worker` bundle is not secret: the JavaScript files of a bundle are also served as files.

## Security contract

- Agent HTML runs only on the artifact origin, a host on a different site from the product (GTM serves `gtm-artifacts.tangle.sh` for `gtm.tangle.tools`). A sibling subdomain of the product is same-site: its scripts could send same-site requests that carry the product's `SameSite=Lax` cookies.
- Every artifact response carries a CSP `sandbox` without `allow-same-origin`, `frame-ancestors` limited to the product, `Referrer-Policy: no-referrer` and `nosniff`. Frames use `CLOUD_ARTIFACT_FRAME_SANDBOX`. Never add `allow-same-origin`.
- A view URL is `/<artifactId>/<grant>/<token>/<path>`. The product mints it with `createCloudArtifactViewUrl` only after it authorized the viewer: `viewer` for members, a live share for the public. It expires after `CLOUD_ARTIFACT_VIEW_TTL_MS`.
- A public link is `createCloudArtifactShareToken(shareId, secret)`: the share id plus an HMAC, so the product stores only the id and can show the link again. The origin's `resolve` returns null once the share is revoked, so even an already-minted view URL stops on its next request.
- Creating or revoking a public link needs `CLOUD_ARTIFACT_SHARE_ROLE` (`editor`).

## Adopt it

1. Store records and shares in the product database. The origin needs only `CloudArtifactRecord`.
2. When the agent produces an HTML output, gather it with `collectCloudArtifactBundle` while its source is readable (the box at turn end, or the vault), then `prepareCloudArtifact` and `storeCloudArtifact`. Pass `carry` to keep files of the previous version that the new source no longer has.
3. Route the artifact host to `createCloudArtifactOrigin` before any product route, and serve nothing else on that host.
4. Render a member page and a public share page on the product origin. Each mints a view URL and renders `CloudArtifactFrame`; the member page shows `CloudArtifactSharePanel` to editors and owners.
5. Delete `cloudArtifactWorkspacePrefix(workspaceId)` from the object store when a workspace is erased.
