// @vitest-environment jsdom
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantClient, AssistantThreadSummary } from "./client";
import { AssistantClientProvider } from "./client-context";
import { useAssistantThreads } from "./useAssistantThreads";

function thread(id: string): AssistantThreadSummary {
  return { id, title: id, createdAt: "", updatedAt: "" };
}

function setup() {
  const fetchThreads = vi.fn();
  const deleteThread = vi.fn();
  const client: AssistantClient = {
    fetchModels: vi.fn(),
    fetchThreads,
    fetchThreadHistory: vi.fn(),
    streamChat: vi.fn(),
    confirmProposal: vi.fn(),
    deleteThread,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AssistantClientProvider client={client}>{children}</AssistantClientProvider>
  );
  return { fetchThreads, deleteThread, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAssistantThreads", () => {
  it("does not fetch on mount and populates only on refresh", async () => {
    const { fetchThreads, wrapper } = setup();
    fetchThreads.mockResolvedValue([thread("t1")]);
    const { result } = renderHook(() => useAssistantThreads("userA"), {
      wrapper,
    });
    // Lazy by design — no request until the consumer asks for it.
    expect(fetchThreads).not.toHaveBeenCalled();
    expect(result.current.loaded).toBe(false);

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(result.current.loaded).toBe(true);
  });

  it("optimistically removes a thread and calls deleteThread", async () => {
    const { fetchThreads, deleteThread, wrapper } = setup();
    fetchThreads.mockResolvedValue([thread("t1"), thread("t2")]);
    deleteThread.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useAssistantThreads("userA"), {
      wrapper,
    });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    await act(async () => {
      await result.current.remove("t1");
    });
    expect(deleteThread).toHaveBeenCalledWith("t1");
    expect(result.current.threads.map((t) => t.id)).toEqual(["t2"]);
  });

  it("restores the list when a delete fails", async () => {
    const { fetchThreads, deleteThread, wrapper } = setup();
    fetchThreads.mockResolvedValue([thread("t1"), thread("t2")]);
    deleteThread.mockResolvedValue({ ok: false });
    const { result } = renderHook(() => useAssistantThreads("userA"), {
      wrapper,
    });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    await act(async () => {
      await result.current.remove("t1");
    });
    // The optimistic removal is rolled back by a reload, so the row returns.
    await waitFor(() =>
      expect(result.current.threads.map((t) => t.id)).toEqual(["t1", "t2"]),
    );
  });

  it("a refresh during a pending delete does not resurrect the removed row", async () => {
    const { fetchThreads, deleteThread, wrapper } = setup();
    fetchThreads.mockResolvedValue([thread("t1"), thread("t2")]);
    let resolveDelete: (v: { ok: boolean }) => void = () => {};
    deleteThread.mockReturnValue(
      new Promise<{ ok: boolean }>((r) => {
        resolveDelete = r;
      }),
    );
    const { result } = renderHook(() => useAssistantThreads("userA"), {
      wrapper,
    });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    // Begin deleting t2 (stays pending) — optimistically removed.
    let removed!: Promise<{ ok: boolean }>;
    act(() => {
      removed = result.current.remove("t2");
    });
    expect(result.current.threads.map((t) => t.id)).toEqual(["t1"]);

    // A refresh resolves while the delete is still in flight, returning [t1, t2]
    // (the server hasn't applied the delete yet) — t2 must stay filtered.
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() =>
      expect(result.current.threads.map((t) => t.id)).toEqual(["t1"]),
    );

    // The delete then succeeds; the row remains gone.
    await act(async () => {
      resolveDelete({ ok: true });
      await removed;
    });
    expect(result.current.threads.map((t) => t.id)).toEqual(["t1"]);
  });

  it("keeps a pending delete filtered across a scope swap and back", async () => {
    const { fetchThreads, deleteThread, wrapper } = setup();
    fetchThreads.mockResolvedValue([thread("t1"), thread("t2")]);
    // The DELETE never resolves — it is still in flight across the swap.
    deleteThread.mockReturnValue(new Promise<{ ok: boolean }>(() => {}));
    const { result, rerender } = renderHook(
      ({ uid }) => useAssistantThreads(uid),
      { initialProps: { uid: "userA" }, wrapper },
    );
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    // Delete t2 (stays pending) — optimistically removed under userA.
    act(() => {
      result.current.remove("t2");
    });
    expect(result.current.threads.map((t) => t.id)).toEqual(["t1"]);

    // Swap to userB and back to userA while the DELETE is still in flight. The
    // scope swap must NOT clear the pending-delete set.
    act(() => rerender({ uid: "userB" }));
    act(() => rerender({ uid: "userA" }));

    // A refresh returns [t1, t2] (the server has not applied the delete yet);
    // t2 must stay filtered rather than resurrecting.
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() =>
      expect(result.current.threads.map((t) => t.id)).toEqual(["t1"]),
    );
  });

  it("drops a result that resolves after the user changed", async () => {
    const { fetchThreads, wrapper } = setup();
    let resolveA: (v: AssistantThreadSummary[] | null) => void = () => {};
    fetchThreads.mockReturnValueOnce(
      new Promise<AssistantThreadSummary[] | null>((r) => {
        resolveA = r;
      }),
    );
    const { result, rerender } = renderHook(
      ({ uid }) => useAssistantThreads(uid),
      { initialProps: { uid: "userA" }, wrapper },
    );
    act(() => result.current.refresh());
    // Switch to user B before A's request resolves.
    act(() => rerender({ uid: "userB" }));
    // A's request now resolves — its threads must NOT land under user B.
    await act(async () => {
      resolveA([thread("a-thread")]);
    });
    expect(result.current.threads).toEqual([]);
  });

  it("clears the prior user's threads immediately on a user change", async () => {
    const { fetchThreads, wrapper } = setup();
    fetchThreads.mockResolvedValue([thread("t1")]);
    const { result, rerender } = renderHook(
      ({ uid }) => useAssistantThreads(uid),
      { initialProps: { uid: "userA" }, wrapper },
    );
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    act(() => rerender({ uid: "userB" }));
    expect(result.current.threads).toEqual([]);
    expect(result.current.loaded).toBe(false);
  });

  it("drops an old client's result after a transport swap for the same user", async () => {
    let resolveOld: (v: AssistantThreadSummary[] | null) => void = () => {};
    const oldClient: AssistantClient = {
      fetchThreads: vi.fn().mockReturnValue(
        new Promise<AssistantThreadSummary[] | null>((r) => {
          resolveOld = r;
        }),
      ),
      fetchModels: vi.fn(),
      fetchThreadHistory: vi.fn(),
      streamChat: vi.fn(),
      confirmProposal: vi.fn(),
      deleteThread: vi.fn(),
    };
    const newClient: AssistantClient = {
      fetchThreads: vi.fn().mockResolvedValue([]),
      fetchModels: vi.fn(),
      fetchThreadHistory: vi.fn(),
      streamChat: vi.fn(),
      confirmProposal: vi.fn(),
      deleteThread: vi.fn(),
    };

    function Show() {
      const t = useAssistantThreads("userA");
      const { refresh } = t;
      // Fire one fetch on mount so the OLD client's request is in flight.
      useEffect(() => {
        refresh();
      }, [refresh]);
      return (
        <div data-testid="threads">{t.threads.map((x) => x.id).join(",")}</div>
      );
    }
    function Harness({ client }: { client: AssistantClient }) {
      return (
        <AssistantClientProvider client={client}>
          <Show />
        </AssistantClientProvider>
      );
    }

    const { rerender } = render(<Harness client={oldClient} />);
    expect(oldClient.fetchThreads).toHaveBeenCalledTimes(1);

    // Swap the transport for the SAME user before the old request resolves.
    rerender(<Harness client={newClient} />);

    // The old client's request now resolves — its threads must NOT land under the
    // new client (aborted + guarded by the captured client).
    await act(async () => {
      resolveOld([thread("old-thread")]);
    });
    expect(screen.getByTestId("threads").textContent).toBe("");
  });
});
