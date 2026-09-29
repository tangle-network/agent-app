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
