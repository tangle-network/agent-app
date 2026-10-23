import type { ChatTurnRouteProducer } from './turn-route-contracts'

/** Replace transport while keeping every capability on its original receiver.
 * Object.create alone breaks class private state; spreading snapshots getters.
 * The separate target also permits wrapping an Object.freeze'd producer. */
export function withProducerStream(
  producer: ChatTurnRouteProducer,
  stream: ChatTurnRouteProducer['stream'],
): ChatTurnRouteProducer {
  return new Proxy(Object.create(producer) as ChatTurnRouteProducer, {
    get(_target, property) {
      if (property === 'stream') return stream
      const value: unknown = Reflect.get(producer, property, producer)
      return typeof value === 'function' ? value.bind(producer) : value
    },
  })
}
