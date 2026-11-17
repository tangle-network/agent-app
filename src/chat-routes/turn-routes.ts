/**
 * `createChatTurnRoutes` — the assembled server chat vertical (issue #188
 * Phase 1). One factory composing the pieces every product re-wired by hand:
 *
 *   body parse/validate      → `/web` `parseJsonObjectBody` + `./wire`
 *   turn identity            → `/stream` `resolveChatTurn` + agent-runtime `/durable`
 *                              `deriveExecutionId`
 *   producer                 → function after admission, or declared Router
 *                              and Sandbox backends. Router model calls overlap
 *                              admission by default; tools wait for commit.
 *   turn engine              → agent-runtime `/durable` `handleChatTurn` (verbatim)
 *   durability               → `/stream` turn-buffer tap, wired BY DEFAULT
 *                              (tee + drain keeps the turn running after a
 *                              client drop; replay serves the buffered tail);
 *                              `turnHost` runs it in a Durable Object instead,
 *                              which outlives the browser's request
 *   persistence              → injected `/chat-store`-shaped store
 *                              (user row on send, assistant row on completion)
 *   interactions answer      → `/interactions` `createInteractionAnswerRoute`
 *
 * Handlers are web-standard `Request → Response` (Workers, Node 18+, Deno) —
 * no router import. Auth/access is one injected `authorize` seam, composable
 * with `/app-auth` guards but not coupled to them.
 *
 * Optional product seams let a complex turn-orchestrator compose the vertical
 * instead of hand-rolling a generator — each omittable to the exact behavior
 * above: `turnLock` (single-flight acquire/release around the turn),
 * `contextGate` (pre-producer domain-readiness short-circuit), `beforeTurn`
 * (observe + augment the producer input), `afterAuthorize` (start the box, keys
 * and session the turn will need the moment the caller is admitted, so they
 * overlap the lock and the user-row insert), `lifecycle` (deterministic
 * start/complete/error telemetry), `heartbeat` (keepalive during silent
 * producer waits), and `onRawEvent` (the raw producer events, for telemetry) —
 * plus the `authorize` result's `insertUserMessage` flag (suppress the user row
 * for a product-dispatched turn). `handleChatTurn` stays the engine — the seams
 * only wrap its input, its producer stream, and its settle.
 *
 * Seam stability: all of the above are STABLE and safe to depend on. They
 * graduated in #227 against the bar this package holds itself to — a seam is
 * provisional until two INDEPENDENT consumers exercise it, because one
 * consumer's shape is indistinguishable from that consumer's assumptions.
 * `turnLock` cleared it with `/turn-stream`'s shared DO adapter (#221);
 * `contextGate`, `beforeTurn`, `onRawEvent` and `insertUserMessage` each
 * cleared it with two product verticals reading them differently — and the
 * review found no leaked assumptions to fix, only `ChatRouteEvent` to export.
 * `prepareTurn` (post-admission context work, run inside a progress-first
 * stream) is provisional: one consumer so far.
 *
 * They stay FLAT top-level options (not grouped under a `hooks` object): that
 * grouping would break every shipped consumer's call for no mechanism gain, and
 * this package's exports are additive-only. For the same reason `onRawEvent`
 * keeps its two-argument `(event, context)` signature rather than being
 * normalized to the single-args shape the other seams take.
 */

import { withD1QueryCount, currentD1QueryCounter } from '../launch-invariants/d1-query-count'
import { createInteractionAnswerRoute } from '../interactions/route'
import { replayTurnEvents, stampReplaySeq } from '../stream/index'
import { parseJsonObjectBody } from '../web/index'
import { createTurnTrace, type TurnTrace, type TurnTraceSink } from '../turn-trace/recorder'
import { createIntelligenceTurnTraceSink } from '../turn-trace/otel'
import { storeSupportsDraftPersistence, type AssistantDraftStore, type DraftPersistenceTuning } from './draft-persistence'
import { startTurnPrefetch } from './turn-prefetch'
import { errorResponse, namedModelRefusal, validateTurnBody, type AdmittedTurn, type ParsedTurnBody, type TurnProgressCallback } from './turn-admission'
import { createAdmittedTurnRunner } from './turn-execution'
import { earlyTurnWork, type AfterAuthorizeWork } from './early-turn-work'
import {
  type ChatRouteEvent,
  type ChatTurnAfterAuthorizeRelease,
  type ChatTurnRequestContext,
  type ChatTurnRoutes,
  type CreateChatTurnRoutesOptions,
} from './turn-route-contracts'
import {
  buildTurnPhaseEvent,
  TURN_INTENT_EVENT,
  TURN_PROGRESS_FIRST,
  TURN_PROGRESS_HEADER,
  TURN_HOST_CONTROL_HEADER,
  TURN_HOST_CONTROL_FIRST,
  TURN_HOST_CONTROL_EVENT,
  TURN_ROUTE_PHASE_MESSAGES,
  turnResponseEventFor,
  type TurnIntentEvent,
  type TurnRoutePhase,
  type TurnHostControlTarget,
} from './turn-progress'
import { ChatTurnInputError } from './wire'
import { resolveTurnStorage, turnStorageBindings, type ResolvedChatTurnRoutesOptions } from './route-storage'
import { createDefaultChatBackend, type ChatTurnDefaultBackend } from './default-backend'
import { createChatPrewarm } from './route-prewarm'
import { cancelChatTurn } from './cancellation'
import { forwardTurnToHost, type TurnHost } from '../turn-stream/adapters'
import type { TurnHostControlNamespace } from '../turn-stream/cancellation'
import { turnControlResponse } from './turn-event-stream'
import { startTurnIntentLine } from './turn-intent'

