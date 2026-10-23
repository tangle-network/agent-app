import { parseJsonObjectBody } from '../web/index'
import { redactErrorMessage } from '../redact/index'
import { INLINE_PARTS_MAX_BYTES } from './wire'
import type { ChatRouteEvent, ChatTurnProduceArgs, CreateChatTurnRoutesOptions } from './turn-route-contracts'

export interface ChatTurnCancelRequest extends Record<string, unknown> {
  threadId: string
  turnId: string
  cancellationToken?: string
}

/** Product identity and editor access have already been checked before target is called. */
export interface ChatTurnCancelArgs<TContext> {
  request: Request
  body: ChatTurnCancelRequest
  tenantId: string
  userId: string
  context?: TContext
  /** Supplied only by the execution owner after admission; never copied from a request body. */
  messageId?: string
}

/** Structural public Sandbox API; addressing always comes from the captured receipt. */
export interface ChatTurnCancelSource {
  id: string
  session(id: string): {
    interrupt(input: { executionId: string }): Promise<{ cancelled: boolean }>
    status(): Promise<{ id: string; status?: string; activeExecutionId?: string | null } | null>
  }
}

/** Acknowledges durable intent only; the execution owner still reconciles actual completion and side effects. */
export interface ChatTurnCancelControlResult {
  requested: boolean
}

/** Application fields are projected once; the shared owner never infers OAuth or source-key authority. */
export interface ChatTurnCancelTarget {
  capturedMetadata: Record<string, unknown>
  status: string | undefined
  dispatchToken?: string
  requiresDispatchToken: boolean
  /** Server-captured exact owner, never coordinates supplied by the caller.
   * Called after authorization and dispatch-token checks. A positive request
   * acknowledges intent; it must not mark native work stopped. */
  control?: {
    request(capturedMetadata: Record<string, unknown>): Promise<ChatTurnCancelControlResult>
  }
  native?: {
    state: string | undefined
    sandboxId?: string
    sessionId?: string
    executionId?: string
    /** Resolve the original authorized box only after the dispatch token and receipt are validated. */
    source(): Promise<ChatTurnCancelSource | null>
  }
  /** Compare the WHOLE captured record atomically, then merge the stopped fields. False changes nothing.
   * A requested-only control target never calls this; the execution owner confirms its terminal outcome. */
  markStopped(capturedMetadata: Record<string, unknown>, stoppedAt: string): Promise<boolean>
}

export interface ChatTurnCancelOptions<TContext> {
  target(args: ChatTurnCancelArgs<TContext>): Promise<ChatTurnCancelTarget | Response>
}

const targetChanged = () => Response.json({
  error: 'This Stop no longer matches the current turn attempt. Refresh its current state.',
  code: 'CANCEL_TARGET_CHANGED',
}, { status: 409 })
const stateChanged = () => Response.json({
  error: 'This turn changed while Stop was pending. Refresh before trying Stop again.',
  code: 'CANCEL_STATE_CHANGED',
}, { status: 409 })
const success = (sandboxInterrupted: boolean) => Response.json({ succeeded: true, sandboxInterrupted })

/** Existing product Stop, composed with the same authorization and storage owner as chat. */
export async function cancelChatTurn<TContext>(request: Request, options: {
  authorize: CreateChatTurnRoutesOptions<TContext>['authorize']
  cancel?: ChatTurnCancelOptions<TContext>
  log?: (message: string, meta?: Record<string, unknown>) => void
}): Promise<Response> {
  if (!options.cancel || request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }
  const [raw, invalid] = await parseJsonObjectBody(request, { maxBytes: INLINE_PARTS_MAX_BYTES })
  if (invalid) return invalid
  const threadId = typeof raw.threadId === 'string' ? raw.threadId.trim() : ''
  const turnId = typeof raw.turnId === 'string' ? raw.turnId.trim() : ''
  if (!threadId || !turnId) {
    return Response.json({ error: 'Missing workspaceId, threadId, or turnId' }, { status: 400 })
  }
  const body: ChatTurnCancelRequest = { ...raw, threadId, turnId,
    cancellationToken: typeof raw.cancellationToken === 'string' ? raw.cancellationToken : undefined }
  const log = options.log ?? ((message, meta) => console.error(message, meta ?? {}))
  try {
    const auth = await options.authorize({ request, intent: 'cancel', body, threadId })
    if (!auth.ok) return auth.response
    if (auth.intent !== undefined && auth.intent !== 'cancel') {
      return Response.json({ error: 'Authorization did not allow this turn cancellation.', code: 'chat_authorization_intent_mismatch' }, { status: 403 })
    }
    const target = await options.cancel.target({ request, body, tenantId: auth.tenantId, userId: auth.userId,
      ...('context' in auth ? { context: auth.context } : {}) })
    if (target instanceof Response) return target
    if (target.requiresDispatchToken && (!body.cancellationToken || body.cancellationToken !== target.dispatchToken)) {
      return targetChanged()
    }
    if (target.status === 'stopped' || target.status === 'answered') return success(false)
    if (target.control) {
      const intent = await target.control.request(target.capturedMetadata)
      return intent.requested ? Response.json({ succeeded: true, sandboxInterrupted: false, cancellationRequested: true }) : targetChanged()
    }
    const markStopped = async () => await target.markStopped(target.capturedMetadata, new Date().toISOString())
      ? null : stateChanged()
    if (!target.native) return await markStopped() ?? success(false)
    const native = target.native
    if (native.state !== 'running' || !native.executionId || !native.sessionId || !native.sandboxId) {
      return Response.json({
        error: 'This turn has no confirmed native execution to stop. Refresh and try again.',
        code: 'NATIVE_CANCEL_TARGET_UNAVAILABLE',
      }, { status: 409 })
    }
    const source = await native.source()
    if (!source || source.id !== native.sandboxId) {
      return Response.json({ error: 'The turn was not marked stopped because its original sandbox is unavailable.' }, { status: 503 })
    }
    try {
      const session = source.session(native.sessionId)
      const interrupted = await session.interrupt({ executionId: native.executionId })
      if (!interrupted.cancelled) {
        const current = await session.status()
        const anotherExecution = typeof current?.activeExecutionId === 'string'
          && current.activeExecutionId.length > 0 && current.activeExecutionId !== native.executionId
        const terminal = current && ['completed', 'failed', 'cancelled'].includes(current.status ?? '')
        if (!current || current.id !== native.sessionId || current.activeExecutionId === native.executionId
          || (!anotherExecution && !terminal)) {
          throw new Error('The targeted native execution has not been confirmed stopped')
        }
      }
      return await markStopped() ?? success(interrupted.cancelled)
    } catch (error) {
      log('[chat-routes] native cancellation failed', { error: redactErrorMessage(error) })
      return Response.json({ error: 'The turn was not marked stopped because its native execution could not be confirmed interrupted.' }, { status: 502 })
    }
  } catch (error) {
    if (error instanceof Response) return error
    log('[chat-routes] cancellation failed', { error: redactErrorMessage(error) })
    return Response.json({ error: 'Turn cancellation is temporarily unavailable.' }, { status: 503 })
  }
}


