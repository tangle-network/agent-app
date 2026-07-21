import { getPartKey, mergePersistedPart, type StreamEvent } from '../stream/index'
import type { ChatTurnRouteProducer } from './turn-routes'

export interface ChatRouteDurableProjection {
  observe(event: unknown): void | Promise<void>
  materialize(): Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>
}

/** Adds durable lifecycle projection to any producer lane without moving its
 * transport into agent-app. The projection is observed inline and its
 * materialized parts replace same-key pending snapshots after the stream
 * drains. */
export function withDurableChatProjection(
  producer: ChatTurnRouteProducer,
  projection: ChatRouteDurableProjection,
): ChatTurnRouteProducer {
  let projected: Array<Record<string, unknown>> = []
  async function* stream(): AsyncGenerator<StreamEvent, void, unknown> {
    for await (const event of producer.stream) {
      await projection.observe(event)
      yield event
    }
    projected = await projection.materialize()
  }
  return {
    ...producer,
    stream: stream(),
    assistantParts: () => {
      const parts = producer.assistantParts?.() ?? []
      const order: string[] = []
      const byKey = new Map<string, Record<string, unknown>>()
      for (const part of [...parts, ...projected]) {
        const key = getPartKey(part)
        if (!byKey.has(key)) order.push(key)
        byKey.set(key, mergePersistedPart(byKey.get(key), part))
      }
      return order.map((key) => byKey.get(key)!)
    },
  }
}
