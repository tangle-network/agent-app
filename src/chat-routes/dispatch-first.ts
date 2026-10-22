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
import type { ChatRouteEvent, ChatTurnProduceArgs, ChatTurnRouteProducer } from './turn-route-contracts'

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
export function dispatchProducerFirst<TContext>(
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

  const queue: ChatRouteEvent[] = []
  let ended = false
  let failure: { error: unknown } | undefined
  let wake: (() => void) | undefined
  const notify = () => { const resume = wake; wake = undefined; resume?.() }

  const started = trace.measure('admission.produce', 'admission', () => produce({ ...args, admitted, admissionSignal: abort.signal }))
  const draining = started.then(async (producer) => {
    try {
      for await (const event of producer.stream) {
        if (settled === 'refused') break
        queue.push(event)
        notify()
      }
    } catch (error) {
      failure = { error }
    } finally {
      ended = true
      notify()
    }
  }, (error: unknown) => {
    failure = { error }
    ended = true
    notify()
  })

  async function* replay(): AsyncGenerator<ChatRouteEvent, void, unknown> {
    for (;;) {
      while (queue.length) yield queue.shift()!
      if (ended) break
      await new Promise<void>((resolve) => { wake = resolve })
    }
    await draining
    if (failure) throw failure.error
  }

  return {
    async take(final) {
      if (settled) throw new Error(`dispatch-first producer already ${settled}`)
      settled = 'taken'
      admit(final)
      const producer = await started
      // The producer's own object keeps its getters (`model`, usage, parts); only its stream is replaced.
      return Object.assign(Object.create(producer) as ChatTurnRouteProducer, { stream: replay() })
    },
    refuse() {
      if (settled) return
      settled = 'refused'
      abort.abort(new TurnAdmissionRefusedError())
      reject(new TurnAdmissionRefusedError())
      queue.length = 0
      // Stop pulling a producer that ignores the signal; its events are dropped either way.
      void started.then((producer) => (producer.stream as AsyncIterable<ChatRouteEvent> & { return?: () => unknown }).return?.(), () => {})
        .catch(() => {})
    },
  }
}