/** Internal route observation of the same product Stop target. This reads only;
 * native interruption and metadata writes remain exclusive to cancelChatTurn. */
export async function* observeTurnCancellation<TContext, TResource>(
  source: AsyncIterable<ChatRouteEvent>,
  args: ChatTurnProduceArgs<TContext, TResource>,
  cancel: ChatTurnCancelOptions<TContext>,
  abort: AbortController,
): AsyncGenerator<ChatRouteEvent, void, unknown> {
  if (!args.userMessageId) { yield* source; return }
  const iterator = source[Symbol.asyncIterator]()
  let closed = false, stopped = false, drained = false, warned = false
  let polling: Promise<boolean> | undefined
  let notifyStop!: () => void
  const stop = new Promise<IteratorResult<ChatRouteEvent>>(resolve => { notifyStop = () => { resolve({ done: true, value: undefined }) } })
  const body: ChatTurnCancelRequest = { ...args.body, threadId: args.identity.sessionId,
    turnId: typeof args.body.turnId === 'string' ? args.body.turnId : '',
    cancellationToken: typeof args.body.cancellationToken === 'string' ? args.body.cancellationToken : undefined }
  const readTarget = async (): Promise<boolean> => {
    if (closed) return true
    try {
      const target = await cancel.target({ request: args.request, body, tenantId: args.identity.tenantId,
        userId: args.identity.userId, context: args.context, messageId: args.userMessageId! })
      if (closed) return true
      if (target instanceof Response) return false
      if (target.status === 'stopped' || target.status === 'superseded') {
        stopped = true
        abort.abort(new Error('The captured turn was stopped or superseded.'))
        notifyStop()
      } else if (target.status === 'answered') clearInterval(timer)
      return true
    } catch (error) {
      // Unknown state is not evidence of Stop. Completion requires a fresh
      // successful read; background observation keeps checking in the meantime.
      if (!warned) {
        warned = true
        console.error('[chat-routes] stop observation unavailable', { error: redactErrorMessage(error) })
      }
      return false
    }
  }
  const poll = (): Promise<boolean> => polling ??= readTarget().finally(() => { polling = undefined })
  const timer = setInterval(() => { void poll() }, 1_000)
  try {
    // A lazy source can establish its domain row readiness during this first pull.
    let pending = iterator.next()
    void pending.catch(() => {})
    void poll()
    while (!stopped) {
      let next: IteratorResult<ChatRouteEvent>
      try { next = await Promise.race([pending, stop]) }
      catch (error) { if (stopped) return; throw error }
      if (stopped) return
      if (next.done) {
        // A stream can finish after Stop committed but before the next tick.
        // Join the earlier snapshot, then demand a new read at the drain boundary.
        await polling
        if (!await poll()) throw new Error('The captured turn state could not be confirmed at completion')
        if (stopped) return
        drained = true
        return
      }
      yield next.value
      pending = iterator.next()
      void pending.catch(() => {})
    }
  } finally {
    closed = true
    clearInterval(timer)
    if (!drained) {
      const cleanup = iterator.return?.().catch(() => {})
      if (cleanup) args.waitUntil?.(cleanup)
    }
  }
}
