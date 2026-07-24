import { getPartKey, mergePersistedPart, type StreamEvent } from '../stream/index'
import type { ChatTurnRouteProducer } from './turn-routes'

/** Resolve chat route events and materialize their durable state records */
export interface ChatRouteDurableProjection {
  observe(event: unknown): void | Promise<void>
  materialize(): Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>
}

/** Log chat route projection messages with optional metadata for durable processing */
export type ChatRouteDurableProjectionLogger =
  (message: string, meta?: Record<string, unknown>) => void

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Adds durable lifecycle projection to any producer lane without moving its
 * transport into agent-app. The projection is observed inline and its
 * materialized parts replace same-key pending snapshots after the stream
 * drains. Projection persistence is best-effort for the live lane: a store
 * outage must not terminate an otherwise healthy sandbox stream. Failures are
 * reported through the optional logger so products can retain diagnostics. */
export function withDurableChatProjection(
  producer: ChatTurnRouteProducer,
  projection: ChatRouteDurableProjection,
  log: ChatRouteDurableProjectionLogger = (message, meta) => console.error(message, meta ?? ''),
): ChatTurnRouteProducer {
  let projected: Array<Record<string, unknown>> = []
  async function* stream(): AsyncGenerator<StreamEvent, void, unknown> {
    for await (const event of producer.stream) {
      try {
        await projection.observe(event)
      } catch (error) {
        log('[chat-routes] durable projection observe failed', {
          eventType: event.type,
          error: errorMessage(error),
        })
      }
      yield event
    }
    try {
      projected = await projection.materialize()
    } catch (error) {
      log('[chat-routes] durable projection materialize failed', {
        error: errorMessage(error),
      })
    }
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
