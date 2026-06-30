import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantClient } from "./client";
import type { AssistantStreamEvent } from "./types";

// One client for every case: the transport config is irrelevant to these tests
// (they stub `fetch`), so a same-origin base is fine. The point under test is the
// request shaping and the defensive wire parsing, which are config-independent.
const client = createAssistantClient({ baseUrl: "/api/v1/assistant" });

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamChat", () => {
  it("emits each SSE event as a typed event in wire order, dropping pings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseBody([
          'event: thread\ndata: {"threadId":"T1","turnId":"R1"}\n\n',
          'event: delta\ndata: {"text":"Hel"}\n\n',
          "event: ping\ndata: {}\n\n",
          'event: delta\ndata: {"text":"lo"}\n\n',
          'event: usage\ndata: {"promptTokens":1,"completionTokens":2,"costUsd":0.001,"balanceUsd":3.2}\n\n',
          'event: done\ndata: {"turnId":"R1","status":"completed"}\n\n',
        ]),
      }),
    );

    const events: AssistantStreamEvent[] = [];
    await client.streamChat(
      { message: "hi" },
      (e) => events.push(e),
      new AbortController().signal,
    );

    expect(events.map((e) => e.type)).toEqual([
      "thread",
      "delta",
      "delta",
      "usage",
      "done",
    ]);
    expect(events[1]).toEqual({ type: "delta", data: { text: "Hel" } });
    expect(events[3]).toEqual({
      type: "usage",
      data: {
        promptTokens: 1,
        completionTokens: 2,
        costUsd: 0.001,
        balanceUsd: 3.2,
        replayed: false,
      },
    });
  });

  it("surfaces a pre-stream HTTP error body as a single error event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        body: null,
        json: async () => ({
          success: false,
          error: {
            code: "INSUFFICIENT_BALANCE",
            message: "Credit balance is exhausted",
          },
        }),
      }),
    );

    const events: AssistantStreamEvent[] = [];
    await client.streamChat(
      { message: "hi" },
      (e) => events.push(e),
      new AbortController().signal,
    );

    expect(events).toEqual([
      {
        type: "error",
        data: {
          code: "INSUFFICIENT_BALANCE",
          message: "Credit balance is exhausted",
        },
      },
    ]);
  });

  it("emits STREAM_CLOSED when the body ends without a done or error frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseBody([
          'event: thread\ndata: {"threadId":"T","turnId":"R"}\n\n',
          'event: delta\ndata: {"text":"partial"}\n\n',
        ]),
      }),
    );
    const events: AssistantStreamEvent[] = [];
    await client.streamChat(
      { message: "hi" },
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(events.at(-1)).toEqual({
      type: "error",
      data: {
        code: "STREAM_CLOSED",
        message: "The assistant stream ended unexpectedly",
      },
    });
  });

  it("does not append STREAM_CLOSED when the turn ends with done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseBody([
          'event: done\ndata: {"turnId":"R","status":"completed"}\n\n',
        ]),
      }),
    );
    const events: AssistantStreamEvent[] = [];
    await client.streamChat(
      { message: "hi" },
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  it("emits NO_BODY for an ok response with a null body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: null }));
    const events: AssistantStreamEvent[] = [];
    await client.streamChat(
      { message: "hi" },
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(events).toEqual([
      {
        type: "error",
        data: {
          code: "NO_BODY",
          message: "The assistant stream is unavailable",
        },
      },
    ]);
  });

  it("drops malformed frames missing required fields rather than coercing them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseBody([
          // thread missing turnId, tool_proposal missing callId — both dropped.
          'event: thread\ndata: {"threadId":"T"}\n\n',
          'event: tool_proposal\ndata: {"proposalId":"p","name":"create_workflow","args":{}}\n\n',
          // a well-formed delta still parses.
          'event: delta\ndata: {"text":"ok"}\n\n',
          'event: done\ndata: {"turnId":"R","status":"completed"}\n\n',
        ]),
      }),
    );
    const events: AssistantStreamEvent[] = [];
    await client.streamChat(
      { message: "hi" },
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(events.map((e) => e.type)).toEqual(["delta", "done"]);
    // No "undefined" string leaked into a thread/proposal event.
    expect(events.some((e) => e.type === "thread")).toBe(false);
    expect(events.some((e) => e.type === "tool_proposal")).toBe(false);
  });

  it("preserves each requirement's kind and connectUrl on a live tool_proposal", async () => {
    // A GitHub PR-review workflow references github twice: the event source is
    // the GitHub App installation (kind: github_app, here NOT installed) and the
    // action grant is the OAuth connection (kind: integration, here connected).
    // The card distinguishes them only by `kind`/`connectUrl`; dropping those on
    // the live path collapsed both to a "GitHub / not connected" integration row,
    // showing the same provider as connected AND not connected at once.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseBody([
          `event: tool_proposal\ndata: ${JSON.stringify({
            proposalId: "p1",
            callId: "c1",
            name: "create_workflow",
            args: { yaml: "name: pr-review-opencode" },
            requirements: [
              {
                provider: "github",
                kind: "github_app",
                connected: false,
                connectUrl: "https://github.com/apps/tangle/installations/new",
              },
              {
                provider: "github",
                kind: "integration",
                connected: true,
                connectUrl: "/app/integrations",
              },
            ],
          })}\n\n`,
          'event: done\ndata: {"turnId":"R","status":"completed"}\n\n',
        ]),
      }),
    );
    const events: AssistantStreamEvent[] = [];
    await client.streamChat(
      { message: "review my PRs" },
      (e) => events.push(e),
      new AbortController().signal,
    );
    const proposal = events.find((e) => e.type === "tool_proposal");
    expect(proposal).toBeTruthy();
    if (proposal?.type !== "tool_proposal") return;
    expect(proposal.data.requirements).toEqual([
      {
        provider: "github",
        kind: "github_app",
        connected: false,
        connectUrl: "https://github.com/apps/tangle/installations/new",
      },
      {
        provider: "github",
        kind: "integration",
        connected: true,
        connectUrl: "/app/integrations",
      },
    ]);
  });

  it("parses CRLF-framed events end to end", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseBody([
          'event: delta\r\ndata: {"text":"hi"}\r\n\r\n',
          'event: done\r\ndata: {"turnId":"R","status":"completed"}\r\n\r\n',
        ]),
      }),
    );
    const events: AssistantStreamEvent[] = [];
    await client.streamChat(
      { message: "hi" },
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(events.map((e) => e.type)).toEqual(["delta", "done"]);
    expect(events[0]).toEqual({ type: "delta", data: { text: "hi" } });
  });

  it("forwards threadId and turnKey in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([
        'event: done\ndata: {"turnId":"R","status":"completed"}\n\n',
      ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await client.streamChat(
      { message: "continue", threadId: "T9", turnKey: "k1" },
      () => {},
      new AbortController().signal,
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({
      message: "continue",
      threadId: "T9",
      turnKey: "k1",
    });
  });
});

