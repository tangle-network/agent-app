/**
 * The product producer's own time at either end of its stream. Before its first event it does its setup (keys, reads,
 * prompt composition, a box it resolves itself); after its last it runs the cleanup its stream holds until it returns
 * (revocations, a charge). Neither is inside a span the route records, so each was a gap no span named: 745 ms and
 * 1,382 ms of a 12.6 s Tax Router turn, 2,720 ms and 1,296 ms of a 20.5 s box turn. A product that measures its own
 * steps inside them (`trace.measure`) nests nothing here: these two spans only say whose time it was.
 */
import type { TurnTrace } from '../turn-trace/recorder'

/** Pass a producer's stream through unchanged, recording `produce.setup` until its first event and `produce.settle`
 *  from the request after its last event until it ends. */
export async function* traceProducerStream<T>(stream: AsyncIterable<T>, trace: TurnTrace): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]()
  let first = true
  let asked = Date.now()
  try {
    for (;;) {
      const next = await iterator.next()
      // Only the first wait and the last are the producer's own; the waits between events are its model and tools.
      if (first) trace.record('produce.setup', 'other', asked, Date.now())
      else if (next.done) trace.record('produce.settle', 'other', asked, Date.now())
      first = false
      if (next.done) return
      yield next.value
      asked = Date.now()
    }
  } finally {
    await iterator.return?.()
  }
}
