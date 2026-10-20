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
import type { TurnTraceSink, TurnTraceSnapshot } from '../turn-trace/recorder'
import { otlpTraceId } from '../turn-trace/otel'
import {
  assistantRowIdForTurn,
  createAssistantDraftWriter,
  rowIdOf,
  type AssistantDraftStore,
  type AssistantDraftWriter,
  type DraftPersistenceTuning,
} from './draft-persistence'
import { admissionServerTiming, errorResponse, userPartsWithFiles, type AdmittedTurn, type TurnProgress } from './turn-admission'
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

/** Work `afterAuthorize` started: `handOff` gives it to `produce`; `release` frees it if nothing took it. */
export interface AfterAuthorizeWork {
  handOff(): void
  release(): Promise<void>
}

interface TurnExecutionOptions<TContext> {
  options: CreateChatTurnRoutesOptions<TContext>
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
export function createAdmittedTurnRunner<TContext>({
  options, draftStore, draftTuning, progressMessages, traceOptions, traceSink, startIntentLine, log,
}: TurnExecutionOptions<TContext>) {
  return async function runAdmittedTurn(
    request: Request,
    ctx: ChatTurnRequestContext | undefined,
    admitted: AdmittedTurn<TContext>,
    early: AfterAuthorizeWork,
    progress?: TurnProgress,
    startedIntent?: Promise<string | null>,
  ): Promise<Response> {
    const { parsed, auth, trace } = admitted
    // A progress-first turn started its line at admission; any other starts it here.
    const intentLine = startedIntent ?? startIntentLine(admitted)
    const { payload, content, fileParts, mentions, turnId } = parsed
    const { tenantId, userId, context } = auth

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
    const readHistory = async () => (await options.store.listMessages(payload.threadId)).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      parts: (m.parts ?? null) as PersistedChatMessageForTurn['parts'],
    }))
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
    let draft: AssistantDraftWriter | undefined
    let tap: BufferedTurnTap | undefined
    let completionHandoff = false
    let completionHandoffPromise: Promise<void> | undefined
    const handoffCompletion = (): Promise<void> => {
      if (!completionHandoffPromise) {
        completionHandoffPromise = (async () => {
          // Switch first: an event arriving while the prior draft write closes
          // must stay live-only and cannot arm another draft write or renewal.
          completionHandoff = true
          try {
            await tap?.detach()
          } catch (err) {
            log('[chat-routes] turn buffer detach failed', {
              turnId: turnStreamId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          // `close` waits for the draft writer's in-flight write. The durable
          // owner can therefore safely replace that draft after this resolves.
          await draft?.close()
        })()
      }
      return completionHandoffPromise
    }
    let produceArgs: ChatTurnProduceArgs<TContext> = {
      request,
      body: payload,
      identity,
      context,
      prompt,
      executionId,
      turnStreamId,
      priorMessages: chatTurn.priorMessages,
      handoffCompletion,
      trace,
      ...(intentLine ? { intentLine } : {}),
      ...(ctx?.executionLimits ? { executionLimits: ctx.executionLimits } : {}),
    }

    // Single-flight lock: acquire before any side effect. `release` runs
    // exactly once — in the drain's `finally` on a normal turn, or right here
    // on a short-circuit / throw.
    let lockAcquired = false
    let lockHandle: unknown
    let lockReleased = false
    const releaseLock = async (): Promise<void> => {
      // `handoffCompletion` transfers the route-acquired lock to the durable
      // owner too. Keep the legacy contextGate `{proceed:'handoff'}` path
      // unchanged when that callback was never invoked.
      if (completionHandoff || !lockAcquired || lockReleased) return
      lockReleased = true
      try {
        await options.turnLock!.release(lockHandle)
      } catch (err) {
        log('[chat-routes] turnLock.release failed', {
          turnId: turnStreamId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const turnLock = options.turnLock
    if (turnLock) {
      const acquired = await trace.measure('admission.lock', 'admission', () => turnLock.acquire(produceArgs))
      if (!acquired.acquired) return acquired.response
      lockAcquired = true
      lockHandle = acquired.handle
    }
    progress?.('preparing', progressMessages.preparing)

    // Turn state, hoisted so the pre-stream `catch` can settle the lifecycle
    // (fire `onTurnError`, close the span) even when a seam throws
    // synchronously before the drain — the drain would otherwise be the only
    // path that runs the terminal hook.
    let producer: ChatTurnRouteProducer | undefined
    // Set once persistence settles; `undefined` means it never ran.
    let assistantMessageId: string | null | undefined
    /** The assistant row this turn ended with. Falls back to the draft writer
     *  so a turn whose producer THREW — skipping `persistAssistantMessage`
     *  entirely — still names the partial row it left behind. */
    const assistantRowId = (): string | null => assistantMessageId ?? draft?.rowId() ?? null
    let runFailed = false
    // Data of the event that marked the run failed — handed to `onTurnError`
    // when no drain throw supplies a richer cause.
    let lastFailureData: Record<string, unknown> | undefined
    let turnStartedAtMs = 0
    let firstVisibleAtMs: number | undefined
    // Answer text stays separate from reasoning and tools.
    let firstTextAtMs: number | undefined
    let turnStarted = false
    let lifecycleSettled = false
    // What `lifecycle.afterSettle` receives: set when the turn ended cleanly with a producer that ran.
    let settledTurn: ChatTurnLifecycleComplete<TContext> | undefined
    // Set when `contextGate` answered the turn without running the producer.
    let gatedTurn = false
    // Set when `contextGate` handed the turn to the product's durable owner (`{ proceed: 'handoff' }`).
    let legacyHandoff = false

    let pendingTraceExport: (() => void | Promise<void>) | undefined
    let traceEnded = false

    /**
     * End the turn's trace once: write its summary line, and arm its export for `exportTrace`. A turn handed to a
     * durable owner ends here when this request's live projection ends; the owner settles everything else.
     */
    const endTrace = (failed: boolean, terminalError: unknown): TurnTraceSnapshot => {
      const failureCode = failed
        ? (failureCodeOf(lastFailureData) ?? (terminalError instanceof Error ? terminalError.name : 'turn_failed'))
        : undefined
      const snapshot = trace.finish(failureCode === undefined ? {} : { error: failureCode })
      if (traceEnded) return snapshot
      traceEnded = true
      const handedOff = completionHandoff || legacyHandoff
      // One line per turn in the host's logs (Workers Logs), so first text and coverage are readable without Intelligence.
      console.info(JSON.stringify({
        event: 'agent_app_turn_trace',
        project: options.projectId,
        executionId,
        otlpTraceId: otlpTraceId(snapshot.traceId),
        failed,
        ...(failureCode ? { failureCode } : {}),
        ...(handedOff ? { handedOff: true } : {}),
        ...(gatedTurn ? { gated: true } : {}),
        ...snapshot.summary,
      }))
      // Sent by `exportTrace`, after the turn lock is released: a slow collector must not hold the next send.
      const sink = traceSink
      if (sink) {
        pendingTraceExport = () => sink(snapshot, {
          'tangle.sessionId': identity.sessionId,
          'tangle.userId': identity.userId,
          'tangle.tenantId': identity.tenantId,
          'tangle.turn.failed': failed,
          ...(gatedTurn ? { 'tangle.turn.gated': true } : {}),
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
      if (lifecycleSettled) return
      lifecycleSettled = true
      // The trace ends with the turn, before the product's own hooks run, so their work is not in its wall time.
      const snapshot = endTrace(failed, terminalError)
      const lifecycle = options.lifecycle
      const durationMs = Date.now() - turnStartedAtMs
      const timing = {
        ...(firstVisibleAtMs === undefined ? {} : { firstVisibleMs: firstVisibleAtMs - turnStartedAtMs }),
        ...(firstTextAtMs === undefined ? {} : { firstTextMs: firstTextAtMs - turnStartedAtMs }),
        trace: snapshot.summary,
      }
      try {
        if (!lifecycle) {
          // No hooks to run; the trace still goes to its sink below.
        } else if (failed) {
          await lifecycle.onTurnError?.({
            identity, executionId, turnStreamId, context, durationMs, ...timing,
            error: terminalError ?? lastFailureData ?? new Error('chat turn failed'),
          })
        } else {
          const failoverInfo = producer?.modelFailover?.()
          const attribution = producer?.modelAttribution?.()
          const completed: ChatTurnLifecycleComplete<TContext> = {
            identity, executionId, turnStreamId, context, durationMs, ...timing,
            finalText: producer?.finalText() ?? '',
            usage: producer?.usage?.() ?? {},
            assistantMessageId: assistantRowId(),
            ...(gatedTurn ? { gated: true } : {}),
            ...(producer?.model ? { model: producer.model } : {}),
            ...modelAttributionFields(attribution),
            ...(failoverInfo ? { modelFailover: failoverInfo } : {}),
          }
          if (!gatedTurn) settledTurn = completed
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
      const send = pendingTraceExport
      pendingTraceExport = undefined
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
      const info = settledTurn
      settledTurn = undefined
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
      else void sent.catch(() => {})
    }

    try {
      if (lockAcquired && JSON.stringify(await trace.measure('admission.history_recheck', 'admission', readHistory)) !== historyBeforeLock) {
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
          legacyHandoff = true
          endTrace(false, undefined)
          exportTraceInBackground()
          return gate.response
        }
        if (!gate.proceed) {
          await releaseLock()
          if (completionHandoff) {
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
          gatedTurn = true
          turnStartedAtMs = Date.now()
          if (options.lifecycle?.onTurnStart) {
            try {
              await options.lifecycle.onTurnStart({
                identity, executionId, turnStreamId, context, startedAt: turnStartedAtMs,
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
        if (patch) produceArgs = { ...produceArgs, ...patch }
      }
      const streamSetup = trace.start('admission.stream_setup', 'admission')

      // Durability tap: every engine event buffers (coalesced) so a dropped
      // client replays the tail. Live delivery rides the Response body, not the
      // tap, so `write` is intentionally absent.
      tap = createBufferedTurnTap({
        store: options.turnStore,
        turnId: turnStreamId,
        scopeId: payload.threadId,
        coalesce: options.coalesceTurnEvents ?? coalesceDeltas,
      })
      const turnMarker = { type: 'turn', turnId: turnStreamId }
      await tap.onEvent(turnMarker)
      if (completionHandoff) await tap.detach()

      // Durable projection: the turn buffer above serves LIVE reconnect; this
      // keeps the persisted transcript at most one cadence interval behind, so
      // a viewer arriving after the buffer's (deliberately short) hot window
      // reads the in-flight answer from storage instead of an empty thread.
      // Row identity is the turn's own `executionId`, so a re-entered turn
      // patches the row a previous attempt started instead of duplicating it.
      if (draftTuning) {
        draft = createAssistantDraftWriter({
          ...draftTuning,
          store: draftStore,
          threadId: payload.threadId,
          messageId: options.draftMessageId
            ? options.draftMessageId({ identity, executionId, threadId: payload.threadId })
            : assistantRowIdForTurn(executionId),
          snapshot: () => {
            if (!producer) return null
            return {
              content: producer.finalText(),
              ...(producer.draftParts ? { parts: producer.draftParts() } : {}),
              ...(producer.usage ? { usage: producer.usage() } : {}),
              ...(producer.model ? { model: producer.model } : {}),
            }
          },
          ...(options.transformFinalText ? { transformText: options.transformFinalText } : {}),
          log,
        })
        // `contextGate` / `beforeTurn` may have handed ownership off before
        // the writer existed. Close this late-created writer immediately so it
        // cannot receive a later live event.
        if (completionHandoff) await draft.close()
      }

      turnStartedAtMs = Date.now()
      turnStarted = true
      if (options.lifecycle?.onTurnStart) {
        try {
          await options.lifecycle.onTurnStart({
            identity, executionId, turnStreamId, context, startedAt: turnStartedAtMs,
          })
        } catch (err) {
          log('[chat-routes] lifecycle.onTurnStart failed', {
            turnId: turnStreamId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      streamSetup.end()

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
              producer = await trace.measure('admission.produce', 'admission', () => options.produce(produceArgs))
              let source: AsyncIterable<ChatRouteEvent> = producer.stream
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
            finalText: () => producer?.finalText() ?? '',
          }),
          onEvent: async (event) => {
            if (firstVisibleAtMs === undefined && isVisibleOutput(event)) {
              firstVisibleAtMs = Date.now()
              trace.markFirstVisible(firstVisibleAtMs)
            }
            if (firstTextAtMs === undefined && isVisibleText(event)) {
              firstTextAtMs = Date.now()
              trace.markFirstText(firstTextAtMs)
            }
            if (event.type === 'session.run.failed' || event.type === 'error') {
              runFailed = true
              lastFailureData = event.data
            }
            await tap!.onEvent(event)
            // Synchronous bookkeeping; the write it may start is fire-and-
            // forget, so store latency never back-pressures the live stream.
            if (!completionHandoff) draft?.notify(event)
            if (options.onEvent) await options.onEvent(event, context)
          },
          ...(options.transformFinalText ? { transformFinalText: options.transformFinalText } : {}),
          persistAssistantMessage: ({ finalText }) => trace.measure('persist.assistant', 'persist', async () => {
            if (completionHandoff) return
            if (ctx?.cancelOnDisconnect && request.signal.aborted) {
              await draft?.discard()
              assistantMessageId = null
              return
            }
            // The typed boundary: stream-normalizer records → stored vocabulary
            // (validating projection owned by /chat-store — no cast here). The
            // scalar `finalText` arrives already transformed by the engine; the
            // producer's text PARTS are raw, so the same transform must run over
            // each text segment before persistence or a redaction (legal PII)
            // leaks at rest through message.parts.
            const rawParts = producer?.assistantParts ? producer.assistantParts() : undefined
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
              await draft?.discard()
              // Read the writer rather than assuming `null`: `discard` is a
              // no-op on a store without `deleteMessage` (drafting needs only
              // `updateMessage`), and there the draft row genuinely survives.
              assistantMessageId = draft?.rowId() ?? null
              return
            }
            const usage = producer?.usage?.() ?? {}
            const attribution = producer?.modelAttribution?.()
            const values = {
              content: finalText,
              ...(parts && parts.length > 0 ? { parts } : {}),
              ...(producer?.model ? { model: producer.model } : {}),
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
            if (draft) {
              await draft.finalize(values)
              assistantMessageId = draft.rowId() ?? null
              return
            }
            assistantMessageId = rowIdOf(
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
                  if (completionHandoff) return
                  // Read AFTER the drain, so the model reported to billing is
                  // the one that actually served — a fallback included.
                  const failoverInfo = producer?.modelFailover?.()
                  const attribution = producer?.modelAttribution?.()
                  // The engine awaits this before the stream ends, so the product's completion work is a span, not a gap.
                  return trace.measure('persist.on_turn_complete', 'persist', () => options.onTurnComplete!({
                    identity: turnIdentity,
                    finalText,
                    context,
                    failed: runFailed,
                    assistantMessageId: assistantRowId(),
                    ...(runFailed ? { failureReason: failureReasonOf(lastFailureData) } : {}),
                    ...(runFailed && failureCodeOf(lastFailureData) ? { failureCode: failureCodeOf(lastFailureData) } : {}),
                    ...(producer?.model ? { model: producer.model } : {}),
                    ...modelAttributionFields(attribution),
                    ...(failoverInfo ? { modelFailover: failoverInfo } : {}),
                  }))
                },
              }
            : {}),
          ...(options.traceFlush ? { traceFlush: () => options.traceFlush!(context) } : {}),
        },
      })

      // The engine has the turn, and its first pull runs `produce`, which owns whatever `afterAuthorize` started.
      early.handOff()

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
        const failed = runFailed || drainError !== undefined
        // Settle any in-flight draft INSIDE the waitUntil-tracked drain. On the
        // path where the producer throws, `persistAssistantMessage` never runs
        // to close the writer, and an unawaited write would race the isolate's
        // teardown — leaving a torn row instead of a clean partial one for a
        // re-entered turn to adopt.
        if (completionHandoff) {
          // The external owner settles transcript, lifecycle, lock and replay
          // status. Flush only the post-handoff live projection; EOF is an
          // observation stop, never a terminal verdict for that owner. The
          // trace is this request's own record, so it ends here.
          endTrace(failed, drainError)
          await Promise.all([tap.detach(), exportTrace()])
          return
        }
        const finalize = trace.start('persist.finalize', 'persist')
        if (ctx?.cancelOnDisconnect && request.signal.aborted) {
          await draft?.discard()
        } else {
          await draft?.close()
        }
        try {
          await tap.done(failed ? 'error' : 'complete')
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
      })()
      if (ctx?.waitUntil) ctx.waitUntil(drained)
      else void drained.catch(() => {})

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
          'Content-Type': result.contentType,
          'Cache-Control': 'no-cache',
          'X-Turn-Id': turnStreamId,
          'Server-Timing': admissionServerTiming(trace),
        },
      })
    } catch (err) {
      // A throw before the turn began streaming (user-insert, gate, beforeTurn,
      // lifecycle-start, tap setup, engine construction, tee). If the turn had
      // already started, settle the lifecycle with `onTurnError` (close the
      // span) — the drain never ran to do it. Then release the lock, propagate.
      if (!completionHandoff) {
        if (turnStarted) await fireTerminalLifecycle(true, err)
        await releaseLock()
      }
      // A turn that failed before it started, or after a durable owner took it, still ends its trace here.
      endTrace(true, err)
      exportTraceInBackground()
      throw err
    }
  }

}