export * from './turn-route-contracts'

async function parseTurn(request: Request, trace: TurnTrace): Promise<ParsedTurnBody | Response> {
  const parse = trace.start('admission.parse', 'admission')
  const [rawBody, badBody] = await parseJsonObjectBody(request)
  if (badBody) return badBody
  let parsed: ParsedTurnBody
  try {
    parsed = validateTurnBody(rawBody)
  } catch (err) {
    if (err instanceof ChatTurnInputError) return errorResponse(err)
    throw err
  }
  parse.end()
  return parsed
}

/** Parse once, then authorize execution; early host identity never replaces this gate. */
async function admitTurn<TContext, TResource>(
  request: Request, trace: TurnTrace, options: CreateChatTurnRoutesOptions<TContext, TResource>,
  waitUntil: ChatTurnRequestContext['waitUntil'], parsedBody?: ParsedTurnBody,
): Promise<({ ok: true } & AdmittedTurn<TContext>) | { ok: false; response: Response }> {
  const parsed = parsedBody ?? await parseTurn(request, trace)
  if (parsed instanceof Response) return { ok: false, response: parsed }
  const prefetch = options.prefetch && startTurnPrefetch(options.prefetch, { request, body: parsed.payload, trace })
  let handedOff = false
  try {
    const auth = await trace.measure('admission.authorize', 'admission', (span) => options.authorize({ request, waitUntil, intent: 'turn', body: parsed.payload, trace, span, ...(prefetch ? { identified: prefetch.identified } : {}) }))
    if (!auth.ok) return { ok: false, response: auth.response }
    if (!('context' in auth) || (auth.intent !== undefined && auth.intent !== 'turn')) {
      return { ok: false, response: Response.json({ error: 'Authorization did not allow this turn.', code: 'chat_authorization_intent_mismatch' }, { status: 403 }) }
    }
    // Check the named model before side effects; the producer checks the unnamed model.
    const refusal = await namedModelRefusal(options.modelPolicy, parsed.payload, trace)
    if (refusal) return { ok: false, response: refusal }
    const admitted = { ok: true as const, parsed, auth, trace, ...(prefetch ? { prefetched: prefetch.admitted(auth) } : {}) }
    handedOff = true
    return admitted
  } finally {
    // Refusals and thrown admission errors both abandon the read-only work.
    if (!handedOff) prefetch?.discard()
  }
}


