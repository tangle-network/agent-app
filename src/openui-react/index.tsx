/**
 * `@tangle-network/agent-app/openui-react` — the missing `onAction`.
 *
 * The OpenUI renderer takes an `onAction` handler and does nothing when the
 * host omits it, which is what left every button on an agent-authored page
 * inert. This hook is the handler: it holds the page's field values, posts a
 * pressed action to ONE product REST endpoint, and hands back the reply —
 * a message, corrected values, a replacement page.
 *
 * It reaches the product route and nothing else. There is no chat stream here,
 * no turn start, no sandbox: a user dragging a slider on a page the agent wrote
 * costs exactly one product request, the same as a hand-built screen. Tests
 * enforce that by walking this module's imports.
 */

import { useCallback, useRef, useState } from 'react'

import type { OpenUIFieldIssue, OpenUIFormValues, OpenUINode, OpenUIValue } from '../openui/index'

/** A successful action reply, as the route sends it. */
export interface OpenUIActionResponse<TNode extends OpenUINode = OpenUINode> {
  ok: true
  actionId: string
  message?: string
  values?: OpenUIFormValues
  schema?: TNode | TNode[]
  data?: Record<string, unknown>
}

/** A refused action, as the route sends it. */
export interface OpenUIActionFailure {
  code: string
  error: string
  actionId?: string
  issues?: OpenUIFieldIssue[]
}

/** The boundary outcome: the reply, or the reason there is none. */
export type OpenUIActionOutcome<TNode extends OpenUINode = OpenUINode> =
  | { succeeded: true; value: OpenUIActionResponse<TNode> }
  | { succeeded: false; error: OpenUIActionFailure }

/** Where on the page an action fired, and what the form held at that moment.
 *  A renderer that owns form state passes `values`; otherwise the hook's own
 *  `values` are sent. */
export interface OpenUIActionContext {
  formId?: string
  nodeId?: string
  values?: OpenUIFormValues
}

/** How the hook talks to the product route. */
export interface UseOpenUIActionsOptions<TNode extends OpenUINode = OpenUINode> {
  /** The product's action endpoint — a plain REST route, never a chat route. */
  endpoint: string
  /** Extra routing fields merged into every POST body (workspaceId, threadId).
   *  Reserved keys (`actionId`, `formId`, `values`, `nodeId`, `artifactPath`)
   *  always win. */
  body?: Record<string, string | number | boolean>
  /** Vault path of the persisted page, when the product renders one. */
  artifactPath?: string
  /** Seed values, e.g. the `value` each field was authored with. */
  initialValues?: OpenUIFormValues
  headers?: Record<string, string>
  /** Injection seam for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Called with every settled outcome, success or failure. */
  onResult?: (outcome: OpenUIActionOutcome<TNode>) => void
}

/** What the hook returns. `onAction` is the renderer prop; the rest is state a
 *  card renders around it. */
export interface OpenUIActionsController<TNode extends OpenUINode = OpenUINode> {
  /** Current field values. */
  values: OpenUIFormValues
  /** Set one field. */
  setValue: (fieldId: string, value: OpenUIValue) => void
  /** Replace all fields. */
  setValues: (next: OpenUIFormValues) => void
  /** Back to `initialValues`. */
  resetValues: () => void
  /**
   * Pass straight to the renderer's `onAction`. Fire-and-forget; read the
   * result from this controller's state or from `onResult`.
   */
  onAction: (action: { id: string }, context?: OpenUIActionContext) => void
  /** The awaitable form of `onAction`, for a product's own buttons. */
  submit: (action: { id: string }, context?: OpenUIActionContext) => Promise<OpenUIActionOutcome<TNode>>
  /** The action currently in flight, if any. */
  pendingActionId: string | null
  /** The last failure, cleared when the next action starts. */
  error: OpenUIActionFailure | null
  /** The last success message, cleared when the next action starts. */
  message: string | null
  /** A replacement page from the last success, to render instead of the original. */
  schema: TNode[] | null
  /** Free-form payload from the last success. */
  data: Record<string, unknown> | null
}

const RESERVED_BODY_KEYS = ['actionId', 'formId', 'values', 'nodeId', 'artifactPath']

function asNodes<TNode extends OpenUINode>(schema: TNode | TNode[] | undefined): TNode[] | null {
  if (!schema) return null
  const nodes = Array.isArray(schema) ? schema : [schema]
  return nodes.length > 0 ? nodes : null
}

function failureFrom(payload: unknown, status: number, actionId: string): OpenUIActionFailure {
  const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const code = typeof record.code === 'string' && record.code ? record.code : `OPENUI_ACTION_HTTP_${status}`
  const error =
    typeof record.error === 'string' && record.error
      ? record.error
      : typeof record.message === 'string' && record.message
        ? record.message
        : 'That action could not be completed.'
  const issues = Array.isArray(record.issues) ? (record.issues as OpenUIFieldIssue[]) : undefined
  return { code, error, actionId, ...(issues ? { issues } : {}) }
}

