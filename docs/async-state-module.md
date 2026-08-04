# `web-react/async` — a failed fetch cannot look like empty data

```ts
import {
  AsyncView,
  MutationStatus,
  confirmJson,
  confirmResponse,
  readOkJson,
  requireOk,
  useAsyncResource,
  useConfirmedMutation,
} from '@tangle-network/agent-app/web-react/async'
```

Two audited verticals shipped dozens of screens where a network failure rendered exactly like a successful-but-empty load: "No templates available" over a 500, an empty member list over a dropped connection, a blank conversation over a 404.
One shipped a save button that read "Saved" after a 404.
Both are the same mistake in two directions — a state the code never modelled, so the UI defaulted to the most reassuring one it had.

This module models the states instead.
A resource is `idle | loading | error | empty | ready`, where `error` is the only variant carrying a message and `empty` is the only variant carrying a resolved value, so no component can render one while it is in the other.
A write is `idle | pending | succeeded | failed`, where `succeeded` is reachable only through a branded confirmation that has already checked the response.

The subpath is browser-safe by construction and covered by `tests/browser-safe-subpaths.test.ts`: no node builtins, no engine imports, react as the only peer.

## The three read anti-patterns, before and after

### 1. A `catch` that only clears the loading flag

The failure is swallowed; the component renders whatever the initial state was, which is the empty list.

```tsx
// before
const [templates, setTemplates] = useState<Template[]>([])
const [loading, setLoading] = useState(true)
useEffect(() => {
  fetch('/api/templates')
    .then((res) => res.json())
    .then(setTemplates)
    .catch(() => setLoading(false)) // the failure ends here and the screen says "No templates yet"
    .finally(() => setLoading(false))
}, [])

if (loading) return <Spinner />
return templates.length === 0 ? <EmptyTemplates /> : <TemplateGrid items={templates} />
```

```tsx
// after
const templates = useAsyncResource<Template[]>({
  load: async ({ signal }) => readOkJson(await fetch('/api/templates', { signal }), parseTemplates),
})

return (
  <AsyncView
    state={templates}
    empty={{
      title: 'No templates yet',
      description: 'Templates you create show up here.',
      action: { label: 'Create a template', onClick: openCreateDialog },
    }}
  >
    {(items) => <TemplateGrid items={items} />}
  </AsyncView>
)
```

A rejected load now renders the message and a Retry button.
The empty copy is unreachable from a failure, because `empty` is only produced by a load that resolved.

### 2. An early return on a non-ok response

`fetch` resolves on a 404, so a bare `if (!res.ok) return` leaves the caller holding its initial value — the empty list again — with no error anywhere.

```tsx
// before
async function loadMembers() {
  const res = await fetch(`/api/workspaces/${id}/members`)
  if (!res.ok) return // a 403 renders as "No members yet"
  setMembers(await res.json())
}
```

```tsx
// after
const members = useAsyncResource<Member[]>({
  deps: [id],
  load: async ({ signal }) => {
    const res = await requireOk(await fetch(`/api/workspaces/${id}/members`, { signal }))
    return parseMembers(await res.json())
  },
})
```

`requireOk` throws `AsyncRequestError` for any non-2xx, carrying `status`, `statusText` and a 200-character body snippet for diagnosis.
The status reaches the reader ("Request failed (403 Forbidden)"); the body snippet stays off the message so a server's HTML error page never becomes UI copy.
`readOkJson(response, parse)` is the same check plus a JSON read, with the caller's validator running inside the load so a bad shape lands in `error` rather than crashing a child component.

### 3. A bare `null` returned while loading

Nothing renders, so the screen reads as "this workspace has no conversation".

```tsx
// before
if (!thread) return null // loading, failed and genuinely-absent are one branch
return <Conversation thread={thread} />
```

```tsx
// after
<AsyncView state={thread} empty={{ title: 'No messages yet', description: 'Send the first message to start.' }}>
  {(value) => <Conversation thread={value} />}
</AsyncView>
```

`AsyncView` has no branch that renders nothing.
`loading` and `idle` render a labelled busy block, `error` renders the message plus the retry, `empty` renders the caller's copy and next action.
`renderLoading` / `renderError` / `renderIdle` are typed to return an element, and a nullish return at runtime falls back to the built-in block rather than rendering nothing — the escape hatch cannot reopen the defect.
Only `ready` reaches `children`, and it hands over the value, so the ready branch cannot be entered without data.