describe("confirmProposal", () => {
  it("returns the tool output on a successful confirmation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, output: { created: true } }),
      }),
    );
    const result = await client.confirmProposal("prop_1");
    expect(result).toEqual({ ok: true, output: { created: true } });
  });

  it("returns the server's error message when the proposal can't be run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          success: false,
          error: {
            code: "PROPOSAL_EXPIRED",
            message: "This proposal has expired",
          },
        }),
      }),
    );
    const result = await client.confirmProposal("prop_1");
    expect(result).toEqual({ ok: false, error: "This proposal has expired" });
  });
});

describe("fetchModels", () => {
  it("parses the catalog (prompt price + context) and reports a list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          default: "anthropic/claude-sonnet-4-5",
          models: [
            {
              slug: "anthropic/claude-sonnet-4-5",
              label: "Claude Sonnet 4.5",
              promptUsdPerMillion: 3,
              contextTokens: 200000,
            },
            { slug: "openai/gpt-4o", label: "GPT 4o" },
          ],
        }),
      }),
    );
    const res = await client.fetchModels();
    expect(res.ok).toBe(true);
    expect(res.data.default).toBe("anthropic/claude-sonnet-4-5");
    expect(res.data.models[0]).toEqual({
      slug: "anthropic/claude-sonnet-4-5",
      label: "Claude Sonnet 4.5",
      promptUsdPerMillion: 3,
      contextTokens: 200000,
    });
    expect(res.data.models[1]).toEqual({
      slug: "openai/gpt-4o",
      label: "GPT 4o",
    });
  });

  it("reports an empty model list as not-ok so the caller retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ default: "x", models: [] }),
      }),
    );
    expect((await client.fetchModels()).ok).toBe(false);
  });

  it("reports a transport failure as not-ok with an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const res = await client.fetchModels();
    expect(res.ok).toBe(false);
    expect(res.data.models).toEqual([]);
  });
});

describe("fetchThreads", () => {
  it("parses the thread list, tolerating a null title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          threads: [
            {
              id: "t1",
              title: "Hello",
              createdAt: "2026-06-15T00:00:00Z",
              updatedAt: "2026-06-15T01:00:00Z",
            },
            { id: "t2", title: null, createdAt: "x", updatedAt: "y" },
          ],
        }),
      }),
    );
    expect(await client.fetchThreads()).toEqual([
      {
        id: "t1",
        title: "Hello",
        createdAt: "2026-06-15T00:00:00Z",
        updatedAt: "2026-06-15T01:00:00Z",
      },
      { id: "t2", title: null, createdAt: "x", updatedAt: "y" },
    ]);
  });

  it("returns null on a failed request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await client.fetchThreads()).toBeNull();
  });
});

describe("fetchThreadHistory", () => {
  it("restores messages and proposals, dropping malformed requirement elements", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          messages: [{ id: "t1:u", role: "user", text: "review my PR" }],
          proposals: [
            {
              proposalId: "p1",
              callId: "c1",
              name: "create_workflow",
              args: { yaml: "name: pr-review" },
              requirements: [
                {
                  provider: "github",
                  kind: "github_app",
                  connected: false,
                  connectUrl: null,
                },
                // Malformed: non-string provider — must be dropped, not crash
                // the card (providerLabel would call .toLowerCase() on it).
                { provider: 123, connected: false },
                // Malformed: missing the boolean `connected` — dropped.
                { provider: "slack" },
              ],
            },
          ],
        }),
      }),
    );
    const result = await client.fetchThreadHistory("t1");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.messages).toEqual([
      { id: "t1:u", role: "user", text: "review my PR" },
    ]);
    expect(result.proposals).toHaveLength(1);
    // Only the well-formed requirement survives.
    expect(result.proposals[0]!.requirements).toEqual([
      {
        provider: "github",
        kind: "github_app",
        connected: false,
        connectUrl: null,
      },
    ]);
  });

  it("tolerates a response with no proposals field (older server)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          messages: [{ id: "t1:u", role: "user", text: "hi" }],
        }),
      }),
    );
    const result = await client.fetchThreadHistory("t1");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.proposals).toEqual([]);
  });

  it("reports a deleted thread as gone (404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    expect((await client.fetchThreadHistory("t1")).status).toBe("gone");
  });
});
