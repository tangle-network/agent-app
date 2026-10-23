/** Router calls overlap the lock, history recheck, user insert and gates.
 * authorize already verified identity/access; the model service enforces spend.
 * Events remain buffered until admission commits. Refusal cancels the call and
 * drops its output; tools and durable effects must wait for args.admitted.
 * Ordinary functions and Sandbox backends never execute speculatively.
 */
import type { TurnTrace } from '../turn-trace/recorder'
import type { ChatRouteEvent, ChatTurnProduceArgs, ChatTurnRouteProducer, CreateChatTurnRoutesOptions } from './turn-route-contracts'
import { routerRouteProducer, sandboxRouteProducer } from './route-producer'
import { withProducerStream } from './producer-stream'

/** Thrown into `args.admitted` when the turn was refused after its producer started. */
export class TurnAdmissionRefusedError extends Error {
  constructor() {
    super('The turn was refused after its producer started; its output was discarded.')
    this.name = 'TurnAdmissionRefusedError'
  }
}

export interface DispatchedProducer<TContext, TResource = unknown> {
  /** The admission chain committed: hand the producer its final args and return it, with what it already emitted first. */
  take(args: ChatTurnProduceArgs<TContext, TResource>): Promise<ChatTurnRouteProducer>
  /** The turn ended without the producer: abort it and discard its output. Idempotent; a no-op after `take`. */
  refuse(): void
}

/**
 * Start `produce` now with the args known before the lock. `args.admitted`
 * resolves to the final args at `take`, or rejects at `refuse`; the producer
 * writes nothing durable before it resolves. Its stream is drained into memory
 * from the start, so a producer that only works while pulled still dispatches.
 */
function dispatchProducerFirst<TContext, TResource = unknown>(
  produce: (args: ChatTurnProduceArgs<TContext, TResource>) => ChatTurnRouteProducer | Promise<ChatTurnRouteProducer>,
  args: ChatTurnProduceArgs<TContext, TResource>,
  trace: TurnTrace,
): DispatchedProducer<TContext, TResource> {
  const abort = new AbortController()
  let admit!: (final: ChatTurnProduceArgs<TContext, TResource>) => void
  let reject!: (error: Error) => void
  const admitted = new Promise<ChatTurnProduceArgs<TContext, TResource>>((resolve, fail) => { admit = resolve; reject = fail })
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
    admissionSignal: args.admissionSignal ? AbortSignal.any([args.admissionSignal, abort.signal]) : abort.signal,
    ...(handoffCompletion ? { handoffCompletion: () => admitted.then(() => handoffCompletion()) } : {}),
  }))
  // Register before construction resolves: admission can refuse and return
  // while a producer is still awaiting an ephemeral credential or resource.
  const cleanup = started.then(producer => producer.cleanup, () => undefined)
  args.waitUntil?.(cleanup)
  void cleanup.catch(() => {})
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
      return withProducerStream(producer, replay())
    },
    refuse() {
      if (settled) return
      settled = 'refused'
      reject(new TurnAdmissionRefusedError())
      stop(new TurnAdmissionRefusedError())
    },
  }
}

/** Select once, so admission's context mutations cannot switch execution backends. */
export function selectTurnProducer<TContext, TResource = unknown>(
  produce: CreateChatTurnRoutesOptions<TContext, TResource>['produce'],
  args: ChatTurnProduceArgs<TContext, TResource>,
) {
  if (typeof produce === 'function') return { produce, router: false }
  if (produce.when?.(args) ?? true) return {
    produce: async (final: ChatTurnProduceArgs<TContext, TResource>) => routerRouteProducer(await produce.router(final), final),
    router: true,
  }
  if (!produce.sandbox) throw new Error('The turn selected the Sandbox backend without a Sandbox producer')
  const sandbox = produce.sandbox
  return { produce: async (final: ChatTurnProduceArgs<TContext, TResource>) => sandboxRouteProducer(await sandbox(final), final), router: false }
}

/** A reused user row must pass duplicate/refusal checks before another model call. */
export function dispatchFirstFor<TContext, TResource = unknown>(
  selected: ReturnType<typeof selectTurnProducer<TContext, TResource>>,
  args: ChatTurnProduceArgs<TContext, TResource>,
  trace: TurnTrace,
): DispatchedProducer<TContext, TResource> | undefined {
  return selected.router && !args.userMessageId ? dispatchProducerFirst(selected.produce, args, trace) : undefined
}
