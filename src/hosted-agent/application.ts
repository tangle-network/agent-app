import { parseJsonObjectBody } from '../web/core'
import {
  LINE_APPLICATION_REQUEST_MAX_BYTES,
  parseLineApplicationRequest,
  parseLineApplicationResult,
  type LineApplicationRequest,
  type LineApplicationResult,
  type LineApplicationState,
} from '@tangle-network/sandbox/core'

export { attachWorkspaceLine } from './workspace-line'

/** Missing is an affirmative storage observation, never an error fallback. */
export type ApplicationLineObservation = LineApplicationState | { state: 'missing' }

export interface ApplicationLineOptions<T> {
  /** Authenticate before consuming the body. It must not trust model-supplied identity. */
  authenticate(request: Request): Promise<{ binding: string; target: T }>
  /** Recheck live binding, membership, owner authority and exact retained message. */
  authorize(target: T, input: Readonly<LineApplicationRequest>): Promise<void>
  /** Observe the application's existing durable turn, transcript and outputs. */
  read(target: T, input: Readonly<LineApplicationRequest>): Promise<ApplicationLineObservation>
  /**
   * Enter the normal persisted chat route using input.messageId as its stable
   * client turn identity. That route owns admission, locks and completion.
   * This callback MUST deduplicate that identity across concurrent requests.
   */
  admit(target: T, input: Readonly<LineApplicationRequest>): Promise<void>
}

/** One bounded pass from the native Lines worker into the application's existing execution path. */
export function createApplicationLineHandler<T>(options: ApplicationLineOptions<T>) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return failure(405, 'method_not_allowed')
    let authenticated: { binding: string; target: T }
    try {
      authenticated = await options.authenticate(request)
    } catch (error) {
      return error instanceof Response ? error : failure(503, 'line_authentication_unavailable')
    }
    let input: LineApplicationRequest
    try {
      if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
        return failure(415, 'json_required')
      const [body, error] = await parseJsonObjectBody(request, { maxBytes: LINE_APPLICATION_REQUEST_MAX_BYTES })
      if (error) return error
      input = parseLineApplicationRequest(body)
      if (input.binding !== authenticated.binding) return failure(403, 'line_binding_mismatch')
      if (request.headers.get('idempotency-key') !== `line-application:${input.messageId}`)
        return failure(400, 'idempotency_key_mismatch')
    } catch {
      return failure(400, 'line_request_invalid')
    }
    // A viewer's AbortSignal must not cancel the accepted application task.
    const immutable = Object.freeze({ ...input, sender: Object.freeze({ ...input.sender }) })
    try {
      const { target } = authenticated
      await options.authorize(target, immutable)
      let observed = await options.read(target, immutable)
      if (observed.state === 'missing') {
        if (immutable.acceptedExecutionId !== undefined)
          return failure(503, 'accepted_execution_unavailable')
        await options.admit(target, immutable)
        observed = await options.read(target, immutable)
        if (observed.state === 'missing') observed = { state: 'pending', admitted: false }
      }
      // Reading or admitting work may yield to a disconnect or member revocation.
      await options.authorize(target, immutable)
      const result: LineApplicationResult = parseLineApplicationResult({
        ...observed, version: 1, binding: input.binding,
        messageId: input.messageId, attachmentId: input.attachmentId,
      }, input)
      return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      // Unavailable authoritative state is not permission to start a new task.
      return error instanceof Response ? error : failure(503, 'line_application_unavailable')
    }
  }
}

function failure(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status, headers: { 'cache-control': 'no-store' } })
}
