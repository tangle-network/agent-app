import { parseSSEStream, type ParsedSSEEvent } from "@tangle-network/agent-core/sse";

/**
 * Read the assistant's POST response through the shared SSE transport. The
 * native EventSource is GET-only and cannot send the chat request body.
 *
 * Events retain their wire order and JSON/raw payload mapping. The shared
 * reader owns UTF-8 framing, cancellation on failure, and releasing its lock.
 */
export async function readSSEEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ParsedSSEEvent) => void,
): Promise<void> {
  for await (const event of parseSSEStream(body)) onEvent(event);
}
