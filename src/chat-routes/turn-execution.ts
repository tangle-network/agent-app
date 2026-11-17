/** Admission-to-settlement execution for one authenticated chat turn. */
import { deriveExecutionId, handleChatTurn, type ChatTurnIdentity } from '@tangle-network/agent-runtime/durable'
import { toChatMessageParts } from '../chat-store/parts'
import { redactEvents, valueRedactor, type ValueRedactor } from './redact-values'
import {
  coalesceDeltas,
  createBufferedTurnTap,
  resolveChatTurn,
  type BufferedTurnTap,
  type PersistedChatMessageForTurn,
} from '../stream/index'
import type { TurnTraceSink, TurnTraceSnapshot } from '../turn-trace/recorder'
import { createNativeTimingTransfer, type NativeTimingTransfer } from './native-turn-timing'
import { createChatTurnOwnership } from './turn-ownership'
import {
  assistantRowIdForTurn,
  createAssistantDraftWriter,
  rowIdOf,
  type AssistantDraftStore,
  type AssistantDraftWriter,
  type DraftPersistenceTuning,
} from './draft-persistence'
import { dispatchFirstFor, selectTurnProducer } from './dispatch-first'
import { observeTurnCancellation } from './cancellation'
import { admissionServerTiming, errorResponse, userPartsWithFiles, type AdmittedTurn, type TurnProgressCallback } from './turn-admission'
import {
  abortOnSignal, concatStreams, failureCodeOf, failureReasonOf, isVisibleOutput, isVisibleText, serverFailureData, tapRawEvents,
  withStreamHeartbeat,
} from './turn-event-stream'
import type {
  ChatTurnLifecycleComplete,
  ChatTurnProduceArgs,
  ChatTurnRequestContext,
  ChatTurnRouteProducer,
  ChatTurnTraceOptions,
  ChatRouteEvent,
  CreateChatTurnRoutesOptions,
} from './turn-route-contracts'
import type { TurnRoutePhase } from './turn-progress'
import { ChatTurnInputError, type ChatTurnPartInput } from './wire'
import { addressAgents, composeAgentProducers } from './agent-producers'
import { measuredUsage } from './sandbox-turn-usage'
import type { ResolvedChatTurnRoutesOptions } from './route-storage'
import type { AfterAuthorizeWork } from './early-turn-work'
import { transformVisibleTextParts } from './visible-text'
import { createTurnSettlement, modelAttributionFields } from './turn-settlement'

/** The thread's messages as the turn-identity resolver reads them. */
async function readTurnHistory(store: CreateChatTurnRoutesOptions<unknown>['store'], threadId: string): Promise<PersistedChatMessageForTurn[]> {
  return (await store.listMessages(threadId)).map((m) => ({
    id: m.id, role: m.role, content: m.content, parts: (m.parts ?? null) as PersistedChatMessageForTurn['parts'],
  }))
}

interface TurnExecutionOptions<TContext, TResource> {
  options: ResolvedChatTurnRoutesOptions<TContext, TResource>
  draftStore: AssistantDraftStore
  draftTuning: DraftPersistenceTuning | null
  progressMessages: Record<TurnRoutePhase, string>
  traceOptions: ChatTurnTraceOptions<TContext> | undefined
  traceSink: TurnTraceSink | undefined
  startIntentLine(admitted: AdmittedTurn<TContext>, stop?: AbortSignal): Promise<string | null> | undefined
  log(message: string, meta?: Record<string, unknown>): void
}

/** Bind the route's construction-time dependencies; each invocation retains its own turn state. */
export function createAdmittedTurnRunner<TContext, TResource>(dependencies: TurnExecutionOptions<TContext, TResource>) {
  return (runAdmittedTurn<TContext, TResource>).bind(null, dependencies)
}

