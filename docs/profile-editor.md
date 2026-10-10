# Profile editor

`AgentProfileEditor` from `@tangle-network/agent-app/web-react` edits a canonical `AgentProfile`.
The product decides what the form offers through `config`, answers the editor's source checks through one
server route, and keeps save, revision, and authority decisions on its own server.

## Configure the form

```tsx
import { AgentProfileEditor } from '@tangle-network/agent-app/web-react'
import { createProfileEditorClient } from '@tangle-network/agent-app/profile-editor'

const checks = createProfileEditorClient({ endpoint: `/api/workspaces/${workspaceId}/profile-editor` })

<AgentProfileEditor
  value={draft}
  onChange={setDraft}
  onSaveStateChange={setSaveState}
  config={{
    sections: ['identity', 'prompts', 'model', 'skills', 'mcp', 'files', 'advanced'],
    identity: { nameEditable: false },
    models: { models: catalog, loading, error, onRetry, defaultLabel: 'Product default' },
    harnesses: ['opencode', 'codex'],
    github: { port: checks.github, storage: 'inline', connectHref: '/settings/integrations' },
    mcp: { port: checks.mcp },
    files: { accept: ['.md', '.txt', '.json'], maxFileBytes: 256 * 1024 },
  }}
  filePathPrefix="reference/"
  allowExecutableFiles={false}
  requireUniqueSkillNames
  publicHttpsMcpOnly
/>
```

| Part | What it controls |
| --- | --- |
| `sections` | Which sections render, in the editor's fixed order. Omit for every section the other props allow. |
| `identity.nameEditable` | `false` when the product fixes the profile name. |
| `models` | The catalog the chat composer uses, already filtered by the product's model policy. Without it, model fields are text inputs. |
| `harnesses` | Harnesses the product runs. Omit to hide the harness field. Choosing a harness keeps the default model runnable on it and says when it changed. |
| `thinkingLevels` | Levels for a harness and model. The default is the levels the harness applies (`reasoningEffortsFor`) plus Auto, which stores no override. |
| `github.storage` | `reference` stores `{ kind: 'github', repository, path, ref }` pinned to the checked commit. `inline` stores the checked file's text, for runtimes that do not fetch GitHub. |
| `mcp.port` | Health checks. Each enabled remote server is checked when the editor opens and when its address changes. |
| `mcp.lockReason` | Explains why servers are read-only for this person and locks toggles and edits. |
| `files` | Upload type, size, and count limits. Dropped and chosen files are read in the browser and stored inline. |

A disabled MCP server keeps its address in `metadata.enabledConfig`, because the canonical schema does not
allow a disabled entry to carry a URL or command. Turning the server back on restores it; a server with no
stored address asks for one first.

## Serve the checks

`@tangle-network/agent-app/profile-editor/server` answers the client's requests. Authenticate the user and
authorize the workspace first, then hand the path below the endpoint to the handler:

```ts
import {
  createGitHubRestReader, createGitHubSourceService, createMcpHealthChecker, handleProfileEditorRequest,
} from '@tangle-network/agent-app/profile-editor/server'

export async function profileEditorRoute(request: Request, path: string, workspace: Workspace) {
  await requireRole(workspace, 'admin')
  const reader = createGitHubRestReader({ token: await workspaceGitHubToken(workspace) })
  return handleProfileEditorRequest(request, path, {
    github: createGitHubSourceService(reader),
    mcp: createMcpHealthChecker(),
  })
}
```

A product whose GitHub credential lives elsewhere, such as a connection service, implements
`GitHubSourceReader` over it and throws `GitHubReadError` with GitHub's status. `githubPayload` parses
GitHub's JSON for transports that relay it. The service turns those failures into typed outcomes:
`not-connected`, `repository-not-found`, `no-access`, `ref-not-found`, `path-not-found`, `not-a-file`,
`not-a-skill`, `unsupported-file`, `rate-limited`, and `unavailable`, each with a message that names
the next step. A skill must carry `name` and `description` frontmatter; a skill folder resolves to its
`SKILL.md`.

`createMcpHealthChecker` initializes an MCP session over Streamable HTTP, or HTTP+SSE when the server
declares `transport: 'sse'`, lists its tools, and closes the session. It connects only to public HTTPS
addresses unless the product passes its own `urlProblem` policy. Public header values are sent; secret
references are not resolved, so a server that needs them reports `auth-required`. Local command servers
report `not-checkable`.

For a customer who wants an agent to use their own database without handing over its credential, point
them at [`customer-db-gateway`](../customer-db-gateway/README.md): they run it beside their database and add
it as a remote server whose `Authorization` header is a secret reference.

## Keep on the product server

The editor does not save. The product validates the final profile, decides which fields its runtime honors,
and runs its revision and consent policy. Show only the sections the product's server accepts and its
runtime applies.
