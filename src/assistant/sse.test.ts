import { describe, expect, it, vi } from "vitest";
import { readSSEEvents } from "./sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe("readSSEEvents", () => {
  it("preserves frame boundaries and trailing events when every byte arrives separately", async () => {
    const bytes = new TextEncoder().encode(
      '\uFEFFevent: delta\r\nid: first\r\ndata: {"text":\r\ndata: "😀"}\r\n\r\n' +
      ': keepalive\r\nevent: ignored\r\nid: stale\r\n\r\n' +
      'data: raw payload\n\n' +
      'event: done\ndata: {"ok":true}',
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const events: unknown[] = [];
    await readSSEEvents(body, (event) => events.push(event));
    expect(events).toEqual([
      { data: { text: "😀" }, rawData: '{"text":\n"😀"}', eventId: "first", eventType: "delta" },
      { data: "raw payload", rawData: "raw payload", eventId: undefined, eventType: undefined },
      { data: { ok: true }, rawData: '{"ok":true}', eventId: undefined, eventType: "done" },
    ]);
    expect(body.locked).toBe(false);
  });

  it("emits each event with its name and parsed data, in order", async () => {
    const events: Array<{ type?: string; data: unknown }> = [];
    await readSSEEvents(
      streamOf([
        'event: thread\ndata: {"threadId":"T","turnId":"R"}\n\n',
        'event: delta\ndata: {"text":"hi"}\n\n',
      ]),
      (e) => events.push({ type: e.eventType, data: e.data }),
    );
    expect(events).toEqual([
      { type: "thread", data: { threadId: "T", turnId: "R" } },
      { type: "delta", data: { text: "hi" } },
    ]);
  });

  it("reassembles a multi-byte character split across chunks", async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode('data: {"text":"😀"}\n\n');
    const splitAt = bytes.length - 4; // mid-emoji
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, splitAt));
        c.enqueue(bytes.slice(splitAt));
        c.close();
      },
    });
    const events: unknown[] = [];
    await readSSEEvents(stream, (e) => events.push(e.data));
    expect(events).toEqual([{ text: "😀" }]);
  });

  it("releases the reader lock even when a handler throws", async () => {
    const stream = streamOf(["event: a\ndata: 1\n\n"]);
    await expect(
      readSSEEvents(stream, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Lock released by the finally → a new reader can be acquired.
    expect(() => stream.getReader()).not.toThrow();
  });

  it("cancels the underlying stream when a handler throws", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("event: a\ndata: 1\n\n"));
      },
      cancel,
    });
    await expect(
      readSSEEvents(stream, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A failed turn must not leave the response open and buffering.
    expect(cancel).toHaveBeenCalled();
  });
});