/**
 * Make an agent-authored page interactive.
 *
 * ```tsx
 * const ui = useOpenUIActions({ endpoint: '/api/openui/action', body: { workspaceId } })
 * <OpenUIArtifactRenderer schema={ui.schema ?? nodes} onAction={ui.onAction} />
 * {ui.error && <p role="alert">{ui.error.error}</p>}
 * ```
 *
 * One action runs at a time: pressing a second button while the first is in
 * flight is refused with `OPENUI_ACTION_BUSY` rather than racing two writes
 * against the same form.
 */
export function useOpenUIActions<TNode extends OpenUINode = OpenUINode>(
  options: UseOpenUIActionsOptions<TNode>,
): OpenUIActionsController<TNode> {
  const initial = options.initialValues ?? {}
  const [values, setValuesState] = useState<OpenUIFormValues>(initial)
  const [pendingActionId, setPendingActionId] = useState<string | null>(null)
  const [error, setError] = useState<OpenUIActionFailure | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [schema, setSchema] = useState<TNode[] | null>(null)
  const [data, setData] = useState<Record<string, unknown> | null>(null)

  // Refs the async submit reads. `submit` is stable across renders, so reading
  // values/options from state would capture the first render's copies; the refs
  // are how an in-flight request sees what the user typed after it started.
  const valuesRef = useRef<OpenUIFormValues>(initial)
  const pendingRef = useRef<string | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const setValues = useCallback((next: OpenUIFormValues) => {
    valuesRef.current = next
    setValuesState(next)
  }, [])

  const setValue = useCallback((fieldId: string, value: OpenUIValue) => {
    const next = { ...valuesRef.current, [fieldId]: value }
    valuesRef.current = next
    setValuesState(next)
  }, [])

  const resetValues = useCallback(() => {
    const next = optionsRef.current.initialValues ?? {}
    valuesRef.current = next
    setValuesState(next)
  }, [])

  const submit = useCallback(
    async (action: { id: string }, context?: OpenUIActionContext): Promise<OpenUIActionOutcome<TNode>> => {
      const current = optionsRef.current
      if (pendingRef.current) {
        const busy: OpenUIActionFailure = {
          code: 'OPENUI_ACTION_BUSY',
          error: 'Another action is still running. Wait for it to finish.',
          actionId: action.id,
        }
        setError(busy)
        current.onResult?.({ succeeded: false, error: busy })
        return { succeeded: false, error: busy }
      }

      const submitted = context?.values ?? valuesRef.current
      if (context?.values) setValues(context.values)
      pendingRef.current = action.id
      setPendingActionId(action.id)
      setError(null)
      setMessage(null)

      const body: Record<string, unknown> = {
        ...current.body,
        actionId: action.id,
        values: submitted,
        ...(context?.formId ? { formId: context.formId } : {}),
        ...(context?.nodeId ? { nodeId: context.nodeId } : {}),
        ...(current.artifactPath ? { artifactPath: current.artifactPath } : {}),
      }

      const doFetch = current.fetchImpl ?? fetch
      let outcome: OpenUIActionOutcome<TNode>
      try {
        const response = await doFetch(current.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...current.headers },
          body: JSON.stringify(body),
        })
        const payload = (await response.json().catch(() => null)) as unknown
        if (!response.ok) {
          outcome = { succeeded: false, error: failureFrom(payload, response.status, action.id) }
        } else {
          const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
          if (record.ok !== true) {
            outcome = { succeeded: false, error: failureFrom(payload, response.status, action.id) }
          } else {
            outcome = {
              succeeded: true,
              value: {
                ok: true,
                actionId: typeof record.actionId === 'string' ? record.actionId : action.id,
                ...(typeof record.message === 'string' ? { message: record.message } : {}),
                ...(record.values && typeof record.values === 'object' && !Array.isArray(record.values)
                  ? { values: record.values as OpenUIFormValues }
                  : {}),
                ...(record.schema ? { schema: record.schema as TNode | TNode[] } : {}),
                ...(record.data && typeof record.data === 'object' && !Array.isArray(record.data)
                  ? { data: record.data as Record<string, unknown> }
                  : {}),
              },
            }
          }
        }
      } catch (cause) {
        outcome = {
          succeeded: false,
          error: {
            code: 'OPENUI_ACTION_UNREACHABLE',
            error: cause instanceof Error ? cause.message : 'Could not reach the app. Try again.',
            actionId: action.id,
          },
        }
      }

      pendingRef.current = null
      setPendingActionId(null)
      if (outcome.succeeded) {
        const value = outcome.value
        if (value.values) setValues(value.values)
        setMessage(value.message ?? null)
        setSchema(asNodes(value.schema))
        setData(value.data ?? null)
      } else {
        setError(outcome.error)
      }
      current.onResult?.(outcome)
      return outcome
    },
    [setValues],
  )

  const onAction = useCallback(
    (action: { id: string }, context?: OpenUIActionContext) => {
      void submit(action, context)
    },
    [submit],
  )

  return {
    values,
    setValue,
    setValues,
    resetValues,
    onAction,
    submit,
    pendingActionId,
    error,
    message,
    schema,
    data,
  }
}

/** The body keys the hook owns; a product's extra `body` fields cannot shadow
 *  them. Exported so a route's own tests can assert the same list. */
export const OPENUI_RESERVED_BODY_KEYS: readonly string[] = RESERVED_BODY_KEYS
