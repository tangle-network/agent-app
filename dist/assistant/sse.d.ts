/**
 * POST-based SSE reading for the assistant chat stream. The browser
 * `EventSource` is GET-only and can't send a request body, so the stream is read
 * off a `fetch` POST response.
 *
 * The framing parser is vendored here (rather than depending on an internal SDK)
 * so this module stays self-contained and consumable by any host. It mirrors the
 * standard SSE wire format: events separated by a blank line, `event:` / `data:`
 * fields, `:`-prefixed comments ignored, multi-line `data:` joined with `\n`, and
 * each event's data JSON-parsed (falling back to the raw string).
 */
interface ParsedSSEEvent<T = unknown> {
    data: T;
    rawData: string;
    eventId?: string;
    eventType?: string;
}
/**
 * Read a fetch `Response` body and invoke `onEvent` for each parsed SSE event
 * (its `eventType` plus JSON-parsed `data`), in wire order. Resolves when the
 * stream closes. The caller owns abort (via the fetch `signal`).
 */
export declare function readSSEEvents(body: ReadableStream<Uint8Array>, onEvent: (event: ParsedSSEEvent) => void): Promise<void>;
export {};
