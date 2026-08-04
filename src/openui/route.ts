/**
 * The host half of an interactive OpenUI page: one POST endpoint that turns a
 * button press into a product function call.
 *
 * THE SEAM THAT KEEPS IT FREE. This factory has no agent connection, no session
 * id, no sandbox, and no turn — look at {@link OpenUIActionRouteOptions}: the
 * only things a product supplies are an authorizer and a map of plain handlers.
 * There is no seam here through which a model call could be made, which is what
 * makes "manipulating agent-authored UI costs nothing" a structural property
 * rather than a promise. Compare `./interactions`, whose answer route exists
 * precisely to unblock a running turn: that one resolves a sidecar connection,
 * and this one cannot.
 *
 * A handler returns data, a replacement page, or a typed failure. If it wants
 * the agent to know what happened, the product records
 * {@link describeOpenUIAction} into the thread — read on the NEXT turn the user
 * chooses to spend, never as a side effect of the click.
 *
 * Handlers return web-standard `Response`s (Workers, Node 18+, Deno).
 */

import {
  describeOpenUIAction,
  validateOpenUIActionBody,
  type OpenUIActionSubmission,
} from './action'
import type { OpenUINode } from './segments'
import {
  validateOpenUIFormValues,
  type OpenUIFieldIssue,
  type OpenUIFormSpec,
  type OpenUIFormValues,
} from './values'

/** Logging surface the route uses; `console` by default. */
export type OpenUIActionLogger = Pick<Console, 'warn' | 'error'>

/** The product's verdict on who is calling. `response` short-circuits with a
 *  product-authored Response (401/403/404/429…). */
export type OpenUIActionResolution<TContext> =
  | { ok: true; context: TContext }
  | { ok: false; response: Response }

/** What a handler is given: the caller's request, the parsed submission, and
 *  whatever the product's authorizer resolved. */
export interface OpenUIActionHandlerArgs<TContext> {
  request: Request
  submission: OpenUIActionSubmission
  context: TContext
}

/** What a handler returns. A replacement `schema` re-renders the page in place;
 *  `values` writes corrected/derived values back into the form. */
export type OpenUIActionResult<TNode extends OpenUINode = OpenUINode> =
  | {
      ok: true
      /** Short confirmation for the card, in the user's language. */
      message?: string
      /** Values to write back into the form (server-corrected or derived). */
      values?: OpenUIFormValues
      /** A page to render in place of the current one. */
      schema?: TNode | TNode[]
      /** Anything else the client should read (totals, ids, links). */
      data?: Record<string, unknown>
    }
  | {
      ok: false
      /** Machine-readable reason, surfaced to the client verbatim. */
      code: string
      /** One sentence the user can act on. */
      message: string
      /** HTTP status; defaults to 400. */
      status?: number
      /** Field-level rejections, so the card can mark the offending inputs. */
      issues?: OpenUIFieldIssue[]
    }

/** One product action, keyed in {@link OpenUIActionRouteOptions.actions} by the
 *  `action.id` the agent authored on the page. */
export type OpenUIActionHandler<TContext, TNode extends OpenUINode = OpenUINode> = (
  args: OpenUIActionHandlerArgs<TContext>,
) => OpenUIActionResult<TNode> | Promise<OpenUIActionResult<TNode>>

/** How the route is wired. Note what is absent: nothing here can reach a model. */
export interface OpenUIActionRouteOptions<TContext, TNode extends OpenUINode = OpenUINode> {
  /**
   * Authenticate and authorize the caller, and resolve whatever the handlers
   * need (db handle, workspace, user). The only product-supplied gate.
   */
  resolve: (args: {
    request: Request
    submission: OpenUIActionSubmission
  }) => OpenUIActionResolution<TContext> | Promise<OpenUIActionResolution<TContext>>
  /** Handlers by action id. An id with no handler is a 404, never a no-op. */
  actions: Record<string, OpenUIActionHandler<TContext, TNode>>
  /**
   * Form specs by form id. When the submission names a form listed here, its
   * values are checked against the spec before the handler runs, and rejections
   * come back as field issues. Omit a form to leave checking to its handler.
   */
  forms?: Record<string, OpenUIFormSpec>
  /**
   * Called after a successful handler with the line the agent should read on
   * its next turn. Persist it against the thread; do NOT start a turn from it.
   */
  recordForAgent?: (args: {
    request: Request
    submission: OpenUIActionSubmission
    context: TContext
    note: string
  }) => void | Promise<void>
  logger?: OpenUIActionLogger
}

