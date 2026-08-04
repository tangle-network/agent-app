# Interactive agent-authored UI

An agent can already emit a page.
Until now nobody could touch it.

Two independent reasons, both fixed by different repos:

1. **The node vocabulary is display-only.**
   `heading, text, badge, stat, key_value, code, markdown, table, actions, separator, stack, grid, card` — no input, number, slider, checkbox, or form.
2. **The renderer's `onAction` handler was never passed.**
   `OpenUIArtifactRendererProps.onAction` has always existed; gtm-agent renders `<OpenUIArtifactRenderer schema={nodes} />` (`src/components/chat-message-body.tsx:143,145`) and insurance-agent renders `<OpenUIArtifactRenderer schema={panel.schema} />` (`src/routes/app.workspace._index.tsx:324`).
   Neither passes it, so the `actions` and `card` buttons that already render do nothing when clicked.

Reason 2 needs no renderer change at all — only a host handler.
That is what `@tangle-network/agent-app/openui-react` supplies.
Reason 1 needs new node types, which belong to the renderer's package.

## Where the code lives

| Thing | Repo | Path |
| --- | --- | --- |
| Node union + renderer | `tangle-network/brand` | `packages/ui/src/openui/openui-artifact-renderer.tsx`, published as `@tangle-network/ui@11.x` subpath `./openui` |
| Verbatim re-export | `tangle-network/sandbox-ui` | `src/openui/index.ts` → `@tangle-network/sandbox-ui/openui` |
| Host contract | `tangle-network/agent-app` | `src/openui/` → `@tangle-network/agent-app/openui` |
| The `onAction` handler | `tangle-network/agent-app` | `src/openui-react/` → `@tangle-network/agent-app/openui-react` |

The node union has ONE owner and it is not this package.
`@tangle-network/agent-app/openui` declares only the narrowest structural port it needs — a node is `{ type: string }`, a form field is `{ id, kind, min?, max?, … }` — so a renderer node satisfies it by assignment and neither package imports the other.

## The seam that costs no model turn

This is the whole point.
A user adjusting a number on a page the agent wrote must cost the same as adjusting a number on a hand-built screen: one product request, no tokens, no sandbox wake-up.

The mechanism is that the action path never touches the turn path:

```
button press
  → useOpenUIActions.onAction          (openui-react)
  → POST /api/openui/action            (the product's own REST route)
  → createOpenUIActionRoute.handle     (openui)
  → the product's plain handler function
  → JSON reply: message / values / a replacement page
```

Compare `@tangle-network/agent-app/interactions`, which looks superficially similar and is the opposite thing.
An interaction answer exists to UNBLOCK a running turn: its route resolves a sidecar connection and re-lists to prove the run resumed.
`createOpenUIActionRoute` has no sidecar, no session id, no connection seam — a product supplies an authorizer and a map of functions, and there is no argument through which a model call could be made.

`tests/openui/no-turn-cost.test.ts` enforces this rather than asserting it in prose:

- nothing reachable from `./openui` or `./openui-react` may import the runtime, the sandbox SDK, `/turn-stream`, `/chat-routes`, `/missions`, `/interactions`, or the chat stream;
- a full successful action calls exactly `resolve` → handler → `recordForAgent`, and global `fetch` is never touched.

Break either property and the test goes red (verified by injecting an `import '../turn-stream/index'` into `src/openui/route.ts`: 2 failures).

### How the agent finds out

It does not, at click time — that would be the turn we just avoided.
A successful action hands the route's `recordForAgent` seam one plain line from `describeOpenUIAction`:

```
User pressed "recalculate" on form "contrib" with amount=6500, catchup=true.
```

The product persists that against the thread.
The agent reads it on the NEXT turn the user chooses to spend.

## What lands in agent-app (built)

`@tangle-network/agent-app/openui` — framework-free, browser-safe:

- `parseOpenUISegments(content)` — split an assistant message into markdown and ```` ```openui ```` pages. This is the scanner gtm-agent and insurance-agent each forked. A fence that is not JSON, or that carries no node, renders as a JSON code block instead of a blank card.
- `parseOpenUIArtifact(content)` — read a persisted `render_ui` artifact. Two shapes exist in the wild and a path cannot tell them apart: the bare node tree `preset-cloudflare` writes (`JSON.stringify(args.schema)`) and the `{ title, schema }` envelope insurance-agent's loader expects. This reads both and returns a typed failure for anything else.
- `validateOpenUIFormValues(spec, values)` — check a submission against the form the agent authored: required, type, min/max, step, options, maxLength. An undeclared field is an error, not a silently dropped extra.
- `validateOpenUIActionBody(body)` / `describeOpenUIAction(submission)` — the wire body and the agent-facing note.
- `createOpenUIActionRoute(options)` — the endpoint. An action id with no registered handler is a 404, never a button that does nothing.
- `OPENUI_INTERACTIVE_AUTHORING_GUIDE` — the vocabulary text that makes a model emit forms, appended to `render_ui`'s description by `buildAppToolOpenAITools(taxonomy, { interactiveUi: true })`. Off by default: with no renderer support the agent would author forms the page drops.

`@tangle-network/agent-app/openui-react`:

- `useOpenUIActions(options)` — holds field values, posts a pressed action to one REST endpoint, and returns `{ onAction, values, setValue, pendingActionId, error, message, schema, data }`. `onAction` is assignable to the renderer's existing prop today, so the shipped `actions`/`card` buttons become live with no renderer change.

## What must land in the ui package

`tangle-network/brand`, `packages/ui/src/openui/openui-artifact-renderer.tsx`.
All of it is additive: new union members, one optional second callback argument, two new optional props.

```ts
// 1. New node types, added to the exported union.
export interface OpenUIInputNode extends OpenUIBaseNode {
  type: "input"
  id: string
  label: string
  placeholder?: string
  value?: string
  required?: boolean
  maxLength?: number
}
export interface OpenUINumberNode extends OpenUIBaseNode {
  type: "number" | "currency" | "slider"
  id: string
  label: string
  value?: number
  min?: number
  max?: number
  step?: number
  required?: boolean
  /** `currency` only, e.g. "USD". */
  currency?: string
}
export interface OpenUISelectNode extends OpenUIBaseNode {
  type: "select"
  id: string
  label: string
  options: Array<{ value: string; label: string }>
  value?: string | string[]
  multiple?: boolean
  required?: boolean
}
export interface OpenUICheckboxNode extends OpenUIBaseNode {
  type: "checkbox"
  id: string
  label: string
  value?: boolean
  required?: boolean
}
export interface OpenUIFormNode extends OpenUIBaseNode {
  type: "form"
  id: string
  fields: Array<OpenUIInputNode | OpenUINumberNode | OpenUISelectNode | OpenUICheckboxNode>
  submit: OpenUIAction
  description?: string
}

