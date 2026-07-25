/**
 * Framework-neutral work-product review endpoints — the
 * `createInteractionAnswerRoute` factory pattern: web-standard
 * `Request`/`Response`, ONE product-supplied `authorize` seam (session auth,
 * workspace access, reviewer identity, rate limits), everything behind it
 * mechanism. Server-only and subpath-only: never reachable from a client
 * bundle (enforced by the browser-safety test).
 *
 * The verdict endpoint is deliberately NOT a second approval broker: agent
 * asks stay on `/interactions`; this is the REVIEWER's plain authorized
 * verdict on a ready package — one human-in-the-loop channel per direction.
 * A `request_changes` note re-enters chat as the correction turn via the
 * `onVerdict` seam; chat remains the driver surface.
 */

import {
  createWorkProductService,
  type WorkProductService,
} from './service'
import {
  workProductToPersistedPart,
  type WorkProductPersistedPart,
  type WorkProductRecord,
  type WorkProductStorePort,
} from './types'

/** Reviewer verdict wire body for the POST endpoint. */
export type WorkProductVerdictBody =
  | { ok: true; id: string; verdict: 'approve'; note?: string }
  | { ok: true; id: string; verdict: 'request_changes'; note: string }
  | { ok: false; error: string }

/** Validate the verdict POST body: `{ id, verdict, note? }`; a
 *  `request_changes` verdict REQUIRES a non-empty note — the note IS the
 *  correction turn the agent works from. */
export function validateWorkProductVerdictBody(body: Record<string, unknown>): WorkProductVerdictBody {
  const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : null
  if (!id) return { ok: false, error: 'Missing work product id' }
  const verdict = body.verdict
  if (verdict !== 'approve' && verdict !== 'request_changes') {
    return { ok: false, error: 'Invalid verdict: expected approve or request_changes' }
  }
  const note = body.note === undefined ? undefined : typeof body.note === 'string' ? body.note.trim() : null
  if (note === null) return { ok: false, error: 'Invalid note: expected a string' }
  if (verdict === 'request_changes') {
    if (!note) return { ok: false, error: 'request_changes requires a note — it becomes the correction instruction in chat' }
    return { ok: true, id, verdict, note }
  }
  return note ? { ok: true, id, verdict, note } : { ok: true, id, verdict }
}

/** The product seam's verdict for one request: authenticated reviewer +
 *  workspace, or a product-authored short-circuit Response (401/403/429…). */
export type WorkProductRouteAuthorization =
  | { ok: true; workspaceId: string; reviewedBy: string }
  | { ok: false; response: Response }

/** Auth seam arguments carrying the request, the endpoint intent, and the parsed verdict body */
export interface WorkProductAuthorizeArgs {
  request: Request
  intent: 'list' | 'detail' | 'verdict'
  /** The parsed, validated POST body (verdict intent only). */
  body?: Record<string, unknown>
}

/** Configuration options assembling the review endpoints from the store and product seams */
export interface WorkProductRoutesOptions {
  store: WorkProductStorePort
  /** Authenticate + authorize the caller; the ONLY product access step. */
  authorize: (args: WorkProductAuthorizeArgs) => Promise<WorkProductRouteAuthorization>
  /** Post-verdict product seam: post the `request_changes` note into the
   *  driving chat thread as the correction turn, notify, etc. Runs after the
   *  transition commits; a throw is logged, never unwinds the verdict. */
  onVerdict?: (args: {
    record: WorkProductRecord
    verdict: 'approve' | 'request_changes'
    note?: string
    reviewedBy: string
  }) => void | Promise<void>
  /** Persist/update the transcript anchor part reflecting the new status, so
   *  the chat card flips with the verdict. */
  persistAnchorPart?: (part: WorkProductPersistedPart, record: WorkProductRecord) => void | Promise<void>
  /** Future integration point fired on approval (push to a DMS/CRM/export
   *  pipeline). A stub seam by design — export itself stays the product's
   *  signed object-store download. */
  onExport?: (record: WorkProductRecord) => void | Promise<void>
  logger?: Pick<Console, 'warn' | 'error'>
  now?: () => number
}

/** Assembled review endpoints returning web-standard Responses */
export interface WorkProductRoutes {
  /** GET — the workspace's records for the queue projection. Optional
   *  `?status=a,b` filter. */
  list: (request: Request) => Promise<Response>
  /** GET — one record by id (404 when absent or outside the workspace). */
  detail: (request: Request, id: string) => Promise<Response>
  /** POST `{ id, verdict, note? }` — the reviewer verdict: CAS transition +
   *  history entry + product seams. 409 when the record is no longer ready. */
  verdict: (request: Request) => Promise<Response>
}

/** Create the work-product review endpoints over the store port and product seams */
export function createWorkProductRoutes(options: WorkProductRoutesOptions): WorkProductRoutes {
  const logger = options.logger ?? console
  const service: WorkProductService = createWorkProductService({
    store: options.store,
    ...(options.now ? { now: options.now } : {}),
  })

  async function list(request: Request): Promise<Response> {
    const auth = await options.authorize({ request, intent: 'list' })
    if (!auth.ok) return auth.response
    const url = new URL(request.url)
    const statusParam = url.searchParams.get('status')
    const statuses = statusParam
      ? statusParam.split(',').map((value) => value.trim()).filter(Boolean)
      : null
    const workProducts = await options.store.listByWorkspace(
      auth.workspaceId,
      statuses ? { status: statuses as WorkProductRecord['status'][] } : undefined,
    )
    return Response.json({ workProducts })
  }

  async function detail(request: Request, id: string): Promise<Response> {
    const auth = await options.authorize({ request, intent: 'detail' })
    if (!auth.ok) return auth.response
    const record = await options.store.load(id)
    if (!record || record.workspaceId !== auth.workspaceId) {
      return Response.json({ error: 'Work product not found' }, { status: 404 })
    }
    return Response.json({ workProduct: record })
  }

  async function verdict(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const validation = validateWorkProductVerdictBody(body)
    if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 })

    const auth = await options.authorize({ request, intent: 'verdict', body })
    if (!auth.ok) return auth.response

    const existing = await options.store.load(validation.id)
    if (!existing || existing.workspaceId !== auth.workspaceId) {
      return Response.json({ error: 'Work product not found' }, { status: 404 })
    }

    const outcome = await service.applyVerdict(validation.id, {
      verdict: validation.verdict,
      reviewedBy: auth.reviewedBy,
      ...(validation.note === undefined ? {} : { note: validation.note }),
    })
    if (!outcome.succeeded) {
      // A lost race and an illegal edge both mean "the row is no longer the
      // ready version you looked at" — 409 so the client re-reads.
      return Response.json({ code: 'VERDICT_CONFLICT', error: outcome.error }, { status: 409 })
    }
    const record = outcome.value

    // Product seams run AFTER the committed transition; their failures are
    // logged, never unwound — the verdict is durable truth at this point.
    try {
      await options.persistAnchorPart?.(workProductToPersistedPart(record), record)
    } catch (error) {
      logger.error('[work-product] persistAnchorPart failed:', error)
    }
    try {
      await options.onVerdict?.({
        record,
        verdict: validation.verdict,
        ...(validation.note === undefined ? {} : { note: validation.note }),
        reviewedBy: auth.reviewedBy,
      })
    } catch (error) {
      logger.error('[work-product] onVerdict failed:', error)
    }
    if (validation.verdict === 'approve') {
      try {
        await options.onExport?.(record)
      } catch (error) {
        logger.error('[work-product] onExport failed:', error)
      }
    }

    return Response.json({ ok: true, workProduct: record })
  }

  return { list, detail, verdict }
}