/** The endpoint a product mounts. */
export interface OpenUIActionRoute {
  /** POST `{ actionId, formId?, values?, nodeId?, artifactPath? }`. */
  handle: (request: Request) => Promise<Response>
}

function failure(code: string, error: string, status: number, extra?: Record<string, unknown>): Response {
  return Response.json({ ok: false, code, error, ...(extra ?? {}) }, { status })
}

/**
 * Build the action endpoint for agent-authored pages.
 *
 * ```ts
 * const route = createOpenUIActionRoute({
 *   resolve: async ({ request }) => {
 *     const session = await auth(request)
 *     if (!session) return { ok: false, response: new Response('Unauthorized', { status: 401 }) }
 *     return { ok: true, context: { db, workspaceId: session.workspaceId } }
 *   },
 *   forms: { deduction_form: DEDUCTION_FORM },
 *   actions: {
 *     recalculate: async ({ submission, context }) => {
 *       const totals = recompute(context.db, submission.values)
 *       return { ok: true, data: totals, schema: totalsPage(totals) }
 *     },
 *   },
 * })
 * export const action = ({ request }: ActionFunctionArgs) => route.handle(request)
 * ```
 */
export function createOpenUIActionRoute<TContext, TNode extends OpenUINode = OpenUINode>(
  options: OpenUIActionRouteOptions<TContext, TNode>,
): OpenUIActionRoute {
  const logger = options.logger ?? console

  async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return failure('OPENUI_METHOD_NOT_ALLOWED', 'Method not allowed', 405)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return failure('OPENUI_BODY_INVALID', 'Invalid JSON body', 400)
    }

    const parsed = validateOpenUIActionBody(body)
    if (!parsed.ok) return failure(parsed.code, parsed.error, 400)
    const submission = parsed.submission

    // Unknown ids are refused before the authorizer runs: a page that names an
    // action the product never registered is a broken page, and answering it
    // 404 is what makes that visible instead of a button that does nothing.
    const handler = Object.prototype.hasOwnProperty.call(options.actions, submission.actionId)
      ? options.actions[submission.actionId]
      : undefined
    if (!handler) {
      return failure(
        'OPENUI_ACTION_UNKNOWN',
        `No handler is registered for "${submission.actionId}".`,
        404,
        { actionId: submission.actionId },
      )
    }

    const resolution = await options.resolve({ request, submission })
    if (!resolution.ok) return resolution.response

    const spec =
      submission.formId && options.forms
        ? Object.prototype.hasOwnProperty.call(options.forms, submission.formId)
          ? options.forms[submission.formId]
          : undefined
        : undefined
    let values = submission.values
    if (spec) {
      const checked = validateOpenUIFormValues(spec, submission.values)
      if (!checked.ok) {
        return failure('OPENUI_VALUES_REJECTED', 'Some fields need fixing before this can run.', 422, {
          issues: checked.issues,
        })
      }
      values = checked.values
    }

    const checkedSubmission: OpenUIActionSubmission = { ...submission, values }

    let result: OpenUIActionResult<TNode>
    try {
      result = await handler({ request, submission: checkedSubmission, context: resolution.context })
    } catch (error) {
      logger.error('[openui] action handler failed:', error)
      return failure('OPENUI_ACTION_FAILED', 'That action could not be completed. Try again.', 500, {
        actionId: submission.actionId,
      })
    }

    if (!result.ok) {
      return failure(result.code, result.message, result.status ?? 400, {
        actionId: submission.actionId,
        ...(result.issues ? { issues: result.issues } : {}),
      })
    }

    if (options.recordForAgent) {
      try {
        await options.recordForAgent({
          request,
          submission: checkedSubmission,
          context: resolution.context,
          note: describeOpenUIAction(checkedSubmission),
        })
      } catch (error) {
        // The user's action already succeeded. Losing the agent-facing note
        // degrades the next turn's context; it must not fail the click.
        logger.warn('[openui] recordForAgent failed:', error)
      }
    }

    return Response.json({
      ok: true,
      actionId: submission.actionId,
      ...(result.message ? { message: result.message } : {}),
      ...(result.values ? { values: result.values } : {}),
      ...(result.schema ? { schema: result.schema } : {}),
      ...(result.data ? { data: result.data } : {}),
    })
  }

  return { handle }
}