async function runAdmittedTurn<TContext, TResource>({
  options, draftStore, draftTuning, progressMessages, traceOptions, traceSink, startIntentLine, log,
}: TurnExecutionOptions<TContext, TResource>,
  request: Request,
  ctx: ChatTurnRequestContext | undefined,
  admitted: AdmittedTurn<TContext>,
  early: AfterAuthorizeWork<TResource>,
  progress?: TurnProgressCallback,
  startedIntent?: Promise<string | null>,
): Promise<Response> {
  const { parsed, auth, trace } = admitted
  const hostStop = ctx?.hostControl?.signal
  hostStop?.throwIfAborted()
  // A progress-first turn started its line at admission; any other starts it here.
  const intentLine = startedIntent ?? startIntentLine(admitted, ctx?.hostControl?.signal)
  const { payload, content, fileParts, mentions, turnId } = parsed
  const { tenantId, userId, context } = auth

  const preparedBatch = await prepareAdmittedTurn(options, trace, log, tenantId, userId, payload, context, request, progress, content, turnId, draftTuning, ctx?.waitUntil)
  if (preparedBatch instanceof Response) return preparedBatch
  hostStop?.throwIfAborted()
  const { turnStreamId, identity, executionId, chatTurn, readHistory, historyBeforeLock } = preparedBatch
  // Registered secret values never reach the stream, the buffer, the draft or the stored row (redact-values.ts).
  const redact = options.redactValues ? valueRedactor(await options.redactValues({ tenantId, userId, threadId: payload.threadId })) : undefined
  hostStop?.throwIfAborted()

  const prompt: string | ChatTurnPartInput[] =
    fileParts.length === 0
      ? content
      : content
        ? [{ type: 'text', text: content }, ...fileParts]
        : [...fileParts]

  // The producer input every pre-turn seam reads. Replaced — never mutated
  // in place — as later steps resolve more of it (`userMessageId` after the
  // insert, `beforeTurn`'s patch after that), so a seam that captured the
  // object never sees it change underneath. `produce` reads the last
  // version because the engine defers its first pull.
  // A product calls this only after it has durably registered the external
  // completion owner and before it dispatches native execution. Keeping the
  // public field optional preserves existing synthetic producers; this
  // assembled route always supplies it to the real `produce` invocation.
  const state = createAdmittedTurnState<TContext>()
  if (options.cancel || ctx?.hostControl) state.cancellationAbort = new AbortController()
  if (hostStop) {
    const abort = () => state.cancellationAbort!.abort(hostStop.reason)
    if (hostStop.aborted) abort()
    else hostStop.addEventListener('abort', abort, { once: true })
  }

  state.nativeTiming = createNativeTimingTransfer(() => ({
    turnStreamId, requestReceivedAt: trace.startedAt,
    ...(state.turnStarted ? { lifecycleStartedAt: state.turnStartedAtMs, admissionMs: state.turnStartedAtMs - trace.startedAt } : {}),
    ...(state.firstVisibleAtMs === undefined ? {} : { firstVisibleMs: state.firstVisibleAtMs - state.turnStartedAtMs }),
    ...(state.firstTextAtMs === undefined ? {} : { firstTextMs: state.firstTextAtMs - state.turnStartedAtMs }),
  }), error => log('[chat-routes] native timing persistence failed', { turnId: turnStreamId,
    error: error instanceof Error ? error.message : String(error) }))
  const { handoffCompletion, releaseLock, markRunning, stopRenewal, releaseBeforeDrain } =
    createChatTurnOwnership(state, log, turnStreamId, options, payload.threadId)

  let produceArgs: ChatTurnProduceArgs<TContext, TResource> = {
    lock: () => state.lockHandle,
    request,
    waitUntil: ctx?.waitUntil,
    earlyResource: early.resource,
    admissionSignal: AbortSignal.any([
      state.executionAbort.signal,
      ...(state.cancellationAbort ? [state.cancellationAbort.signal] : []),
      ...(ctx?.cancelOnDisconnect ? [request.signal] : []),
    ]),
    body: payload,
    identity,
    context,
    prompt,
    executionId,
    turnStreamId,
    priorMessages: chatTurn.priorMessages, ...(chatTurn.reusedUserMessageId ? { userMessageId: chatTurn.reusedUserMessageId, userMessageInserted: false } : {}),
    handoffCompletion,
    timingFacts: state.nativeTiming.snapshot,
    trace,
    ...(intentLine ? { intentLine } : {}), ...(admitted.prefetched ? { prefetched: admitted.prefetched } : {}),
    ...(ctx?.executionLimits ? { executionLimits: ctx.executionLimits } : {}),
  }
  // Responders named from the product's own catalog, before any lock, row or model call.
  const addressed = await addressAgents({ options, mentions, identity, context, produceArgs, trace })
  if (addressed instanceof Response) return addressed
  hostStop?.throwIfAborted()
  produceArgs = addressed
  const { endTrace, exportTraceInBackground, startLifecycle, fireTerminalLifecycle, assistantRowId, exportTrace, runAfterSettle } = createTurnSettlement(state, trace, options, executionId, traceSink, identity, traceOptions, context, turnStreamId, log, ctx, () => produceArgs.userMessageId)

  try {
    const selected = selectTurnProducer(options.produce, produceArgs)
    hostStop?.throwIfAborted()
    // Responders answer one after another, so nothing starts before the lock.
    const dispatched = produceArgs.agents ? undefined : dispatchFirstFor(selected, produceArgs, trace)
    if (dispatched) early.add(dispatched.refuse)
    const turnLock = options.turnLock
    if (turnLock) {
      const acquired = await trace.measure('admission.lock', 'admission', () => {
        hostStop?.throwIfAborted()
        return turnLock.acquire(produceArgs)
      })
      if (!acquired.acquired) return acquired.response
      state.lockAcquired = true
      state.lockHandle = acquired.handle
      if (acquired.cancellation) {
        const cancellation = acquired.cancellation
        const abort = () => state.executionAbort.abort(cancellation.signal.reason)
        if (cancellation.signal.aborted) abort()
        else cancellation.signal.addEventListener('abort', abort, { once: true })
        state.closeCancellation = async () => {
          cancellation.signal.removeEventListener('abort', abort)
          await cancellation.close()
        }
      }
    }
    // An acquire already in flight may finish after Stop; retain its exact handle
    // and cancellation connection before the existing catch closes/releases it.
    hostStop?.throwIfAborted()
    progress?.('preparing', progressMessages.preparing)
    // The running row is written beside the history recheck, inside its span.
    const [history] = state.lockAcquired
      ? await trace.measure('admission.history_recheck', 'admission', () => {
        hostStop?.throwIfAborted()
        return Promise.all([readHistory(), markRunning()])
      }) : []
    hostStop?.throwIfAborted()
    if (state.lockAcquired && JSON.stringify(history) !== historyBeforeLock) {
      await releaseBeforeDrain('error')
      return Response.json({
        code: 'chat_history_changed',
        error: 'The conversation changed while this turn was acquiring its lock. Refresh the conversation before starting new work.',
      }, { status: 409 })
    }
    // The product (via `authorize`) may suppress the user-row insert for a
    // dispatched/synthetic turn. AND-composition: it can only subtract, never
    // resurrect a turn the engine already deduped as a retry.
    const insertUserMessage = chatTurn.shouldInsertUserMessage && (auth.insertUserMessage ?? true)
    // Name the row this turn is anchored to. Insert and reuse are mutually
    // exclusive (`shouldInsertUserMessage` is false exactly when a reusable
    // row was found), so one source or the other — never both, never a
    // guess. Products used to re-derive this by decorating the store and
    // falling back to the newest row, which mis-resolves under sub-second
    // same-thread turns.
    let userMessageId: string | null = chatTurn.reusedUserMessageId ?? null
    let userMessageInserted = false
    if (insertUserMessage) {
      userMessageId = rowIdOf(
        await trace.measure('admission.persist_user', 'admission', () => {
          hostStop?.throwIfAborted()
          return options.store.appendMessage({
            threadId: payload.threadId,
            role: 'user',
            content,
            parts: userPartsWithFiles(chatTurn.userParts, fileParts, mentions),
          })
        }),
      )
      userMessageInserted = userMessageId !== null
    }
    produceArgs = { ...produceArgs, userMessageId, userMessageInserted }
    hostStop?.throwIfAborted()

    // Domain-readiness gate: may short-circuit with the product's own
    // response before the producer runs. The user row above is kept (a real
    // user turn); the gate's response is the assistant side of it.
    const contextGate = options.contextGate
    if (contextGate) {
      const gate = await trace.measure('admission.gate', 'admission', () => contextGate(produceArgs))
      if (gate.proceed === 'handoff') {
        await releaseBeforeDrain('handoff')
        state.legacyHandoff = true
        endTrace(false, undefined)
        exportTraceInBackground()
        return gate.response
      }
      if (!gate.proceed) {
        await releaseBeforeDrain('complete')
        if (state.completionHandoff) {
          endTrace(false, undefined)
          exportTraceInBackground()
          return gate.response
        }
        // A gate still reports its lifecycle; no model billing/persistence hook runs.
        const lifecycleStarted = startLifecycle(true)
        if (lifecycleStarted) await lifecycleStarted
        await fireTerminalLifecycle(false, undefined)
        exportTraceInBackground()
        return gate.response
      }
    }

    // Observe + optionally augment the assembled producer input.
    hostStop?.throwIfAborted()
    const beforeTurn = options.beforeTurn
    if (beforeTurn) {
      const patch = await trace.measure('admission.before_turn', 'admission', (span) => beforeTurn(produceArgs, { span }))
      if (patch && Object.keys(patch).length && dispatched) throw new Error('beforeTurn cannot patch a Router turn already dispatched: its prompt is already sent')
      if (patch) produceArgs = { ...produceArgs, ...patch }
    }
    hostStop?.throwIfAborted()
    const streamSetup = trace.start('admission.stream_setup', 'admission')

    // Durability tap: every engine event buffers (coalesced) so a dropped
    // client replays the tail. Live delivery rides the Response body, not the
    // tap, so `write` is intentionally absent.
    state.tap = createBufferedTurnTap({
      store: options.turnStore,
      turnId: turnStreamId,
      scopeId: payload.threadId,
      coalesce: coalesceDeltas,
    })
    const turnMarker = { type: 'turn', turnId: turnStreamId }
    await state.tap.onEvent(turnMarker)
    await stopRenewal() // the tap renews the running row from here
    if (state.completionHandoff) await state.tap!.detach()

    // Durable projection: the turn buffer above serves LIVE reconnect; this
    // keeps the persisted transcript at most one cadence interval behind, so
    // a viewer arriving after the buffer's (deliberately short) hot window
    // reads the in-flight answer from storage instead of an empty thread.
    // Row identity is the turn's own `executionId`, so a re-entered turn
    // patches the row a previous attempt started instead of duplicating it.
    if (draftTuning) {
      state.draft = createAssistantDraftWriter({
        ...draftTuning,
        store: draftStore,
        threadId: payload.threadId,
        messageId: assistantRowIdForTurn(executionId),
        snapshot: () => {
          if (!state.producer || state.cancellationAbort?.signal.aborted) return null
          const snapshot = {
            content: state.producer.finalText(),
            ...(state.producer.draftParts ? { parts: state.producer.draftParts() } : {}),
            ...(state.producer.usage ? { usage: state.producer.usage() } : {}),
            ...(state.producer.model ? { model: state.producer.model } : {}),
          }
          return redact ? redact(snapshot) : snapshot
        },
        ...(options.transformFinalText ? { transformText: options.transformFinalText } : {}),
        log,
      })
      // `contextGate` / `beforeTurn` may have handed ownership off before
      // the writer existed. Close this late-created writer immediately so it
      // cannot receive a later live event.
      if (state.completionHandoff) await state.draft.close()
    }

    const lifecycleStarted = startLifecycle()
    if (lifecycleStarted) await lifecycleStarted
    streamSetup.end()

    hostStop?.throwIfAborted()

    const { result } = createTurnEngine(identity, ctx, log, state, dispatched, produceArgs, trace, options, selected.produce, request, context, payload, assistantRowId, redact)

    // The engine has the turn, and its first pull runs `produce`, which owns whatever `afterAuthorize` started.
    const { clientBody } = startTurnDrain(result, log, turnStreamId, state, endTrace, exportTrace, trace, ctx, request, fireTerminalLifecycle, releaseLock, runAfterSettle, early.settle)
    early.handOff()

    return createTurnReplayResponse(result.contentType, clientBody, turnMarker, trace)
  } catch (err) {
    // A throw before the turn began streaming (selection/acquire, user-insert, gate, beforeTurn,
    // lifecycle-start, tap setup, engine construction, tee). If the turn had
    // already started, settle the lifecycle with `onTurnError` (close the
    // span) — the drain never ran to do it. Then release the lock, propagate.
    if (!state.completionHandoff) {
      if (state.turnStarted) await fireTerminalLifecycle(true, err)
      await releaseBeforeDrain('error')
    }
    // A turn that failed before it started, or after a durable owner took it, still ends its trace here.
    endTrace(true, err)
    exportTraceInBackground()
    throw err
  }
}
export interface AdmittedTurnState<TContext> {
  executionAbort: AbortController
  closeCancellation: (() => Promise<void>) | undefined
  draft: AssistantDraftWriter | undefined
  tap: BufferedTurnTap | undefined
  nativeTiming: NativeTimingTransfer | undefined
  completionHandoff: boolean
  completionHandoffPromise: Promise<void> | undefined
  lockAcquired: boolean
  lockHandle: unknown
  lockReleased: boolean
  cancellationAbort?: AbortController
  producer: ChatTurnRouteProducer | undefined
  producerError: unknown
  assistantMessageId: string | null | undefined
  runFailed: boolean
  lastFailureData: Record<string, unknown> | undefined
  turnStartedAtMs: number
  firstVisibleAtMs: number | undefined
  firstTextAtMs: number | undefined
  turnStarted: boolean
  lifecycleSettled: boolean
  settledTurn: ChatTurnLifecycleComplete<TContext> | undefined
  gatedTurn: boolean
  legacyHandoff: boolean
  pendingTraceExport: (() => void | Promise<void>) | undefined
  traceEnded: boolean
}