/** Build chat turn routes to handle and validate incoming chat requests with optional logging */
export function createChatTurnRoutes<TContext = void, TResource = unknown>(
  input: CreateChatTurnRoutesOptions<TContext, TResource>,
): ChatTurnRoutes {
  const produce = input.produce
  const backend = typeof produce === 'function' || (produce && 'router' in produce && typeof produce.router === 'function') ? undefined
    : createDefaultChatBackend<TContext, TResource>(input.projectId, input.env ?? {}, produce as ChatTurnDefaultBackend<TContext, TResource> | undefined ?? {}, turnStorageBindings(input), input.modelPolicy)
  const options: ResolvedChatTurnRoutesOptions<TContext, TResource> = {
    ...input, ...resolveTurnStorage(input), produce: backend ?? produce as ResolvedChatTurnRoutesOptions<TContext, TResource>['produce'],
  }
  const log = options.log ?? ((message, meta) => console.error(message, meta ?? ''))

  // A patch-capable store always keeps durable in-flight history on the shared cadence.
  const draftStore: AssistantDraftStore = options.store
  const draftTuning: DraftPersistenceTuning | null = storeSupportsDraftPersistence(draftStore) ? {} : null

  const progressMessages: Record<TurnRoutePhase, string> = { ...TURN_ROUTE_PHASE_MESSAGES, ...options.progressMessages }

  // Every turn's trace goes to Intelligence unless the product turns it off (`turnTrace: false`).
  const traceOptions = options.turnTrace === false ? undefined : options.turnTrace
  const traceSink: TurnTraceSink | undefined = options.turnTrace === false
    ? undefined
    : (traceOptions?.sink ?? createIntelligenceTurnTraceSink({ project: options.projectId }))

  const startIntentLine = (admitted: AdmittedTurn<TContext>, stop?: AbortSignal) => startTurnIntentLine(options, log, admitted, stop)
  const runAdmittedTurn = createAdmittedTurnRunner({
    options, draftStore, draftTuning, progressMessages, traceOptions, traceSink, startIntentLine, log,
  })
  // A hosted turn's object is placed with the turn lock's channel unless the host names a place.
  const turnHost = input.turnHost && { locationHint: turnStorageBindings(input)?.region, ...input.turnHost }

  /** Run the turn in a new turn-stream object. An object that cannot be reached leaves the turn to this request, as
   *  without `turnHost`; a throw from the turn's own code in the object stays a throw, as it would be here. */
  async function hostTurn(host: TurnHost, request: Request, ctx?: ChatTurnRequestContext): Promise<Response> {
    try {
      const response = await forwardTurnToHost(host, request.clone())
      void request.body?.cancel().catch(() => {})
      return response
    } catch (err) {
      if ((err as { remote?: unknown } | null)?.remote === true) throw err
      // No second execution owner after the opt-in host might have published H.
      if (request.headers.get(TURN_HOST_CONTROL_HEADER) === TURN_HOST_CONTROL_FIRST) {
        return Response.json({ error: 'The turn host is unavailable.', code: 'turn_control_unavailable' }, { status: 503 })
      }
      log('[chat-routes] turn host unavailable; the turn runs in this request', {
        class: 'turn_host_unavailable', error: err instanceof Error ? err.name : typeof err })
      return withD1QueryCount(() => turn(request, ctx))
    }
  }

  async function turn(request: Request, ctx?: ChatTurnRequestContext): Promise<Response> {
    // Parsing and authorization finish before any response opens, for both
    // shapes: a refusal is always a plain HTTP response that reveals nothing
    // beyond what it says, and nothing runs for a caller who is not admitted.
    // The turn's clock starts at the request, so admission is inside its trace.
    const requestContext = ctx?.waitUntil ? { ...ctx, waitUntil: ctx.waitUntil.bind(ctx) } : ctx
    const trace = createTurnTrace({ d1QueryCounter: currentD1QueryCounter() })
    if (request.headers.get(TURN_HOST_CONTROL_HEADER) === TURN_HOST_CONTROL_FIRST) {
      const control = requestContext?.hosted && requestContext.hostControl
      if (!options.authorizeHostControl) {
        return Response.json({ error: 'Early hosted control is unavailable.', code: 'turn_control_unavailable' }, { status: 503 })
      }
      const parsed = await parseTurn(request, trace)
      if (parsed instanceof Response) return parsed
      const identity = await options.authorizeHostControl({ request, body: parsed.payload })
      if (!identity.ok) return identity.response
      if (!control) return Response.json({ error: 'The turn host is unavailable.', code: 'turn_control_unavailable' }, { status: 503 })
      const namespace = turnHost?.namespace as TurnHostControlNamespace | undefined
      if (!namespace || typeof namespace.idFromString !== 'function') {
        return Response.json({ error: 'The host control binding is unavailable.', code: 'turn_control_unavailable' }, { status: 503 })
      }
      if (!identity.tenantId.trim()) return new Response('Invalid control identity', { status: 403 })
      const target: TurnHostControlTarget = { hostId: control.hostId, workspaceId: identity.tenantId,
        threadId: parsed.payload.threadId, ...(parsed.payload.turnId ? { clientTurnId: parsed.payload.turnId } : {}),
        ...(parsed.payload.retryAttemptId ? { retryAttemptId: parsed.payload.retryAttemptId } : {}) }
      await control.bind(target, { namespace, auth: turnHost!.auth })
      const admission = admitTurn(request, trace, options, requestContext?.waitUntil, parsed)
        .then(result => result.ok ? result : result.response)
      return progressFirstTurn(request, requestContext, admission, target)
    }
    const admitted = await admitTurn(request, trace, options, requestContext?.waitUntil)
    if (!admitted.ok) return admitted.response
    if (request.headers.get(TURN_PROGRESS_HEADER) !== TURN_PROGRESS_FIRST) return runTurn(request, requestContext, admitted)
    return progressFirstTurn(request, requestContext, admitted)
  }


  /**
   * Open the response stream as soon as the caller is admitted, so the client
   * shows the turn's real stage while the conversation loads, the lock is
   * taken and the product's pre-turn work runs. The turn runs exactly as
   * {@link runTurn} does; its stream is piped through, and any other response
   * it returns after admission (a held lock, a gate's answer, a handoff, a
   * failure) becomes one `turn.response` event that `settleTurnResponse` turns
   * back into that response on the client.
   */
  function progressFirstTurn(request: Request, ctx: ChatTurnRequestContext | undefined,
    admission: AdmittedTurn<TContext> | Promise<AdmittedTurn<TContext> | Response>, control?: TurnHostControlTarget,
  ): Response {
    const receivedAt = Date.now()
    const encoder = new TextEncoder()
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    let clientGone = false
    const write = async (chunk: Uint8Array): Promise<void> => {
      if (clientGone) return
      try {
        await writer.write(chunk)
      } catch {
        clientGone = true
      }
    }
    const writeEvent = (event: ChatRouteEvent): Promise<void> => write(encoder.encode(`${JSON.stringify(event)}\n`))
    const progress: TurnProgressCallback = (phase, message) => {
      void writeEvent(buildTurnPhaseEvent(phase, message, { sinceRequestMs: Date.now() - receivedAt }))
    }
    if (control) void writeEvent({ type: TURN_HOST_CONTROL_EVENT, data: { ...control } })
    let piping = false
    let atLineStart = true
    let pendingIntent: TurnIntentEvent | null = null

    const pump = (async () => {
      let inner: Response
      try {
        const admitted = await admission
        if (admitted instanceof Response) inner = admitted
        else if (control && admitted.auth.tenantId !== control.workspaceId) inner = new Response('Control identity changed', { status: 403 })
        else if (ctx?.hostControl?.signal.aborted) inner = turnControlResponse(ctx.hostControl.signal)
        else {
          progress('accepted', progressMessages.accepted)
          // Intent is execution work: never start it before full admission/Stop gate.
          const intent = startIntentLine(admitted, ctx?.hostControl?.signal)
          if (intent) void intent.then(text => {
            if (!text || clientGone) return
            const event: TurnIntentEvent = { type: TURN_INTENT_EVENT, data: { text, sinceRequestMs: Date.now() - receivedAt } }
            if (!piping || atLineStart) void writeEvent(event)
            else pendingIntent = event
          })
          inner = await runTurn(request, ctx, admitted, progress, intent)
        }
      } catch (err) {
        log('[chat-routes] turn failed before it streamed', { error: err instanceof Error ? err.message : String(err) })
        inner = ctx?.hostControl?.signal.aborted && err === ctx.hostControl.signal.reason
          ? turnControlResponse(ctx.hostControl.signal) : err instanceof Response ? err
          : Response.json({ error: 'The turn failed before it started. Try again.' }, { status: 500 })
      }
      if (!inner.body || !inner.headers.get('x-turn-id')) {
        await writeEvent(await turnResponseEventFor(inner))
      } else {
        const reader = inner.body.getReader()
        piping = true
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            atLineStart = value.length > 0 && value[value.length - 1] === 0x0a
            await write(value)
            if (atLineStart && pendingIntent) {
              const event = pendingIntent
              pendingIntent = null
              await writeEvent(event)
            }
            if (clientGone) {
              // The turn keeps running under its own drain; only this view stops.
              await reader.cancel().catch(() => {})
              break
            }
          }
        } catch (err) {
          log('[chat-routes] progress-first pipe failed', { error: err instanceof Error ? err.message : String(err) })
        }
      }
      if (!clientGone) await writer.close().catch(() => {})
    })()
    if (ctx?.waitUntil) ctx.waitUntil(pump)
    else void pump.catch(() => {})

    return new Response(readable, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        [TURN_PROGRESS_HEADER]: TURN_PROGRESS_FIRST,
        ...(control ? { [TURN_HOST_CONTROL_HEADER]: TURN_HOST_CONTROL_FIRST } : {}),
      },
    })
  }

  /** Start the product's `afterAuthorize` work for an admitted turn. Never throws. */
  function startAfterAuthorize(request: Request, admitted: AdmittedTurn<TContext>, waitUntil: ChatTurnRequestContext['waitUntil']): AfterAuthorizeWork<TResource> {
    let release: ChatTurnAfterAuthorizeRelease<TResource> | undefined
    const { parsed, auth, trace } = admitted
    if (options.afterAuthorize) {
      try {
        const started = options.afterAuthorize({
          request,
          waitUntil,
          body: parsed.payload,
          tenantId: auth.tenantId,
          userId: auth.userId,
          threadId: parsed.payload.threadId,
          context: auth.context,
          trace,
        })
        if (started) release = started
      } catch (err) {
        log('[chat-routes] afterAuthorize failed; the turn goes on without it', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    return earlyTurnWork(release, log)
  }

  /** Run an admitted turn with the product's `afterAuthorize` work started first and freed if no producer takes it. */
  async function runTurn(
    request: Request,
    ctx: ChatTurnRequestContext | undefined,
    admitted: AdmittedTurn<TContext>,
    progress?: TurnProgressCallback,
    startedIntent?: Promise<string | null>,
  ): Promise<Response> {
    if (ctx?.hostControl?.signal.aborted) return turnControlResponse(ctx.hostControl.signal)
    const early = startAfterAuthorize(request, admitted, ctx?.waitUntil)
    try {
      return await runAdmittedTurn(request, ctx, admitted, early, progress, startedIntent)
    } finally {
      // A held lock, a changed history, a gate's answer, a handoff or a throw ends the turn without `produce`. The response
      // does not wait for the product to free what it started.
      const freed = early.release()
      if (ctx?.waitUntil) ctx.waitUntil(freed)
      else void freed
    }
  }

  async function replay(request: Request, params: { turnId: string }): Promise<Response> {
    const turnId = params.turnId?.trim()
    if (!turnId) return Response.json({ error: 'Missing turnId' }, { status: 400 })
    const auth = await options.authorize({ request, intent: 'replay', turnId })
    if (!auth.ok) return auth.response
    if (auth.intent !== undefined && auth.intent !== 'replay') {
      return Response.json({ error: 'Authorization did not allow this replay.', code: 'chat_authorization_intent_mismatch' }, { status: 403 })
    }

    const fromSeqRaw = new URL(request.url).searchParams.get('fromSeq')
    const fromSeq = fromSeqRaw ? Math.max(0, Math.trunc(Number(fromSeqRaw)) || 0) : 0

    const encoder = new TextEncoder()
    const events = replayTurnEvents({
      store: options.turnStore,
      turnId,
      fromSeq,
    })
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await events.next()
        if (done) {
          controller.close()
          return
        }
        // Stamp the buffer ordinal so a reconnecting client resumes from
        // `?fromSeq=<lastSeq>` instead of refetching the turn from 0 and
        // re-applying every delta onto already-rendered state.
        controller.enqueue(encoder.encode(`${stampReplaySeq(value)}\n`))
      },
      cancel() {
        void events.return(undefined)
      },
    })
    return new Response(body, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
      },
    })
  }

  async function running(request: Request): Promise<Response> {
    const threadId = new URL(request.url).searchParams.get('threadId')?.trim()
    if (!threadId) return Response.json({ error: 'Missing threadId' }, { status: 400 })
    const auth = await options.authorize({ request, intent: 'running', threadId })
    if (!auth.ok) return auth.response
    if (auth.intent !== undefined && auth.intent !== 'running') {
      return Response.json({ error: 'Authorization did not allow this running-turn read.', code: 'chat_authorization_intent_mismatch' }, { status: 403 })
    }
    // `listRunning` is optional on the store; a store that cannot enumerate
    // running turns simply reports none — the client falls back to the persisted
    // transcript, never to a hang.
    const ids = (await options.turnStore.listRunning?.(threadId)) ?? []
    return Response.json({ running: ids })
  }

  return {
    prewarm: createChatPrewarm(input, backend?.prewarm),
    // A request with no credential runs here, where `authorize` refuses it, so it never costs an object.
    turn: (request, ctx) => turnHost && !ctx?.hosted && ctx?.executionLimits === undefined && ctx?.cancelOnDisconnect !== true
      && (request.headers.has('cookie') || request.headers.has('authorization'))
      ? hostTurn(turnHost, request, ctx) : withD1QueryCount(() => turn(request, ctx)),
    cancel: request => cancelChatTurn(request, { authorize: options.authorize, cancel: options.cancel, log }),
    replay,
    running,
    interactions: options.interactions ? createInteractionAnswerRoute(options.interactions) : null,
  }
}