## The write anti-pattern: "Saved" on a 404

```tsx
// before
async function save() {
  setSaving(true)
  await fetch(`/api/records/${id}`, { method: 'PUT', body })
  setSaving(false)
  setSaved(true) // the promise resolved, so the button says "Saved" — status 404 included
}
```

```tsx
// after
const save = useConfirmedMutation<RecordDraft, Record>({
  mutate: async (draft, { signal }) =>
    confirmJson(
      await fetch(`/api/records/${id}`, { method: 'PUT', body: JSON.stringify(draft), signal }),
      parseRecord,
    ),
  onSucceeded: (record) => revalidate(record.id),
})

<button type="button" disabled={save.state.status === 'pending'} onClick={() => void save.run(draft)}>
  Save
</button>
<MutationStatus state={save.state} />
```

`mutate` must return a confirmation, and a confirmation carries a symbol brand that only `confirmWrite` / `confirmResponse` / `confirmJson` can attach.
A resolved promise is not one.
A hand-written `{ succeeded: true }` is not one either — it lands on `failed` with "The write could not be confirmed.", because an unbranded object is exactly the shape produced by code that never checked the response.

| `mutate` returns | State |
| --- | --- |
| `confirmResponse(res)` with a 2xx | `succeeded`, value = the response |
| `confirmResponse(res)` with a 404/500 | `failed`, message carries the status |
| `confirmJson(res, parse)` where `parse` throws | `failed`, message from the validator |
| `rejectWrite('Could not save.')` | `failed` |
| a thrown error | `failed`, message from the error |
| `{ succeeded: true, value }` written by hand | `failed` — unconfirmed |

`run` never rejects: it returns the outcome and mirrors it into `state`, so a caller can both render the state and branch on the result.

## Reference

| Export | What it is |
| --- | --- |
| `useAsyncResource(options)` | The five-state machine. Returns the state union with `retry` on every variant. |
| `AsyncView` | Renders the branch the state is in. `empty` is a required prop. |
| `useConfirmedMutation(options)` | The write machine. Returns `{ state, run, reset }`. |
| `MutationStatus` | The write's status line — "Saved" renders only from `succeeded`. |
| `requireOk` / `readOkJson` | Response readers that turn a non-ok status into a throw. |
| `confirmWrite` / `confirmResponse` / `confirmJson` / `rejectWrite` | The only builders of a write outcome. |
| `isConfirmedWrite` | The brand check, for code composing its own outcomes. |
| `defaultIsEmpty` / `resolveAsyncValue` / `asyncErrorMessage` | The pure rules, for non-React callers and tests. |
| `AsyncRequestError` | Thrown by `requireOk`; carries `status`, `statusText`, `url`, `body`. |

### Options that matter

- `deps` — the load re-runs when any entry changes by `Object.is`. The load itself is read from a ref, so an inline arrow is fine.
- `enabled` — `false` holds the resource at `idle` and runs nothing, for a route param that has not resolved yet.
- `initialValue` — a first-render seed from an SSR loader; the hook starts resolved and skips the first load. Read once, so a revalidating loader value belongs in `deps`.
- `isEmpty` — the emptiness rule for a shape the default cannot see into. The default treats `null`/`undefined`, an empty array and an empty `Map`/`Set` as empty; `''`, `0` and `{}` are `ready`, because they are real values for the resources that produce them.
- `errorMessage` — maps a thrown value to the copy the reader gets, when the raw message is not for users.

### What it deliberately does not do

No cache, no request dedupe, no stale-while-revalidate, no global store.
Those are a data-layer decision a product makes once; this is the state contract every screen needs regardless of which one it picks.
`retry` re-runs the load and returns to `loading` — it is a recovery action, not a background refresh.

Concurrency is handled where it produces the defect: every load and every write carries a sequence guard, so a superseded response (inputs changed, retry pressed, a second save started) can never repaint the current view, and a superseded load's `AbortSignal` is aborted.
A write's signal is aborted only by a later `run` — never on unmount, because a write the user asked for must not be cancelled by navigating away.