function createAdmittedTurnState<TContext>(): AdmittedTurnState<TContext> {
  return {
    executionAbort: new AbortController(), closeCancellation: undefined,
    draft: undefined,
    tap: undefined,
    nativeTiming: undefined,
    completionHandoff: false,
    completionHandoffPromise: undefined,
    lockAcquired: false,
    lockHandle: undefined,
    lockReleased: false,
    producer: undefined,
    producerError: undefined,
    assistantMessageId: undefined,
    runFailed: false,
    lastFailureData: undefined,
    turnStartedAtMs: 0,
    firstVisibleAtMs: undefined,
    firstTextAtMs: undefined,
    turnStarted: false,
    lifecycleSettled: false,
    settledTurn: undefined,
    gatedTurn: false,
    legacyHandoff: false,
    pendingTraceExport: undefined,
    traceEnded: false,
  }
}

async function prepareAdmittedTurn<TContext, TResource>(
  options: TurnExecutionOptions<TContext, TResource>['options'],
  trace: AdmittedTurn<TContext>['trace'],
  log: (message: string, meta?: Record<string, unknown>) => void,
  tenantId: string,
  userId: string,
  payload: AdmittedTurn<TContext>['parsed']['payload'],
  context: TContext,
  request: Request,
  progress: TurnProgressCallback | undefined,
  content: string,
  turnId: string | undefined,
  draftTuning: TurnExecutionOptions<TContext, TResource>['draftTuning'],
  waitUntil: ChatTurnRequestContext['waitUntil'],
) {
  if (options.turnLock?.warm) {
    // Overlaps the lock's first-use cost with prepareTurn and the history read.
    // Its span shows that cost: waking the workspace channel that holds the lock.
    const warmSpan = trace.start('admission.lock_warm', 'admission')
    const warmFailed = (err: unknown) => {
      warmSpan.end(undefined, err)
      log('[chat-routes] turnLock.warm failed', { error: err instanceof Error ? err.message : String(err) })
    }
    try {
      void Promise.resolve(options.turnLock.warm({ tenantId, userId, threadId: payload.threadId, context })).then(() => warmSpan.end(), warmFailed)
    } catch (err) {
      warmFailed(err)
    }
  }

  const prepareTurn = options.prepareTurn
  if (prepareTurn) {
    const prepared = await trace.measure('admission.prepare', 'admission', () => prepareTurn({
      request,
      waitUntil,
      body: payload,
      tenantId,
      userId,
      threadId: payload.threadId,
      context,
      progress: (phase, message) => progress?.(phase, message),
    }))
    if (!prepared.ok) return prepared.response
  }

  // Turn identity: reuse the just-persisted user row on a retry (same
  // turnId or identical trailing content) instead of double-inserting.
  const readHistory = () => readTurnHistory(options.store, payload.threadId)
  const historySpan = trace.start('admission.history', 'admission')
  const existingMessages = await readHistory()
  // Lock acquisition is async and follows identity derivation. A previous
  // owner can settle in that gap; the new owner must not dispatch an identity
  // or prompt derived from the old history. Capture values now, including
  // parts, rather than retaining mutable message references across the lock.
  const historyBeforeLock = options.turnLock ? JSON.stringify(existingMessages) : undefined
  // An assistant row already trailing the thread is either this turn's
  // in-flight draft (retry — walk past it) or a settled answer (a genuine
  // repeat — new turn). The turn buffer's running index is the discriminator;
  // it is only consulted in the one case that can be ambiguous, so the common
  // path costs nothing.
  //
  // The probe can only change the answer when the running reading would
  // reuse a row (no client turnId, and the user row behind the trailing
  // assistant rows repeats this content); the settled reading never reuses
  // past a trailing assistant row. Every other turn, including each ordinary
  // follow-up, skips the round trip with an identical result.
  let chatTurn = resolveChatTurn({ existingMessages, userContent: content, turnId, hasRunningTurn: false })
  if (draftTuning && existingMessages.at(-1)?.role === 'assistant') {
    const ifRunning = resolveChatTurn({ existingMessages, userContent: content, turnId, hasRunningTurn: true })
    if (!ifRunning.shouldInsertUserMessage) {
      let hasRunningTurn = false
      try {
        hasRunningTurn = ((await trace.measure('admission.running_probe', 'admission', () => options.turnStore.listRunning?.(payload.threadId), undefined, historySpan)) ?? []).length > 0
      } catch (err) {
        log('[chat-routes] listRunning probe failed; treating the thread as idle', {
          threadId: payload.threadId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (hasRunningTurn) chatTurn = ifRunning
    }
  }
  historySpan.end({ messages: existingMessages.length })

  const identity: ChatTurnIdentity = {
    tenantId,
    sessionId: payload.threadId,
    userId,
    turnIndex: chatTurn.turnIndex,
  }
  const turnExecutionId = deriveExecutionId({
    projectId: options.projectId,
    sessionId: payload.threadId,
    turnIndex: chatTurn.turnIndex,
  })
  // Message identity preserves the original inputs; an explicit retry starts
  // another native execution with its own immutable completion receipt.
  const executionId = payload.retryAttemptId
    ? `${turnExecutionId}:retry:${payload.retryAttemptId}`
    : turnExecutionId
  if (executionId.length > 256) return errorResponse(new ChatTurnInputError('Retry execution id exceeds 256 bytes'))
  // From here the trace's id is the turn's execution id, the id every Router and Sandbox call sends.
  trace.bind(executionId)
  const turnStreamId = crypto.randomUUID()
  return { turnStreamId, identity, executionId, chatTurn, readHistory, historyBeforeLock }
}

function createTurnEngine<TContext, TResource>(
  identity: ChatTurnIdentity,
  ctx: ChatTurnRequestContext | undefined,
  log: (message: string, meta?: Record<string, unknown>) => void,
  state: AdmittedTurnState<TContext>,
  dispatched: ReturnType<typeof dispatchFirstFor<TContext, TResource>>,
  produceArgs: ChatTurnProduceArgs<TContext, TResource>,
  trace: AdmittedTurn<TContext>['trace'],
  options: TurnExecutionOptions<TContext, TResource>['options'],
  produce: ReturnType<typeof selectTurnProducer<TContext, TResource>>['produce'],
  request: Request,
  context: TContext,
  payload: AdmittedTurn<TContext>['parsed']['payload'],
  assistantRowId: () => string | null,
  redact: ValueRedactor | undefined,
) {
  const result = handleChatTurn({
    identity,
    waitUntil: ctx?.waitUntil,
    log,
    hooks: {
      // The engine wants a synchronous producer; box resolution is async —
      // defer it into the generator's first pull.
      produce: () => ({
        stream: (async function* () {
          // The product's own admission work: its profile pin, prompt and producer construction.
          const producerStream = async function* () {
            const started = dispatched
              ? dispatched.take(produceArgs)
              : produceArgs.agents
                ? trace.measure('admission.produce', 'admission', () => composeAgentProducers(produceArgs, produce))
                : trace.measure('admission.produce', 'admission', () => produce(produceArgs))
            if (!dispatched) {
              const cleanup = started.then(producer => producer.cleanup, () => undefined)
              ctx?.waitUntil?.(cleanup)
              void cleanup.catch(() => {})
            }
            state.producer = await started
            yield* state.producer.stream
          }
          let source: AsyncIterable<ChatRouteEvent> = redact ? redactEvents(producerStream(), redact) : producerStream()
          // A durable owner connection already carries exact authenticated Stop.
          // Keep metadata observation only for existing non-adopting targets.
          if (options.cancel && state.cancellationAbort && !state.closeCancellation) {
            source = observeTurnCancellation(source, produceArgs, options.cancel, state.cancellationAbort)
          }
          if (ctx?.cancelOnDisconnect) {
            source = abortOnSignal(source, request.signal)
          }
          if (ctx?.hostControl) source = abortOnSignal(source, ctx.hostControl.signal)
          if (options.onRawEvent) {
            source = tapRawEvents(source, (event) => options.onRawEvent!(event, context), log)
          }
          if (options.heartbeat) {
            source = withStreamHeartbeat(source, options.heartbeat.intervalMs, options.heartbeat.event)
          }
          try { for await (const event of source) yield event }
          catch (error) {
            state.producerError = state.lastFailureData ?? error
            throw error
          }
        })(),
        finalText: () => state.cancellationAbort?.signal.aborted ? '' : state.producer?.finalText() ?? '',
      }),
      onEvent: async (event) => {
        let timingChanged = false
        if (state.firstVisibleAtMs === undefined && isVisibleOutput(event)) {
          state.firstVisibleAtMs = Date.now()
          trace.markFirstVisible(state.firstVisibleAtMs)
          timingChanged = true
        }
        if (state.firstTextAtMs === undefined && isVisibleText(event)) {
          state.firstTextAtMs = Date.now()
          trace.markFirstText(state.firstTextAtMs)
          timingChanged = true
        }
        if (timingChanged) {
          const written = state.nativeTiming?.note()
          if (written && ctx?.waitUntil) ctx.waitUntil(written)
        }
        if (event.type === 'session.run.failed' || event.type === 'error') {
          state.runFailed = true
          state.lastFailureData = serverFailureData(event.data)
        }
        await state.tap!.onEvent(event)
        // Synchronous bookkeeping; the write it may start is fire-and-
        // forget, so store latency never back-pressures the live stream.
        if (!state.completionHandoff) state.draft?.notify(event)
        if (options.onEvent) await options.onEvent(event, context)
      },
      ...(options.transformFinalText ? { transformFinalText: options.transformFinalText } : {}),
      persistAssistantMessage: ({ finalText }) => trace.measure('persist.assistant', 'persist', async () => {
        if (state.completionHandoff) return
        if (state.cancellationAbort?.signal.aborted || (ctx?.cancelOnDisconnect && request.signal.aborted)) {
          await state.draft?.discard()
          state.assistantMessageId = null
          return
        }
        // The typed boundary: stream-normalizer records → stored vocabulary
        // (validating projection owned by /chat-store — no cast here). The
        // scalar `finalText` arrives already transformed by the engine; the
        // producer's text PARTS are raw, so the same transform must run over
        // each text segment before persistence or a redaction (legal PII)
        // leaks at rest through message.parts.
        const rawParts = state.producer?.assistantParts ? state.producer.assistantParts() : undefined
        const projected =
          rawParts && options.transformFinalText
            ? await transformVisibleTextParts(rawParts, options.transformFinalText)
            : rawParts
        const parts = projected ? toChatMessageParts(projected) : undefined
        if (!finalText.trim() && (!parts || parts.length === 0)) {
          // Empty turn: today this leaves no assistant row at all, so a
          // draft row started earlier is retracted, not left behind.
          await state.draft?.discard()
          // Read the writer rather than assuming `null`: `discard` is a
          // no-op on a store without `deleteMessage` (drafting needs only
          // `updateMessage`), and there the draft row genuinely survives.
          state.assistantMessageId = state.draft?.rowId() ?? null
          return
        }
        if (state.cancellationAbort?.signal.aborted) {
          await state.draft?.discard()
          state.assistantMessageId = null
          return
        }
        const usage = state.producer?.usage?.() ?? {}
        const attribution = state.producer?.modelAttribution?.()
        const unredacted = {
          content: finalText,
          ...(parts && parts.length > 0 ? { parts } : {}),
          ...(state.producer?.model ? { model: state.producer.model } : {}),
          ...modelAttributionFields(attribution),
          ...measuredUsage(usage),
        }
        const values = redact ? redact(unredacted) : unredacted
        // ONE row per turn either way. With drafting, `finalize` settles
        // any in-flight draft and then insert-or-patches the same
        // deterministic id — so the row this turn ends with is identical to
        // the one the single-write path produces. Without it, today's
        // append is untouched.
        if (state.draft) {
          await state.draft.finalize(values)
          state.assistantMessageId = state.draft.rowId() ?? null
          return
        }
        state.assistantMessageId = rowIdOf(
          await options.store.appendMessage({
            threadId: payload.threadId,
            role: 'assistant',
            ...values,
          }),
        )
      }),
      ...(options.onTurnComplete
        ? {
          // Wired into the engine's completion hook, which fires only when
          // the stream ended without throwing. A terminal error EVENT
          // (not a throw) still lands here — so surface `runFailed` so the
          // product skips billing an errored turn instead of marking it
          // complete with empty text.
          onTurnComplete: async ({ identity: turnIdentity, finalText }: { identity: ChatTurnIdentity; finalText: string }) => {
            if (state.completionHandoff) return
            // Read AFTER the drain, so the model reported to billing is
            // the one that actually served — a fallback included.
            const failoverInfo = state.producer?.modelFailover?.()
            const attribution = state.producer?.modelAttribution?.()
            // The engine awaits this before the stream ends, so the product's completion work is a span, not a gap.
            return trace.measure('persist.on_turn_complete', 'persist', () => options.onTurnComplete!({
              identity: turnIdentity,
              userMessageId: produceArgs.userMessageId,
              backendTerminal: state.producer?.terminalObserved?.() ?? true,
              finalText,
              context,
              failed: state.runFailed,
              usage: state.producer?.usage?.(),
              assistantMessageId: assistantRowId(),
              ...(state.runFailed ? { failureReason: failureReasonOf(state.lastFailureData) } : {}),
              ...(state.runFailed && failureCodeOf(state.lastFailureData) ? { failureCode: failureCodeOf(state.lastFailureData) } : {}),
              ...(state.producer?.model ? { model: state.producer.model } : {}),
              ...modelAttributionFields(attribution),
              ...(failoverInfo ? { modelFailover: failoverInfo } : {}),
            }))
          },
        }
        : {}),
      ...(options.traceFlush ? { traceFlush: () => options.traceFlush!(context) } : {}),
    },
  })
  return { result }
}

function startTurnDrain<TContext>(
  result: ReturnType<typeof handleChatTurn>,
  log: (message: string, meta?: Record<string, unknown>) => void,
  turnStreamId: `${string}-${string}-${string}-${string}-${string}`,
  state: AdmittedTurnState<TContext>,
  endTrace: (failed: boolean, terminalError: unknown) => TurnTraceSnapshot,
  exportTrace: () => Promise<void>,
  trace: AdmittedTurn<TContext>['trace'],
  ctx: ChatTurnRequestContext | undefined,
  request: Request,
  fireTerminalLifecycle: (failed: boolean, terminalError: unknown) => Promise<void>,
  releaseLock: () => Promise<void>,
  runAfterSettle: () => Promise<void>,
  settleResource: () => Promise<void>,
) {
  // Tee: one branch to the live client, one drained under waitUntil so the
  // turn (and its buffering via onEvent) runs to completion after a client
  // drop — the engine body executes as it is pulled.
  const [clientBody, drainBody] = result.body.tee()
  const drained = (async () => {
    const reader = drainBody.getReader()
    let drainError: unknown
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch (err) {
      drainError = err
      log('[chat-routes] turn drain failed', {
        turnId: turnStreamId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const failed = state.runFailed || drainError !== undefined
    // Settle any in-flight draft INSIDE the waitUntil-tracked drain. On the
    // path where the producer throws, `persistAssistantMessage` never runs
    // to close the writer, and an unawaited write would race the isolate's
    // teardown — leaving a torn row instead of a clean partial one for a
    // re-entered turn to adopt.
    if (state.completionHandoff) {
      // The external owner settles transcript, lifecycle, lock and replay
      // status. Flush only the post-handoff live projection; EOF is an
      // observation stop, never a terminal verdict for that owner. The
      // trace is this request's own record, so it ends here.
      endTrace(failed, drainError)
      await Promise.all([state.tap!.detach(), state.nativeTiming?.flush(), exportTrace()])
      return
    }
    const finalize = trace.start('persist.finalize', 'persist')
    if (state.cancellationAbort?.signal.aborted || (ctx?.cancelOnDisconnect && request.signal.aborted)) {
      await state.draft?.discard()
    } else {
      await state.draft?.close()
    }
    try {
      await state.tap!.done(failed ? 'error' : 'complete')
    } catch (err) {
      log('[chat-routes] turn buffer finalize failed', {
        turnId: turnStreamId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    finalize.end()
    await fireTerminalLifecycle(failed, drainError)
    await releaseLock()
    // Both run after the lock is released and inside this waitUntil-tracked drain, so neither holds the next send.
    await Promise.all([exportTrace(), runAfterSettle()])
  })().finally(settleResource)
  if (ctx?.waitUntil) ctx.waitUntil(drained)
  else void drained.catch(() => { })
  return { clientBody }
}


function createTurnReplayResponse(
  contentType: string,
  clientBody: ReadableStream<Uint8Array>,
  turnMarker: { type: string; turnId: string },
  trace: Parameters<typeof admissionServerTiming>[0],
): Response {
  // Announce the replay handle in headers and body before the engine's first event.
  const encoder = new TextEncoder()
  const marker = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(turnMarker)}\n`))
      controller.close()
    },
  })
  const body = concatStreams([marker, clientBody])

  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'X-Turn-Id': turnMarker.turnId,
      'Server-Timing': admissionServerTiming(trace),
    },
  })
}
