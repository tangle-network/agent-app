import type { ChatTurnRouteProducer } from './turn-routes';
/** Resolve chat route events and materialize their durable state records */
export interface ChatRouteDurableProjection {
    observe(event: unknown): void | Promise<void>;
    materialize(): Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>;
}
/** Log chat route projection messages with optional metadata for durable processing */
export type ChatRouteDurableProjectionLogger = (message: string, meta?: Record<string, unknown>) => void;
/** Adds durable lifecycle projection to any producer lane without moving its
 * transport into agent-app. Purely STRUCTURAL: agent-app ships no implementer
 * of {@link ChatRouteDurableProjection} and deliberately does not — the one it
 * used to ship (`/durable-chat`) was removed in 0.44.0 with zero fleet imports.
 * Pass any `{ observe, materialize }` object backed by your own store. The projection is observed inline and its
 * materialized parts replace same-key pending snapshots after the stream
 * drains. Projection persistence is best-effort for the live lane: a store
 * outage must not terminate an otherwise healthy sandbox stream. Failures are
 * reported through the optional logger so products can retain diagnostics. */
export declare function withDurableChatProjection(producer: ChatTurnRouteProducer, projection: ChatRouteDurableProjection, log?: ChatRouteDurableProjectionLogger): ChatTurnRouteProducer;
