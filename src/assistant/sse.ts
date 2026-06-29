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

export interface ParsedSSEEvent<T = unknown> {
  data: T;
  rawData: string;
  eventId?: string;
  eventType?: string;
}

/**
 * Incremental SSE parser. Feed decoded string chunks via `push()`; call
 * `flush()` once the stream closes to emit any final buffered event.
 */
export class SSEChunkParser<T = unknown> {
  private buffer = "";
  private current: { id?: string; event?: string; data?: string } = {};

  push(chunk: string): ParsedSSEEvent<T>[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // The last element is a (possibly empty) partial line; hold it for the next
    // chunk so an event split across reads isn't parsed half-formed.
    this.buffer = lines.pop() ?? "";
    return this.processLines(lines);
  }

  flush(): ParsedSSEEvent<T>[] {
    const lines = this.buffer ? [this.buffer] : [];
    this.buffer = "";
    const events = this.processLines(lines);
    const finalEvent = this.parseCurrent();
    if (finalEvent) {
      events.push(finalEvent);
      this.current = {};
    }
    return events;
  }

  private processLines(lines: string[]): ParsedSSEEvent<T>[] {
    const events: ParsedSSEEvent<T>[] = [];
    for (const rawLine of lines) {
      // Tolerate CRLF framing: strip a trailing CR the "\n" split left behind.
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (line.startsWith(":")) continue; // comment / keepalive

      if (line === "") {
        const parsed = this.parseCurrent();
        if (parsed) events.push(parsed);
        this.current = {};
        continue;
      }

      if (line.startsWith("id:")) {
        this.current.id = line.slice(3).trim();
      } else if (line.startsWith("event:")) {
        this.current.event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        let value = line.slice(5);
        if (value.startsWith(" ")) value = value.slice(1);
        this.current.data =
          this.current.data !== undefined
            ? `${this.current.data}\n${value}`
            : value;
      }
    }
    return events;
  }

  private parseCurrent(): ParsedSSEEvent<T> | null {
    if (this.current.data === undefined) return null;
    const rawData = this.current.data.trim();
    if (!rawData) return null;
    let data: T;
    try {
      data = JSON.parse(rawData) as T;
    } catch {
      // A non-JSON payload is surfaced as the raw string; the caller's typed
      // mapper drops anything that isn't a well-formed object.
      data = rawData as unknown as T;
    }
    return {
      data,
      rawData,
      eventId: this.current.id,
      eventType: this.current.event,
    };
  }
}

/**
 * Read a fetch `Response` body and invoke `onEvent` for each parsed SSE event
 * (its `eventType` plus JSON-parsed `data`), in wire order. Resolves when the
 * stream closes. The caller owns abort (via the fetch `signal`).
 */
export async function readSSEEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ParsedSSEEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEChunkParser();
  // releaseLock in finally so an abort (read rejects) or a throwing consumer
  // can't leave the reader lock held on the stream.
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        onEvent(event);
      }
    }
    // Flush any bytes the streaming decoder held back (a multi-byte character
    // split across the final chunk), then any event still buffered in the parser.
    const tail = decoder.decode();
    if (tail) {
      for (const event of parser.push(tail)) onEvent(event);
    }
    for (const event of parser.flush()) onEvent(event);
  } catch (err) {
    // Cancel the underlying stream so a read error or a throwing handler doesn't
    // leave the response open and buffering for the rest of the session. Swallow
    // a cancel failure so it can't mask the original error.
    await reader.cancel(err).catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}
