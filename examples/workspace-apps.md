# Workspace apps built by an agent

A workspace app is a real HTTP application running in the agent's sandbox.
The agent can build and revise it in a dedicated conversation.
The product registers a stable app ID so people can reopen the app from the workspace rail.

For a coding agent without a product MCP credential, compose its profile with
workspaceAppBuilderInstructions({ manifestPath: 'workspace-apps.json' }).
The agent builds each runnable project under apps/<id>, with a package.json dev script.
Its HTTP server must bind 0.0.0.0 and use PORT when supplied.
The agent writes only { "apps": [{ "id": "...", "name": "...", "projectPath": "apps/<id>" }] } to that host-scoped session manifest.
The host reads and validates the manifest, launches each project through the Sandbox SDK, creates the preview link, and registers the app.
The manifest contains no URL, credential, sandbox ID, or arbitrary command.

A tool-capable host can instead use workspaceAppBuilderInstructions({ publishTool: 'apps.publish', listTool: 'apps.list' }).
The host owns the build conversation, agent profile, app store, route, and authorization.
It tells the agent the name of its publish tool and the required result.
The agent starts an HTTP server in its sandbox and calls that tool with an app ID, name, and listening port.
The host resolves the current session's sandbox from authenticated context.
It calls the Sandbox SDK's preview link API for that port, then writes the registration.
Do not accept a sandbox ID, preview URL, workspace ID, or route from tool arguments.

```ts
import {
  workspaceAppFromPreviewLink,
  refreshWorkspaceAppPreview,
  confirmWorkspaceAppReady,
} from '@tangle-network/agent-app/workspace-apps'

// Inside the host's authenticated publish tool:
const box = await resolveSessionSandbox(authenticatedSession)
const link = await box.previewLinks.create(args.port)
const previous = args.appId ? await appStore.getAuthorized(args.appId, viewer) : null
const app = workspaceAppFromPreviewLink({
  id: previous?.id ?? createAppId(),
  workspaceId: authenticatedSession.workspaceId,
  sandboxId: box.id,
  name: args.name,
  createdAt: previous?.createdAt,
}, link)
await appStore.upsert(app)

// SDK readiness proves delivery only. Probe the app's HTML before marking ready.
const deliveredLink = await box.previewLinks.waitUntilReady(app.previewId)
const deliveredApp = refreshWorkspaceAppPreview(app, deliveredLink)
const response = await fetch(deliveredApp.previewUrl, {
  method: 'GET',
  redirect: 'manual',
  credentials: 'omit',
  signal: AbortSignal.timeout(8000),
})
const bodyBytes = (await response.arrayBuffer()).byteLength
const readyApp = confirmWorkspaceAppReady(deliveredApp, {
  previewUrl: deliveredApp.previewUrl,
  status: response.status,
  contentType: response.headers.get('content-type') ?? '',
  bodyBytes,
  checkedAt: new Date().toISOString(),
})
// Compare the preview identity before writing, so an older probe cannot
// overwrite a newer publish of the same app ID.
await appStore.compareAndSwapPreview(app.id, app.previewId, readyApp)
```

The product must authorize any update to an existing ID.
A deliberate rebuild on a replacement sandbox may keep the app ID and creation time.
A normal status refresh must use the same sandbox, preview ID, and port.
The host stores ownership, source session, and visibility alongside the shared record.
Private access should be the default until the product grants broader workspace access.

The [rendered rail](../docs/assets/workspace-apps/rail-with-four-apps.png) shows four registered apps after a live update.

The page example uses `@tangle-network/sandbox-ui` 0.115.0 or later for `EmbeddedAppView`.
The workspace rail consumes authorized records in the order returned by the store.
The product builds a local route from each ID; the agent never supplies a navigation URL.

```tsx
import { AgentWorkspaceLayout } from '@tangle-network/agent-app/workspace-react'
import { EmbeddedAppView } from '@tangle-network/sandbox-ui/workbench'

<AgentWorkspaceLayout
  navItems={productNav}
  apps={{
    icon: AppWindowIcon,
    items: authorizedApps,
    hrefForApp: (id) => workspaceBase + '/apps/' + encodeURIComponent(id),
  }}
  activeRoute={activeRoute}
>
  {children}
</AgentWorkspaceLayout>

// In the product's authorized /apps/:id page:
<EmbeddedAppView
  app={{
    id: app.id,
    name: app.name,
    previewUrl: app.previewUrl,
    status: app.status,
  }}
  allowedOrigins={trustedPreviewOrigins}
  onRetry={refreshPreview}
/>
```

Revalidate the rail loader when an app is published or updated.
Refresh the selected app's preview link after a server restart and update its status.
The SDK's ready status only proves that the public route reached the sandbox.
Only a successful HTTP 200 HTML probe with a nonempty body marks the app ready.
The server must avoid redirects, credentials, and untrusted URLs during that probe.
Keep business records in the product's durable store.
Sandbox files and a rendered preview do not establish business facts or survive sandbox replacement by themselves.

## Durable app data across preview changes

A preview URL can change when a sandbox service restarts on a new port.
Browser `localStorage` belongs to that URL origin, so it cannot be the durable store for an app.
The product can bind an authorized app record and its exact iframe to a product-owned data adapter.
The shared bridge validates the iframe window, registered preview origin, and stable app ID before calling the adapter.

```ts
import { createWorkspaceAppDataHost } from '@tangle-network/agent-app/workspace-apps'

const host = createWorkspaceAppDataHost({
  app, // Authorized, ready WorkspaceAppRecord from the product store.
  frame, // The iframe rendering app.previewUrl exactly.
  read: (key) => productData.read(authorizedBusiness.id, app.id, key),
  write: (key, value, expectedRevision) =>
    productData.write(authorizedBusiness.id, app.id, key, value, expectedRevision),
  remove: (key, expectedRevision) =>
    productData.remove(authorizedBusiness.id, app.id, key, expectedRevision),
})
// Dispose when the iframe, preview URL, app, or viewer changes.
host.dispose()
```

The product must authenticate the owner and authorize the active app on every storage request.
It must scope each key to the owner business and stable app ID, enforce a per-app key quota, and compare revisions atomically.
A null expected revision creates a missing key; a numbered revision updates or removes only that version.
The adapter should throw `WorkspaceAppDataConflict` for a revision mismatch.
Never put a product credential in the iframe or expose a public storage route for it.
The bridge caps each UTF-8 value at 64 KiB, keys at 80 characters, and simultaneous requests at 16.

The app preview uses the client with the exact parent origin supplied by the product:

```ts
import { createWorkspaceAppDataClient } from '@tangle-network/agent-app/workspace-apps'

const data = createWorkspaceAppDataClient({
  appId: 'notes',
  parentOrigin: 'https://product.example',
})
const current = await data.read('notes')
const saved = await data.write('notes', JSON.stringify(nextNotes), current?.revision ?? null)
// Keep saved.revision for the next update. Dispose when the preview unloads.
data.dispose()
```

The client retries only its readiness handshake while the host mounts.
It sends each mutation once; after a timeout, read the key before retrying.
A changed preview origin gets a new iframe and client but keeps the same product data namespace.
