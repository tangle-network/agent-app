/** Admission-to-settlement execution for one authenticated chat turn. */
import { deriveExecutionId, handleChatTurn, type ChatTurnIdentity } from '@tangle-network/agent-runtime/durable'
import { toChatMessageParts } from '../chat-store/parts'
import {
  coalesceDeltas,
  createBufferedTurnTap,
  resolveChatTurn,
  type BufferedTurnTap,
  type PersistedChatMessageForTurn,
} from '../stream/index'
import type { TurnTraceSink, TurnTraceSnapshot, TurnTraceSummary } from '../turn-trace/recorder'
import { otlpTraceId } from '../turn-trace/otel'
import { noteMeasuredTurnFacts, readableTurnFailure } from '../turn-trace/turn-facts'
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
import { abortOnSignal, concatStreams, failureCodeOf, failureReasonOf, isVisibleOutput, isVisibleText, tapRawEvents, withStreamHeartbeat } from './turn-event-stream'
import type {
  ChatTurnLifecycleComplete,
  ChatTurnModelAttribution,
  ChatTurnProduceArgs,
  ChatTurnRequestContext,
  ChatTurnRouteProducer,
  ChatTurnTraceOptions,
  ChatRouteEvent,
  CreateChatTurnRoutesOptions,
} from './turn-route-contracts'
import type { TurnRoutePhase } from './turn-progress'
import { ChatTurnInputError, type ChatTurnPartInput } from './wire'
import type { ResolvedChatTurnRoutesOptions } from './route-storage'
import type { AfterAuthorizeWork } from './early-turn-work'

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
  startIntentLine(admitted: AdmittedTurn<TContext>): Promise<string | null> | undefined
  log(message: string, meta?: Record<string, unknown>): void
}

/** One requested-versus-served projection for persistence and both completion receipts. */
function modelAttributionFields(attribution: ChatTurnModelAttribution | undefined) {
  return {
    ...(attribution?.requestedModel ? { requestedModel: attribution.requestedModel } : {}),
    ...(attribution?.servedModel ? { servedModel: attribution.servedModel } : {}),
    ...(attribution?.servedProvider ? { servedProvider: attribution.servedProvider } : {}),
    ...(attribution?.servedSource ? { servedSource: attribution.servedSource } : {}),
  }
}

/** Bind the route's construction-time dependencies; each invocation retains its own turn state. */
/** The lifecycle's timing for a settled turn, noted for the rollout timing store so it can fill a product row that
 *  omits it (rollout/d1 `record`). */
