// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantClient } from "./client";
import { AssistantClientProvider } from "./client-context";
import { useAssistantChat } from "./useAssistantChat";

// platform-web's vitest defaults to the node environment; this file opts into
// jsdom (above) so React can render the hook. A minimal localStorage stub keeps
// the persistence layer working regardless of the jsdom build.
function installLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k: string) => (store.has(k) ? store.get(k) : null) ?? null,
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      removeItem: (k: string) => store.delete(k),
      setItem: (k: string, v: string) => store.set(k, String(v)),
    },
  });
}

const enc = new TextEncoder();

/** An SSE Response whose body emits the given frames then closes. */
function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return { ok: true, body } as unknown as Response;
}

/** A Response whose SSE body is pushed/closed by the test, to model events that
 *  arrive after a user switch or reset. */
function controllableSse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: { ok: true, body } as unknown as Response,
    push: (frame: string) => controller.enqueue(enc.encode(frame)),
    close: () => controller.close(),
  };
}

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    json: async () => value,
  } as unknown as Response;
}

const DONE = 'event: done\ndata: {"turnId":"R","status":"completed"}\n\n';

// The hook reads its transport from context; one real same-origin client running
// against the per-test stubbed `fetch` exercises the streaming path exactly as in
// production. A stable identity keeps the hook's effects from re-running.
const testClient = createAssistantClient({ baseUrl: "/api/v1/assistant" });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AssistantClientProvider client={testClient}>
    {children}
  </AssistantClientProvider>
);

