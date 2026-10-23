/**
 * Dispatch-first admission: start the producer, and so the model call, as soon
 * as the turn's identity is known, while the lock, the history recheck, the
 * user-row insert, `contextGate` and `beforeTurn` run. Nothing the producer
 * emits reaches the member, the turn buffer or the transcript until that chain
 * commits; a refusal aborts the producer and drops what it emitted.
 *
 * Why: on Creative production (2026-10-21, gemini-3.7-flash, n=32 Router
 * turns) the chain between `authorize` and the producer held about 780 ms of
 * every turn's p50 (admission 343, profile pin 338, turn open 99) before the
 * model was even called. The model's own first token takes 2.5-3.6 s, so that
 * work fits inside it.
 *
 * What stays fail-closed: `authorize` has already run, so no model call starts
 * for a caller without identity and workspace access. Billing is enforced in
 * `authorize` or at the model service, which holds spend before it calls the
 * provider; the product names which (`dispatchFirst: { billing }`). Gates the
 * model service cannot know, such as a seat, run in `contextGate` beside the
 * model call, and the output waits for them. Single-flight is unchanged: the lock still decides which turn's output is
 * kept; a refused duplicate costs only the model call it started, which its
 * `admissionSignal` cancels.
 */
import type { TurnTrace } from '../turn-trace/recorder'
import type { NativeCompletionHandoffOptions } from './native-turn-timing'
import type { ChatRouteEvent, ChatTurnProduceArgs, ChatTurnRouteProducer, CreateChatTurnRoutesOptions } from './turn-route-contracts'

/** Thrown into `args.admitted` when the turn was refused after its producer started. */
export class TurnAdmissionRefusedError extends Error {
  constructor() {
    super('The turn was refused after its producer started; its output was discarded.')
    this.name = 'TurnAdmissionRefusedError'
  }
}

export interface DispatchedProducer<TContext> {
  /** The admission chain committed: hand the producer its final args and return it, with what it already emitted first. */
  take(args: ChatTurnProduceArgs<TContext>): Promise<ChatTurnRouteProducer>
  /** The turn ended without the producer: abort it and discard its output. Idempotent; a no-op after `take`. */
  refuse(): void
}

/**
 * Start `produce` now with the args known before the lock. `args.admitted`
 * resolves to the final args at `take`, or rejects at `refuse`; the producer
 * writes nothing durable before it resolves. Its stream is drained into memory
 * from the start, so a producer that only works while pulled still dispatches.
 */
function dispatchProducerFirst<TContext>(
  produce: (args: ChatTurnProduceArgs<TContext>) => ChatTurnRouteProducer | Promise<ChatTurnRouteProducer>,
  args: ChatTurnProduceArgs<TContext>,
  trace: TurnTrace,
): DispatchedProducer<TContext> {
  const abort = new AbortController()
  let admit!: (final: ChatTurnProduceArgs<TContext>) => void
  let reject!: (error: Error) => void
  const admitted = new Promise<ChatTurnProduceArgs<TContext>>((resolve, fail) => { admit = resolve; reject = fail })
  // A producer that never awaits `admitted` must not raise an unhandled rejection when the turn is refused.
  admitted.catch(() => {})
  let settled: 'taken' | 'refused' | undefined
  // Set when nobody will read the producer again: a refusal, or the route's reader closing after `take`.
  let stopped = false

  const queue: ChatRouteEvent[] = []
  let ended = false
  let failure: { error: unknown } | undefined
  let wake: (() => void) | undefined
  const notify = () => { const resume = wake; wake = undefined; resume?.() }
  let source: AsyncIterator<ChatRouteEvent> | undefined

  // A registered durable owner settles the transcript and the lock, so a producer may hand off only a committed turn.
  const handoffCompletion = args.handoffCompletion
  const started = trace.measure('admission.produce', 'admission', () => produce({
    ...args,
    admitted,
    admissionSignal: abort.signal,
    ...(handoffCompletion ? { handoffCompletion: (options?: NativeCompletionHandoffOptions) => admitted.then(() => handoffCompletion(options)) } : {}),
  }))
  const draining = started.then(async (producer) => {
    try {
      source = producer.stream[Symbol.asyncIterator]()
      for (;;) {
        const next = await source.next()
        if (next.done || stopped) break
        queue.push(next.value)
        notify()
      }
    } catch (error) {
      if (!stopped) failure = { error }
    } finally {
      ended = true
      notify()
    }
  }, (error: unknown) => {
    failure = { error }
    ended = true
    notify()
  })

  /** Nobody reads this producer again: abort its model call, close its stream and drop what it queued. */
  const stop = (reason: Error) => {
    if (stopped) return
    stopped = true
    abort.abort(reason)
    queue.length = 0
    notify()
    // A producer that ignores the signal is closed too; one suspended at an await finishes that await first.
    void started.then(() => source?.return?.(), () => {}).catch(() => {})
  }

  async function* replay(): AsyncGenerator<ChatRouteEvent, void, unknown> {
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!
        if (ended) break
        await new Promise<void>((resolve) => { wake = resolve })
      }
      await draining
      if (failure) throw failure.error
    } finally {
      // The route stopped reading early (a disconnect under `cancelOnDisconnect`, an engine stop): stop the producer
      // as closing its own stream would have.
      if (!ended) stop(new Error('The turn stopped reading its producer.'))
    }
  }

  return {
    async take(final) {
      if (settled) throw new Error(`dispatch-first producer already ${settled}`)
      settled = 'taken'
      admit(final)
      const producer = await started
      // The producer's own object keeps its getters (`model`, usage, parts); only its stream is replaced. Defined, not
      // assigned, so a getter-only or frozen `stream` cannot make the hand-over throw.
      return Object.defineProperty(Object.create(producer) as ChatTurnRouteProducer, 'stream', { value: replay(), enumerable: true })
    },
    refuse() {
      if (settled) return
      settled = 'refused'
      reject(new TurnAdmissionRefusedError())
      stop(new TurnAdmissionRefusedError())
    },
  }
}

/** The dispatched producer for this turn when the route dispatches first and `when` picks it; otherwise none. */
export function dispatchFirstFor<TContext>(
  options: CreateChatTurnRoutesOptions<TContext>,
  args: ChatTurnProduceArgs<TContext>,
  trace: TurnTrace,
): DispatchedProducer<TContext> | undefined {
  const policy = options.dispatchFirst
  if (!policy || !(policy.when?.(args) ?? true)) return undefined
  return dispatchProducerFirst(options.produce, args, trace)
}