export type OpenUIComponentNode =
  | /* …the existing thirteen… */
  | OpenUIInputNode
  | OpenUINumberNode
  | OpenUISelectNode
  | OpenUICheckboxNode
  | OpenUIFormNode

// 2. `NODE_TYPES` gains "input", "number", "currency", "select", "checkbox",
//    "slider", "form" — a type missing from that set is dropped silently today.

// 3. The action callback gains an optional second argument, and the renderer
//    gains optional value props. Existing one-argument handlers keep compiling.
export interface OpenUIActionContext {
  formId?: string
  nodeId?: string
  values: Record<string, string | number | boolean | string[]>
}
export interface OpenUIArtifactRendererProps {
  schema: OpenUIComponentNode | OpenUIComponentNode[]
  onAction?: (action: OpenUIAction, context?: OpenUIActionContext) => void
  /** Controlled values; uncontrolled when omitted (seeded from each field's `value`). */
  values?: Record<string, string | number | boolean | string[]>
  onValuesChange?: (values: Record<string, string | number | boolean | string[]>) => void
  className?: string
}
```

Renderer behaviour to add:

- a `form` node renders its fields, holds their values (uncontrolled from each field's `value`, or controlled via `values`/`onValuesChange`), and calls `onAction(node.submit, { formId: node.id, values })` on submit;
- an input node outside a form still registers its value into the nearest enclosing form, or into the root value bag when there is none;
- `renderActions` passes `{ formId, nodeId, values }` as the second argument so a bare `actions` button in a form-bearing page carries that form's values;
- `disabled` on an action stays honoured; a `pending` prop is not required — the host disables by re-rendering.

Then `tangle-network/sandbox-ui`, `src/openui/index.ts` adds the new type names to its verbatim re-export list.

## How a product adopts both

```tsx
// 1. Client — the chat message body.
import { OpenUIArtifactRenderer, type OpenUIComponentNode } from '@tangle-network/sandbox-ui/openui'
import { parseOpenUISegments } from '@tangle-network/agent-app/openui'
import { useOpenUIActions } from '@tangle-network/agent-app/openui-react'

function AssistantBody({ content, workspaceId }: { content: string; workspaceId: string }) {
  const segments = parseOpenUISegments<OpenUIComponentNode>(content)
  const ui = useOpenUIActions<OpenUIComponentNode>({
    endpoint: '/api/openui/action',
    body: { workspaceId },
  })
  return (
    <>
      {segments.map((segment, i) =>
        segment.type === 'markdown' ? (
          <Markdown key={i}>{segment.text}</Markdown>
        ) : (
          <OpenUIArtifactRenderer key={i} schema={ui.schema ?? segment.nodes} onAction={ui.onAction} />
        ),
      )}
      {ui.error && <p role="alert">{ui.error.error}</p>}
    </>
  )
}
```

```ts
// 2. Server — one route, one handler map.
import { createOpenUIActionRoute } from '@tangle-network/agent-app/openui'

const route = createOpenUIActionRoute<{ db: Db; workspaceId: string }>({
  resolve: async ({ request }) => {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return { ok: false, response: new Response('Unauthorized', { status: 401 }) }
    return { ok: true, context: { db, workspaceId: session.workspaceId } }
  },
  forms: { contrib: CONTRIB_FORM },
  actions: {
    recalculate: async ({ submission, context }) => {
      const totals = recomputeContributions(context.db, submission.values)
      return { ok: true, data: totals, schema: totalsPage(totals) }
    },
  },
  recordForAgent: async ({ context, submission, note }) => {
    await appendThreadNote(context.db, submission, note)
  },
})

export const action = ({ request }: ActionFunctionArgs) => route.handle(request)
```

```ts
// 3. Tools — only once the renderer above is deployed.
buildAppToolOpenAITools(TAXONOMY, { interactiveUi: true })
```

Order matters.
Step 3 before the renderer ships means the agent writes forms nothing draws.
Steps 1 and 2 alone are already worth shipping: they make every `actions` and `card` button on today's display-only pages live.