beforeEach(() => {
  installLocalStorage();
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("useAssistantChat", () => {
  it("issues only one chat request for two same-tick sends", () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([DONE]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAssistantChat("userA"), { wrapper });
    act(() => {
      result.current.send("first");
      result.current.send("second");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a new send while a proposal is awaiting confirmation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'event: tool_proposal\ndata: {"proposalId":"p1","callId":"c1","name":"create_workflow","args":{"yaml":"name: x"}}\n\n',
          'event: done\ndata: {"turnId":"R","status":"completed","proposed":true}\n\n',
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAssistantChat("userA"), { wrapper });
    act(() => {
      result.current.send("make a workflow");
    });
    await waitFor(() =>
      expect(result.current.state.status).toBe("awaiting_confirm"),
    );
    expect(result.current.state.pendingProposals).toHaveLength(1);

    act(() => {
      result.current.send("another message");
    });
    // Still one chat request — the second send was refused.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("executes a proposal only once when confirm is double-clicked", async () => {
    const executeCalls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/tools/execute")) {
        executeCalls.push(url);
        return Promise.resolve(
          jsonResponse({ success: true, output: { created: true } }),
        );
      }
      return Promise.resolve(
        sseResponse([
          'event: tool_proposal\ndata: {"proposalId":"p1","callId":"c1","name":"create_workflow","args":{"yaml":"name: x"}}\n\n',
          'event: done\ndata: {"turnId":"R","status":"completed","proposed":true}\n\n',
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAssistantChat("userA"), { wrapper });
    act(() => {
      result.current.send("make a workflow");
    });
    await waitFor(() =>
      expect(result.current.state.pendingProposals).toHaveLength(1),
    );
    const proposal = result.current.state.pendingProposals[0]!;

    await act(async () => {
      void result.current.confirm(proposal);
      void result.current.confirm(proposal);
    });

    expect(executeCalls).toHaveLength(1);
  });

  it("drops a prior user's late stream events after a user switch", async () => {
    const a = controllableSse();
    const fetchMock = vi.fn().mockResolvedValue(a.response);
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ uid }) => useAssistantChat(uid),
      { initialProps: { uid: "userA" }, wrapper },
    );
    act(() => {
      result.current.send("hello from A");
    });
    await act(async () => {
      a.push('event: thread\ndata: {"threadId":"thread-A","turnId":"R"}\n\n');
    });
    await waitFor(() => expect(result.current.state.threadId).toBe("thread-A"));

    // Switch to user B: the conversation should hydrate empty for B.
    act(() => {
      rerender({ uid: "userB" });
    });
    await waitFor(() => expect(result.current.state.ownerId).toBe("userB"));

    // A late event from user A's stream must not land in B's conversation.
    await act(async () => {
      a.push('event: delta\ndata: {"text":"LEAKED-FROM-A"}\n\n');
      a.close();
    });

    expect(result.current.state.threadId).toBeNull();
    expect(
      result.current.state.messages.some((m) => m.text.includes("LEAKED")),
    ).toBe(false);
  });

  it("invalidates late stream events after reset", async () => {
    const s = controllableSse();
    const fetchMock = vi.fn().mockResolvedValue(s.response);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAssistantChat("userA"), { wrapper });
    act(() => {
      result.current.send("hello");
    });
    await act(async () => {
      s.push('event: thread\ndata: {"threadId":"thread-1","turnId":"R"}\n\n');
    });
    await waitFor(() => expect(result.current.state.threadId).toBe("thread-1"));

    act(() => {
      result.current.reset();
    });
    await waitFor(() => expect(result.current.state.threadId).toBeNull());

    await act(async () => {
      s.push('event: delta\ndata: {"text":"AFTER-RESET"}\n\n');
      s.close();
    });

    expect(
      result.current.state.messages.some((m) => m.text.includes("AFTER-RESET")),
    ).toBe(false);
  });

  it("restores persisted thread history on mount", async () => {
    localStorage.setItem(
      "assistant:v1:userA",
      JSON.stringify({ threadId: "T_restore", model: null }),
    );
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/threads/") && url.includes("/messages")) {
        return Promise.resolve(
          jsonResponse({
            success: true,
            threadId: "T_restore",
            messages: [
              { id: "h1", role: "user", text: "earlier question" },
              { id: "h2", role: "assistant", text: "earlier answer" },
            ],
          }),
        );
      }
      return Promise.resolve(sseResponse([DONE]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAssistantChat("userA"), { wrapper });
    await waitFor(() => expect(result.current.state.messages).toHaveLength(2));
    expect(result.current.state.messages.map((m) => m.text)).toEqual([
      "earlier question",
      "earlier answer",
    ]);
    expect(result.current.state.threadId).toBe("T_restore");
  });

  it("clears a persisted thread id when history restore 404s (thread gone)", async () => {
    localStorage.setItem(
      "assistant:v1:userA",
      JSON.stringify({ threadId: "T_dead", model: null }),
    );
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/threads/") && url.includes("/messages")) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({ error: { code: "THREAD_NOT_FOUND" } }),
        } as Response);
      }
      return Promise.resolve(sseResponse([DONE]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAssistantChat("userA"), { wrapper });
    // The dead thread is dropped from state and from storage, so the next send
    // starts fresh instead of 404-ing forever.
    await waitFor(() => expect(result.current.state.threadId).toBeNull());
    expect(
      JSON.parse(localStorage.getItem("assistant:v1:userA") ?? "{}").threadId,
    ).toBeNull();
  });

  it("persists the selected model per user and sends it on the next turn", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([DONE]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAssistantChat("userA"), { wrapper });
    act(() => {
      result.current.setModel("anthropic/picked");
    });
    expect(result.current.selectedModel).toBe("anthropic/picked");
    expect(
      JSON.parse(localStorage.getItem("assistant:v1:userA") ?? "{}").model,
    ).toBe("anthropic/picked");

    act(() => {
      result.current.send("hi");
    });
    const chatCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/assistant/chat"),
    );
    expect(chatCall).toBeTruthy();
    const body = JSON.parse((chatCall?.[1] as { body: string }).body) as {
      model?: string;
    };
    expect(body.model).toBe("anthropic/picked");
  });

  it("switchThread opens a past thread and loads its transcript", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/threads/") && url.includes("/messages")) {
        return Promise.resolve(
          jsonResponse({
            success: true,
            threadId: "T_old",
            messages: [
              { id: "o1", role: "user", text: "old question" },
              { id: "o2", role: "assistant", text: "old answer" },
            ],
          }),
        );
      }
      return Promise.resolve(sseResponse([DONE]));
    });
    vi.stubGlobal("fetch", fetchMock);

    // Start with no active thread, then open one from history.
    const { result } = renderHook(() => useAssistantChat("userA"), { wrapper });
    act(() => {
      result.current.switchThread("T_old");
    });
    await waitFor(() => expect(result.current.state.threadId).toBe("T_old"));
    await waitFor(() => expect(result.current.state.messages).toHaveLength(2));
    expect(result.current.state.messages.map((m) => m.text)).toEqual([
      "old question",
      "old answer",
    ]);
    // The newly-opened thread becomes the persisted active thread.
    expect(
      JSON.parse(localStorage.getItem("assistant:v1:userA") ?? "{}").threadId,
    ).toBe("T_old");
  });

  it("refuses switchThread while a turn is streaming", async () => {
    const s = controllableSse();
    const fetchMock = vi.fn().mockResolvedValue(s.response);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAssistantChat("userA"), { wrapper });
    act(() => {
      result.current.send("hi");
    });
    await act(async () => {
      s.push(
        'event: thread\ndata: {"threadId":"thread-live","turnId":"R"}\n\n',
      );
    });
    await waitFor(() => expect(result.current.state.status).toBe("streaming"));

    // Switching mid-stream would abandon the live turn — it must be refused.
    act(() => {
      result.current.switchThread("T_other");
    });
    expect(result.current.state.threadId).toBe("thread-live");
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("T_other")),
    ).toBe(false);

    await act(async () => {
      s.close();
    });
  });

  it("holds the composer closed (restoring) until a switched transcript loads", async () => {
    let resolveHistory!: () => void;
    const gate = new Promise<void>((r) => {
      resolveHistory = r;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/threads/") && url.includes("/messages")) {
        // Defer the transcript until the test releases it.
        return gate.then(() =>
          jsonResponse({
            success: true,
            threadId: "T_old",
            messages: [{ id: "o1", role: "user", text: "old q" }],
          }),
        );
      }
      return Promise.resolve(sseResponse([DONE]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAssistantChat("userA"), { wrapper });
    act(() => {
      result.current.switchThread("T_old");
    });
    await waitFor(() => expect(result.current.restoring).toBe(true));

    // A send during restore is refused — no chat request goes out.
    act(() => {
      result.current.send("too early");
    });
    expect(
      fetchMock.mock.calls.some((c) =>
        String(c[0]).includes("/assistant/chat"),
      ),
    ).toBe(false);

    // Release the transcript: restoring clears and the messages restore.
    await act(async () => {
      resolveHistory();
    });
    await waitFor(() => expect(result.current.restoring).toBe(false));
    expect(result.current.state.messages.map((m) => m.text)).toContain("old q");
  });

  it("drops the thread and won't run a turn against it when the transcript fails to load", async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes("/threads/") && url.includes("/messages")) {
        // Failed load → fetchThreadHistory resolves to {status:"error"}.
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({}),
        } as Response);
      }
      return Promise.resolve(sseResponse([DONE]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAssistantChat("userA"), { wrapper });
    act(() => {
      result.current.switchThread("T_secret");
    });
    // The failed load drops the active thread and surfaces an error.
    await waitFor(() => expect(result.current.state.threadId).toBeNull());
    await waitFor(() => expect(result.current.restoring).toBe(false));
    expect(result.current.state.error?.code).toBe("HISTORY_LOAD_FAILED");

    // A send now starts a FRESH thread — it must never target T_secret.
    act(() => {
      result.current.send("hello");
    });
    await waitFor(() => {
      const chatCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("/assistant/chat"),
      );
      expect(chatCall).toBeTruthy();
      const body = JSON.parse((chatCall?.[1] as { body: string }).body) as {
        threadId?: string;
      };
      expect(body.threadId).toBeUndefined();
    });
  });

  it("clears the selected model after a MODEL_NOT_ALLOWED rejection", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/assistant/chat")) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({
            error: { code: "MODEL_NOT_ALLOWED", message: "no" },
          }),
        } as Response);
      }
      return Promise.resolve(sseResponse([DONE]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAssistantChat("userA"), { wrapper });
    act(() => {
      result.current.setModel("anthropic/removed");
    });
    act(() => {
      result.current.send("hi");
    });
    // The rejected model is cleared so the next send falls back to the default.
    await waitFor(() => expect(result.current.selectedModel).toBeNull());
  });
});
