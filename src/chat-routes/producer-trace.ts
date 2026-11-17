/**
 * The product producer's own time at either end of its stream. Before its first event it does its setup (keys, reads,
 * prompt composition, a box it resolves itself); after its last it runs the cleanup its stream holds until it returns
 * (revocations, a charge). Neither is inside a span the route records, so each was a gap no span named: 745 ms and
 * 1,382 ms of a 12.6 s Tax Router turn, 2,720 ms and 1,296 ms of a 20.5 s box turn. A product that measures its own
 * steps inside them (`trace.measure`) nests nothing here: these two spans only say whose time it was.
 */
import type { TurnTrace } from '../turn-trace/recorder'

/** A producer's stream, unchanged, recording `produce.setup` until its first event and `produce.settle` from the request
 *  after its last event until it ends. It only times `next`; `return` and `throw` reach the producer's own iterator
 *  untouched, so `yield*` over it behaves exactly as over the producer (a producer reads an early `return` as a stop). */
export function traceProducerStream<T>(stream: AsyncIterable<T>, trace: TurnTrace): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const inner = stream[Symbol.asyncIterator]()
      let first = true
      return {
        async next(...args: [] | [undefined]) {
          const asked = Date.now()
          const result = await inner.next(...args)
          // Only the first wait and the last are the producer's own; the waits between events are its model and tools.
          if (first) trace.record('produce.setup', 'other', asked, Date.now())
          else if (result.done) trace.record('produce.settle', 'other', asked, Date.now())
          first = false
          return result
        },
        ...(inner.return ? { return: inner.return.bind(inner) } : {}),
        ...(inner.throw ? { throw: inner.throw.bind(inner) } : {}),
      }
    },
  }
}