function settledTurnTiming(turnStreamId: string, at: {
  requestAt: number; startedAt: number; firstVisibleAt?: number
  firstTextAt?: number; model?: string
  failure?: { data?: Record<string, unknown>; error: unknown }
}, trace: TurnTraceSummary) {
  const measured = {
    admissionMs: at.startedAt - at.requestAt,
    ...(at.firstVisibleAt === undefined ? {} : { firstVisibleMs: at.firstVisibleAt - at.startedAt }),
    ...(at.firstTextAt === undefined ? {} : { firstTextMs: at.firstTextAt - at.startedAt }),
  }
  const failureCode = at.failure ? readableTurnFailure(at.failure.error, at.failure.data) : undefined
  noteMeasuredTurnFacts(turnStreamId, { ...measured, ...(at.model ? { model: at.model } : {}),
    ...(failureCode ? { failureCode } : {}) })
  return { ...measured, trace }
}

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
  // A progress-first turn started its line at admission; any other starts it here.
  const intentLine = startedIntent ?? startIntentLine(admitted)
  const { payload, content, fileParts, mentions, turnId } = parsed
  const { tenantId, userId, context } = auth

  const preparedBatch = await prepareAdmittedTurn(options, trace, log, tenantId, userId, payload, context, request, progress, content, turnId, draftTuning, ctx?.waitUntil)
  if (preparedBatch instanceof Response) return preparedBatch
  const { turnStreamId, identity, executionId, chatTurn, readHistory, historyBeforeLock } = preparedBatch

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
  if (options.cancel) state.cancellationAbort = new AbortController()

  const { handoffCompletion, releaseLock } = createTurnOwnership(state, log, turnStreamId, options)

  let produceArgs: ChatTurnProduceArgs<TContext, TResource> = {
    request,
    waitUntil: ctx?.waitUntil,
    earlyResource: early.resource,
    admissionSignal: state.cancellationAbort?.signal,
    body: payload,
    identity,
    context,
    prompt,
    executionId,
    turnStreamId,
    priorMessages: chatTurn.priorMessages, ...(chatTurn.reusedUserMessageId ? { userMessageId: chatTurn.reusedUserMessageId, userMessageInserted: false } : {}),
    handoffCompletion,
    trace,
    ...(intentLine ? { intentLine } : {}), ...(admitted.prefetched ? { prefetched: admitted.prefetched } : {}),
    ...(ctx?.executionLimits ? { executionLimits: ctx.executionLimits } : {}),
  }
  const selected = selectTurnProducer(options.produce, produceArgs)
  const dispatched = dispatchFirstFor(selected, produceArgs, trace)
  if (dispatched) early.add(dispatched.refuse)
  const turnLock = options.turnLock
  if (turnLock) {
    const acquired = await trace.measure('admission.lock', 'admission', () => turnLock.acquire(produceArgs))
    if (!acquired.acquired) return acquired.response
    state.lockAcquired = true
    state.lockHandle = acquired.handle
  }
  progress?.('preparing', progressMessages.preparing)

  // Turn state, hoisted so the pre-stream `catch` can settle the lifecycle
  // (fire `onTurnError`, close the span) even when a seam throws
  // synchronously before the drain — the drain would otherwise be the only
  // path that runs the terminal hook.

  // Set once persistence settles; `undefined` means it never ran.

  /** The assistant row this turn ended with. Falls back to the draft writer
   *  so a turn whose producer THREW — skipping `persistAssistantMessage`
   *  entirely — still names the partial row it left behind. */
  const { endTrace, exportTraceInBackground, fireTerminalLifecycle, assistantRowId, exportTrace, runAfterSettle } = createTurnSettlement(state, trace, options, executionId, traceSink, identity, traceOptions, context, turnStreamId, log, ctx)

  try {
    if (state.lockAcquired && JSON.stringify(await trace.measure('admission.history_recheck', 'admission', readHistory)) !== historyBeforeLock) {
      await releaseLock()
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
        await trace.measure('admission.persist_user', 'admission', () => options.store.appendMessage({
          threadId: payload.threadId,
          role: 'user',
          content,
          parts: userPartsWithFiles(chatTurn.userParts, fileParts, mentions),
        })),
      )
      userMessageInserted = userMessageId !== null
    }
    produceArgs = { ...produceArgs, userMessageId, userMessageInserted }

    // Domain-readiness gate: may short-circuit with the product's own
    // response before the producer runs. The user row above is kept (a real
    // user turn); the gate's response is the assistant side of it.
    const contextGate = options.contextGate
    if (contextGate) {
      const gate = await trace.measure('admission.gate', 'admission', () => contextGate(produceArgs))
      if (gate.proceed === 'handoff') {
        await releaseLock()
        state.legacyHandoff = true
        endTrace(false, undefined)
        exportTraceInBackground()
        return gate.response
      }
      if (!gate.proceed) {
        await releaseLock()
        if (state.completionHandoff) {
          endTrace(false, undefined)
          exportTraceInBackground()
          return gate.response
        }
        // A gated turn is still a TURN, and until now it was the one answer
        // path that fired no lifecycle hook at all — `turnStarted` is set
        // further down, so an early return here left telemetry with no record
        // that anything happened. A product whose gate answers everything
        // therefore looks IDLE rather than broken, which is indistinguishable
        // from healthy on every dashboard.
        //
        // Only the LIFECYCLE hooks fire (telemetry, errors swallowed); the
        // billing/persistence `onTurnComplete` deliberately does not, because
        // no model ran and no assistant row was written. `gated` marks the
        // completion so a consumer counts it without mistaking it for a model
        // turn that produced nothing.
        state.gatedTurn = true
        state.turnStartedAtMs = Date.now()
        if (options.lifecycle?.onTurnStart) {
          try {
            await options.lifecycle.onTurnStart({
              identity, executionId, turnStreamId, context, startedAt: state.turnStartedAtMs,
              requestReceivedAt: trace.startedAt, admissionMs: state.turnStartedAtMs - trace.startedAt,
            })
          } catch (err) {
            log('[chat-routes] lifecycle.onTurnStart failed', {
              turnId: turnStreamId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        await fireTerminalLifecycle(false, undefined)
        exportTraceInBackground()
        return gate.response
      }
    }

    // Observe + optionally augment the assembled producer input.
    const beforeTurn = options.beforeTurn
    if (beforeTurn) {
      const patch = await trace.measure('admission.before_turn', 'admission', (span) => beforeTurn(produceArgs, { span }))
      if (patch && Object.keys(patch).length && dispatched) throw new Error('beforeTurn cannot patch a Router turn already dispatched: its prompt is already sent')
      if (patch) produceArgs = { ...produceArgs, ...patch }
    }
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
          return {
            content: state.producer.finalText(),
            ...(state.producer.draftParts ? { parts: state.producer.draftParts() } : {}),
            ...(state.producer.usage ? { usage: state.producer.usage() } : {}),
            ...(state.producer.model ? { model: state.producer.model } : {}),
          }
        },
        ...(options.transformFinalText ? { transformText: options.transformFinalText } : {}),
        log,
      })
      // `contextGate` / `beforeTurn` may have handed ownership off before
      // the writer existed. Close this late-created writer immediately so it
      // cannot receive a later live event.
      if (state.completionHandoff) await state.draft.close()
    }

    state.turnStartedAtMs = Date.now()
    state.turnStarted = true
    if (options.lifecycle?.onTurnStart) {
      try {
        await options.lifecycle.onTurnStart({
          identity, executionId, turnStreamId, context, startedAt: state.turnStartedAtMs,
          requestReceivedAt: trace.startedAt, admissionMs: state.turnStartedAtMs - trace.startedAt,
        })
      } catch (err) {
        log('[chat-routes] lifecycle.onTurnStart failed', {
          turnId: turnStreamId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    streamSetup.end()

    const { result } = createTurnEngine(identity, ctx, log, state, dispatched, produceArgs, trace, options, selected.produce, request, context, payload, assistantRowId)

    // The engine has the turn, and its first pull runs `produce`, which owns whatever `afterAuthorize` started.
    const { clientBody } = startTurnDrain(result, log, turnStreamId, state, endTrace, exportTrace, trace, ctx, request, fireTerminalLifecycle, releaseLock, runAfterSettle, early.settle)
    early.handOff()

    return createTurnReplayResponse(result.contentType, clientBody, turnMarker, trace)
  } catch (err) {
    // A throw before the turn began streaming (user-insert, gate, beforeTurn,
    // lifecycle-start, tap setup, engine construction, tee). If the turn had
    // already started, settle the lifecycle with `onTurnError` (close the
    // span) — the drain never ran to do it. Then release the lock, propagate.
    if (!state.completionHandoff) {
      if (state.turnStarted) await fireTerminalLifecycle(true, err)
      await releaseLock()
    }
    // A turn that failed before it started, or after a durable owner took it, still ends its trace here.
    endTrace(true, err)
    exportTraceInBackground()
    throw err
  }
}
interface AdmittedTurnState<TContext> {
  draft: AssistantDraftWriter | undefined
  tap: BufferedTurnTap | undefined
  completionHandoff: boolean
  completionHandoffPromise: Promise<void> | undefined
  lockAcquired: boolean
  lockHandle: unknown
  lockReleased: boolean
  cancellationAbort?: AbortController
  producer: ChatTurnRouteProducer | undefined
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
    draft: undefined,
    tap: undefined,
    completionHandoff: false,
    completionHandoffPromise: undefined,
    lockAcquired: false,
    lockHandle: undefined,
    lockReleased: false,
    producer: undefined,
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

function createTurnSettlement<TContext, TResource>(
  state: AdmittedTurnState<TContext>,
  trace: AdmittedTurn<TContext>['trace'],
  options: TurnExecutionOptions<TContext, TResource>['options'],
  executionId: string,
  traceSink: TurnExecutionOptions<TContext, TResource>['traceSink'],
  identity: ChatTurnIdentity,
  traceOptions: TurnExecutionOptions<TContext, TResource>['traceOptions'],
  context: TContext,
  turnStreamId: `${string}-${string}-${string}-${string}-${string}`,
  log: (message: string, meta?: Record<string, unknown>) => void,
  ctx: ChatTurnRequestContext | undefined,
) {
  const assistantRowId = (): string | null => state.assistantMessageId ?? state.draft?.rowId() ?? null

  // Data of the event that marked the run failed — handed to `onTurnError`
  // when no drain throw supplies a richer cause.

  // Answer text stays separate from reasoning and tools.

  // What `lifecycle.afterSettle` receives: set when the turn ended cleanly with a producer that ran.

  // Set when `contextGate` answered the turn without running the producer.

  // Set when `contextGate` handed the turn to the product's durable owner (`{ proceed: 'handoff' }`).

  /**
   * End the turn's trace once: write its summary line, and arm its export for `exportTrace`. A turn handed to a
   * durable owner ends here when this request's live projection ends; the owner settles everything else.
   */
  const endTrace = (failed: boolean, terminalError: unknown): TurnTraceSnapshot => {
    const failureCode = failed
      ? (failureCodeOf(state.lastFailureData) ?? (terminalError instanceof Error ? terminalError.name : 'turn_failed'))
      : undefined
    const snapshot = trace.finish(failureCode === undefined ? {} : { error: failureCode })
    if (state.traceEnded) return snapshot
    state.traceEnded = true
    const handedOff = state.completionHandoff || state.legacyHandoff
    // One line per turn in the host's logs (Workers Logs), so first text and coverage are readable without Intelligence.
    console.info(JSON.stringify({
      event: 'agent_app_turn_trace',
      project: options.projectId,
      executionId,
      otlpTraceId: otlpTraceId(snapshot.traceId),
      failed,
      ...(failureCode ? { failureCode } : {}),
      ...(handedOff ? { handedOff: true } : {}),
      ...(state.gatedTurn ? { gated: true } : {}),
      ...snapshot.summary,
    }))
    // Sent by `exportTrace`, after the turn lock is released: a slow collector must not hold the next send.
    const sink = traceSink
    if (sink) {
      state.pendingTraceExport = () => sink(snapshot, {
        'tangle.sessionId': identity.sessionId,
        'tangle.userId': identity.userId,
        'tangle.tenantId': identity.tenantId,
        'tangle.turn.failed': failed,
        ...(state.gatedTurn ? { 'tangle.turn.gated': true } : {}),
        ...(handedOff ? { 'tangle.turn.handed_off': true } : {}),
        ...(failureCode ? { 'tangle.turn.failure_code': failureCode } : {}),
        ...(traceOptions?.labels?.({ identity, executionId, context }) ?? {}),
      })
    }
    return snapshot
  }

  // Exactly one terminal lifecycle hook, after the turn settles (idempotent).
  // Failure is this route's own verdict (`runFailed` from error/failed
  // events, or a drain/sync throw), not the engine's envelope.
  const fireTerminalLifecycle = async (failed: boolean, terminalError: unknown): Promise<void> => {
    if (state.lifecycleSettled) return
    state.lifecycleSettled = true
    // The trace ends with the turn, before the product's own hooks run, so their work is not in its wall time.
    const snapshot = endTrace(failed, terminalError)
    const lifecycle = options.lifecycle
    const durationMs = Date.now() - state.turnStartedAtMs
    const timing = settledTurnTiming(turnStreamId, {
      requestAt: trace.startedAt, startedAt: state.turnStartedAtMs,
      firstVisibleAt: state.firstVisibleAtMs, firstTextAt: state.firstTextAtMs, model: state.producer?.model,
      failure: failed ? { data: state.lastFailureData, error: terminalError } : undefined,
    }, snapshot.summary)
    try {
      if (!lifecycle) {
        // No hooks to run; the trace still goes to its sink below.
      } else if (failed) {
        await lifecycle.onTurnError?.({
          identity, executionId, turnStreamId, context, durationMs, ...timing,
          error: terminalError ?? state.lastFailureData ?? new Error('chat turn failed'),
        })
      } else {
        const failoverInfo = state.producer?.modelFailover?.()
        const attribution = state.producer?.modelAttribution?.()
        const completed: ChatTurnLifecycleComplete<TContext> = {
          identity, executionId, turnStreamId, context, durationMs, ...timing,
          finalText: state.cancellationAbort?.signal.aborted ? '' : state.producer?.finalText() ?? '',
          usage: state.producer?.usage?.() ?? {},
          assistantMessageId: assistantRowId(),
          ...(state.gatedTurn ? { gated: true } : {}),
          ...(state.producer?.model ? { model: state.producer.model } : {}),
          ...modelAttributionFields(attribution),
          ...(failoverInfo ? { modelFailover: failoverInfo } : {}),
        }
        if (!state.gatedTurn) state.settledTurn = completed
        await lifecycle.onTurnComplete?.(completed)
      }
    } catch (err) {
      log('[chat-routes] lifecycle terminal hook failed', {
        turnId: turnStreamId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  /** Send the finished trace to its sink. Never throws. */
  const exportTrace = async (): Promise<void> => {
    const send = state.pendingTraceExport
    state.pendingTraceExport = undefined
    if (!send) return
    try {
      await send()
    } catch (err) {
      log('[chat-routes] turn trace sink failed', {
        turnId: turnStreamId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  /** The product's follow-up work for a turn that ended cleanly, once its lock is released. Never throws. */
  const runAfterSettle = async (): Promise<void> => {
    const info = state.settledTurn
    state.settledTurn = undefined
    const afterSettle = options.lifecycle?.afterSettle
    if (!info || !afterSettle) return
    try {
      await afterSettle(info)
    } catch (err) {
      log('[chat-routes] lifecycle.afterSettle failed', {
        turnId: turnStreamId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  /** Export after the response is on its way: under `waitUntil` where the host has one. */
  const exportTraceInBackground = (): void => {
    const sent = exportTrace()
    if (ctx?.waitUntil) ctx.waitUntil(sent)
    else void sent.catch(() => { })
  }
  return { endTrace, exportTraceInBackground, fireTerminalLifecycle, assistantRowId, exportTrace, runAfterSettle }
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
            const started = dispatched ? dispatched.take(produceArgs) : trace.measure('admission.produce', 'admission', () => produce(produceArgs))
            if (!dispatched) {
              const cleanup = started.then(producer => producer.cleanup, () => undefined)
              ctx?.waitUntil?.(cleanup)
              void cleanup.catch(() => {})
            }
            state.producer = await started
            yield* state.producer.stream
          }
          let source: AsyncIterable<ChatRouteEvent> = producerStream()
          if (options.cancel && state.cancellationAbort) {
            source = observeTurnCancellation(source, produceArgs, options.cancel, state.cancellationAbort)
          }
          if (ctx?.cancelOnDisconnect) {
            source = abortOnSignal(source, request.signal)
          }
          if (options.onRawEvent) {
            source = tapRawEvents(source, (event) => options.onRawEvent!(event, context), log)
          }
          if (options.heartbeat) {
            source = withStreamHeartbeat(source, options.heartbeat.intervalMs, options.heartbeat.event)
          }
          for await (const event of source) yield event
        })(),
        finalText: () => state.cancellationAbort?.signal.aborted ? '' : state.producer?.finalText() ?? '',
      }),
      onEvent: async (event) => {
        if (state.firstVisibleAtMs === undefined && isVisibleOutput(event)) {
          state.firstVisibleAtMs = Date.now()
          trace.markFirstVisible(state.firstVisibleAtMs)
        }
        if (state.firstTextAtMs === undefined && isVisibleText(event)) {
          state.firstTextAtMs = Date.now()
          trace.markFirstText(state.firstTextAtMs)
        }
        if (event.type === 'session.run.failed' || event.type === 'error') {
          state.runFailed = true
          state.lastFailureData = event.data
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
            ? await Promise.all(
              rawParts.map(async (part) =>
                String((part as { type?: unknown }).type ?? '') === 'text'
                  ? { ...part, text: await options.transformFinalText!(String((part as { text?: unknown }).text ?? '')) }
                  : part,
              ),
            )
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
        const values = {
          content: finalText,
          ...(parts && parts.length > 0 ? { parts } : {}),
          ...(state.producer?.model ? { model: state.producer.model } : {}),
          ...modelAttributionFields(attribution),
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
          ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
          ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
          ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        }
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
      await Promise.all([state.tap!.detach(), exportTrace()])
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

function createTurnOwnership<TContext, TResource>(state: AdmittedTurnState<TContext>, log: (message: string, meta?: Record<string, unknown>) => void, turnStreamId: `${string}-${string}-${string}-${string}-${string}`, options: TurnExecutionOptions<TContext, TResource>['options']) {
  const handoffCompletion = (): Promise<void> => {
    if (!state.completionHandoffPromise) {
      state.completionHandoffPromise = (async () => {
        // Switch first: an event arriving while the prior draft write closes
        // must stay live-only and cannot arm another draft write or renewal.
        state.completionHandoff = true
        try {
          await state.tap?.detach()
        } catch (err) {
          log('[chat-routes] turn buffer detach failed', {
            turnId: turnStreamId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        // `close` waits for the draft writer's in-flight write. The durable
        // owner can therefore safely replace that draft after this resolves.
        await state.draft?.close()
      })()
    }
    return state.completionHandoffPromise
  }


  // Single-flight lock: acquire before any side effect. `release` runs
  // exactly once — in the drain's `finally` on a normal turn, or right here
  // on a short-circuit / throw.

  const releaseLock = async (): Promise<void> => {
    // `handoffCompletion` transfers the route-acquired lock to the durable
    // owner too. Keep the legacy contextGate `{proceed:'handoff'}` path
    // unchanged when that callback was never invoked.
    if (state.completionHandoff || !state.lockAcquired || state.lockReleased) return
    state.lockReleased = true
    try {
      await options.turnLock!.release(state.lockHandle)
    } catch (err) {
      log('[chat-routes] turnLock.release failed', {
        turnId: turnStreamId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { handoffCompletion, releaseLock }
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
