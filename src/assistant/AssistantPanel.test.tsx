// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AssistantPanel,
  nextModelSelection,
  toPickerModels,
} from "./AssistantPanel";
import {
  type AssistantClient,
  type AssistantModels,
  type AssistantThreadSummary,
  createAssistantClient,
} from "./client";
import { AssistantClientProvider } from "./client-context";
import { type AssistantState, initialAssistantState } from "./reducer";
import type { AssistantTranscriptView, PendingProposal } from "./types";
import type { AssistantChat } from "./useAssistantChat";

const client = createAssistantClient({ baseUrl: "/api/v1/assistant" });

const proposal: PendingProposal = {
  proposalId: "p1",
  callId: "c1",
  name: "create_workflow",
  args: { yaml: "name: demo" },
};

/** A minimal AssistantChat over a controlled state slice — the panel reads the
 *  state and the bound confirm/cancel handlers; the transport is never hit. */
function makeChat(over: Partial<AssistantState> = {}): AssistantChat {
  return {
    state: { ...initialAssistantState(), ownerId: "u1", ...over },
    confirmingIds: new Set<string>(),
    selectedModel: null,
    setModel: vi.fn(),
    send: vi.fn(),
    stop: vi.fn(),
    confirm: vi.fn(async () => {}),
    cancel: vi.fn(),
    canConnectRequirement: false,
    connectRequirement: vi.fn(async () => {}),
    reset: vi.fn(),
    switchThread: vi.fn(),
    restoring: false,
  };
}

function renderPanel(
  chat: AssistantChat,
  renderTranscript?: (view: AssistantTranscriptView) => ReactNode,
) {
  return render(
    <AssistantClientProvider client={client}>
      <AssistantPanel
        chat={chat}
        userId="u1"
        onClose={() => {}}
        renderTranscript={renderTranscript}
      />
    </AssistantClientProvider>,
  );
}

describe("AssistantPanel transcript seam", () => {
  it("renders the built-in transcript (empty state) when no renderTranscript is supplied", () => {
    renderPanel(makeChat());
    expect(
      screen.getByText(/Ask me to create a workflow/i),
    ).toBeTruthy();
  });

  it("hands the host renderTranscript the live view and a bound renderProposal that renders the ProposalCard", () => {
    let captured: AssistantTranscriptView | null = null;
    const chat = makeChat({
      status: "awaiting_confirm",
      model: "anthropic/claude",
      messages: [{ id: "a", role: "assistant", text: "I'll create that." }],
      pendingProposals: [proposal],
    });

    renderPanel(chat, (view) => {
      captured = view;
      return (
        <div data-testid="host-transcript">
          {view.pendingProposals.map((p) => (
            <div key={p.callId}>{view.renderProposal(p)}</div>
          ))}
        </div>
      );
    });

    // The host renderer ran instead of the built-in timeline.
    expect(screen.getByTestId("host-transcript")).toBeTruthy();
    expect(screen.queryByText(/Ask me to create a workflow/i)).toBeNull();

    // The view carries the panel-derived surface the contract promises.
    expect(captured).not.toBeNull();
    const view = captured as unknown as AssistantTranscriptView;
    expect(view.isStreaming).toBe(false);
    expect(view.isThinking).toBe(false);
    expect(view.model).toBe("anthropic/claude");
    expect(view.messages).toHaveLength(1);
    expect(view.pendingProposals).toHaveLength(1);
    expect(view.pendingProposals[0]!.callId).toBe("c1");

    // The bound renderProposal renders the panel's own ProposalCard, with the
    // confirm/cancel controls wired — so a host can't accidentally hide a
    // pending mutating action.
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("wires a requirement's in-place connect to chat.connectRequirement when the host can connect", () => {
    const requirement = {
      provider: "slack",
      kind: "integration" as const,
      connected: false,
    };
    const proposalWithReq: PendingProposal = {
      proposalId: "p1",
      callId: "c1",
      name: "create_workflow",
      args: { yaml: "name: demo" },
      requirements: [requirement],
    };
    const chat = makeChat({
      status: "awaiting_confirm",
      pendingProposals: [proposalWithReq],
    });
    chat.canConnectRequirement = true;

    renderPanel(chat, (view) => (
      <div>
        {view.pendingProposals.map((p) => (
          <div key={p.callId}>{view.renderProposal(p)}</div>
        ))}
      </div>
    ));

    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    expect(chat.connectRequirement).toHaveBeenCalledWith(
      proposalWithReq,
      requirement,
    );
  });

  it("does not offer in-place connect when the host cannot connect (navigate fallback)", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    // An absolute connect target so the fallback opens a new tab (spied) rather
    // than assigning window.location (which jsdom can't navigate).
    const proposalWithReq: PendingProposal = {
      proposalId: "p1",
      callId: "c1",
      name: "create_workflow",
      args: { yaml: "name: demo" },
      requirements: [
        {
          provider: "slack",
          connected: false,
          connectUrl: "https://example.com/connect/slack",
        },
      ],
    };
    const chat = makeChat({
      status: "awaiting_confirm",
      pendingProposals: [proposalWithReq],
    });
    // canConnectRequirement stays false (the makeChat default).

    renderPanel(chat, (view) => (
      <div>
        {view.pendingProposals.map((p) => (
          <div key={p.callId}>{view.renderProposal(p)}</div>
        ))}
      </div>
    ));

    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    // The panel passed no onConnect, so the card keeps its navigate/open fallback
    // and never calls the host connect handler.
    expect(chat.connectRequirement).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/connect/slack",
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();
  });

  it("reflects a live streaming turn in the view's isStreaming/isThinking flags", () => {
    let captured: AssistantTranscriptView | null = null;
    // A turn that has started but emitted no answer text yet reads as thinking.
    const chat = makeChat({
      status: "streaming",
      streamingId: "a",
      messages: [{ id: "a", role: "assistant", text: "" }],
    });

    renderPanel(chat, (view) => {
      captured = view;
      return <div data-testid="host-transcript" />;
    });

    const view = captured as unknown as AssistantTranscriptView;
    expect(view.isStreaming).toBe(true);
    expect(view.isThinking).toBe(true);
  });
});

describe("AssistantPanel composer running indicator", () => {
  it("shows a running indicator while a turn is streaming", () => {
    const { container } = renderPanel(
      makeChat({ status: "streaming", streamingId: "a" }),
      () => <div data-testid="host-transcript" />,
    );
    expect(
      container.querySelector('[aria-label="Assistant is working"]'),
    ).not.toBeNull();
  });

  it("hides the running indicator when idle", () => {
    const { container } = renderPanel(makeChat({ status: "idle" }), () => (
      <div data-testid="host-transcript" />
    ));
    expect(
      container.querySelector('[aria-label="Assistant is working"]'),
    ).toBeNull();
  });
});

describe("AssistantPanel conversation title", () => {
  it("shows the first user message as the conversation title", () => {
    renderPanel(
      makeChat({
        messages: [
          { id: "u", role: "user", text: "Create a PR review workflow" },
          { id: "a", role: "assistant", text: "On it." },
        ],
      }),
      () => <div data-testid="host-transcript" />,
    );
    expect(screen.getByText("Create a PR review workflow")).toBeTruthy();
  });

  it("truncates a long first user message", () => {
    const long = "x".repeat(120);
    renderPanel(
      makeChat({ messages: [{ id: "u", role: "user", text: long }] }),
      () => <div data-testid="host-transcript" />,
    );
    expect(screen.getByText(`${"x".repeat(60)}…`)).toBeTruthy();
  });

  it("shows no conversation title on a fresh chat", () => {
    renderPanel(makeChat(), () => <div data-testid="host-transcript" />);
    // Only the static "Assistant" label is present, no derived title line.
    expect(screen.getByText("Assistant")).toBeTruthy();
  });
});

function thread(id: string): AssistantThreadSummary {
  return { id, title: id, createdAt: "", updatedAt: "" };
}

/** A client whose thread list + delete behavior are controlled; everything else
 *  is the real same-origin client (its background fetches fail harmlessly). */
function deleteClient(
  threads: AssistantThreadSummary[],
  deleteThread?: (id: string) => Promise<{ ok: boolean }>,
): AssistantClient {
  return {
    ...createAssistantClient({ baseUrl: "/api/v1/assistant" }),
    fetchThreads: vi.fn(async () => threads),
    deleteThread,
  };
}

function renderWith(chat: AssistantChat, client: AssistantClient) {
  return render(
    <AssistantClientProvider client={client}>
      <AssistantPanel chat={chat} userId="u1" onClose={() => {}} />
    </AssistantClientProvider>,
  );
}

async function openHistory(awaitTitle: string) {
  fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
  await screen.findByText(awaitTitle);
}

describe("AssistantPanel thread deletion", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes an inactive thread without resetting the live conversation", async () => {
    const del = vi.fn(async () => ({ ok: true }));
    const chat = makeChat({ threadId: "t1", status: "idle" });
    renderWith(chat, deleteClient([thread("t1"), thread("t2")], del));
    await openHistory("t2");
    // [0] is t1 (active), [1] is t2 (inactive).
    fireEvent.click(
      screen.getAllByRole("button", { name: /Delete conversation/ })[1]!,
    );
    await waitFor(() => expect(del).toHaveBeenCalledWith("t2"));
    expect(chat.reset).not.toHaveBeenCalled();
  });

  it("resets the live conversation only after deleting the active thread succeeds", async () => {
    const del = vi.fn(async () => ({ ok: true }));
    const chat = makeChat({ threadId: "t1", status: "idle" });
    renderWith(chat, deleteClient([thread("t1")], del));
    await openHistory("t1");
    fireEvent.click(
      screen.getByRole("button", { name: /Delete conversation/ }),
    );
    await waitFor(() => expect(chat.reset).toHaveBeenCalled());
    expect(del).toHaveBeenCalledWith("t1");
  });

  it("does not reset the live conversation when deleting the active thread fails", async () => {
    const del = vi.fn(async () => ({ ok: false }));
    const chat = makeChat({ threadId: "t1", status: "idle" });
    renderWith(chat, deleteClient([thread("t1")], del));
    await openHistory("t1");
    fireEvent.click(
      screen.getByRole("button", { name: /Delete conversation/ }),
    );
    await waitFor(() => expect(del).toHaveBeenCalledWith("t1"));
    expect(chat.reset).not.toHaveBeenCalled();
  });

  it("disables deleting the active thread while it is streaming", async () => {
    const chat = makeChat({
      threadId: "t1",
      status: "streaming",
      streamingId: "x",
      messages: [{ id: "x", role: "assistant", text: "" }],
    });
    renderWith(chat, deleteClient([thread("t1")], vi.fn()));
    await openHistory("t1");
    const btn = screen.getByRole("button", {
      name: /Delete conversation/,
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("hides the delete control when the client has no deleteThread", async () => {
    const chat = makeChat({ threadId: "t1", status: "idle" });
    renderWith(chat, deleteClient([thread("t1")], undefined));
    await openHistory("t1");
    expect(
      screen.queryByRole("button", { name: /Delete conversation/ }),
    ).toBeNull();
  });

  it("does not reset when the active thread became busy while the delete was in flight", async () => {
    let resolveDelete: (v: { ok: boolean }) => void = () => {};
    const del = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((r) => {
          resolveDelete = r;
        }),
    );
    const chat = makeChat({ threadId: "t1", status: "idle" });
    renderWith(chat, deleteClient([thread("t1")], del));
    await openHistory("t1");
    fireEvent.click(
      screen.getByRole("button", { name: /Delete conversation/ }),
    );
    await waitFor(() => expect(del).toHaveBeenCalled());
    // The user starts a turn on the active thread while the delete is in flight.
    chat.state.status = "streaming";
    await act(async () => {
      resolveDelete({ ok: true });
    });
    expect(chat.reset).not.toHaveBeenCalled();
  });
});

function models(over: Partial<AssistantModels> = {}): AssistantModels {
  return { default: null, models: [], ...over };
}

describe("toPickerModels", () => {
  it("maps slug/label/context and omits an absent context window", () => {
    const out = toPickerModels(
      models({
        models: [
          { slug: "openai/gpt-5.4", label: "GPT-5.4", contextTokens: 400_000 },
          { slug: "x/y", label: "Y" },
        ],
      }),
      null,
    );
    expect(out[0]).toEqual({
      id: "openai/gpt-5.4",
      name: "GPT-5.4",
      provider: "openai",
      supportsTools: true,
      supportsReasoning: false,
      featured: false,
      contextLength: 400_000,
    });
    // No context window → the field is omitted, not passed as undefined.
    expect(out[1]).toEqual({
      id: "x/y",
      name: "Y",
      provider: "x",
      supportsTools: true,
      supportsReasoning: false,
      featured: false,
    });
    expect("contextLength" in out[1]!).toBe(false);
  });

  it("always includes the server default so it stays selectable", () => {
    const out = toPickerModels(
      models({
        default: "anthropic/claude-sonnet-4-6",
        models: [{ slug: "openai/gpt-5.4", label: "GPT-5.4" }],
      }),
      null,
    );
    expect(out.some((m) => m.id === "anthropic/claude-sonnet-4-6")).toBe(true);
  });

  it("keeps the active selection visible when the catalog omits it", () => {
    // A just-retired slug stays selectable (no blank trigger, no silent rewrite)
    // until the user changes it or the server rejects it.
    const out = toPickerModels(
      models({
        default: "openai/gpt-5.4",
        models: [{ slug: "openai/gpt-5.4", label: "GPT-5.4" }],
      }),
      "retired/model",
    );
    expect(out.some((m) => m.id === "retired/model")).toBe(true);
  });

  it("does not duplicate the default or selection already in the catalog", () => {
    const out = toPickerModels(
      models({
        default: "openai/gpt-5.4",
        models: [{ slug: "openai/gpt-5.4", label: "GPT-5.4" }],
      }),
      "openai/gpt-5.4",
    );
    expect(out.filter((m) => m.id === "openai/gpt-5.4")).toHaveLength(1);
    // The labelled catalog row is kept (not replaced by a slug-only stub).
    expect(out[0]!.name).toBe("GPT-5.4");
  });

  it("threads the catalog prompt price into the picker's per-token pricing", () => {
    // The catalog gives a per-MILLION prompt price; the picker's ModelRow
    // multiplies pricing.prompt by 1e6, so the wire form must be per-token.
    const out = toPickerModels(
      models({
        models: [
          { slug: "openai/gpt-5.4", label: "GPT-5.4", promptUsdPerMillion: 3 },
        ],
      }),
      null,
    );
    expect(out[0]!.pricing).toEqual({ prompt: String(3 / 1_000_000) });
  });

  it("omits pricing when the catalog carries no price", () => {
    const out = toPickerModels(
      models({ models: [{ slug: "x/y", label: "Y" }] }),
      null,
    );
    expect("pricing" in out[0]!).toBe(false);
  });
});

describe("nextModelSelection", () => {
  it("clears to null when the server default is chosen", () => {
    // Choosing the default means "follow the server default" — store null, not
    // the slug, so a later server-default change isn't frozen out.
    expect(nextModelSelection("openai/gpt-5.4", "openai/gpt-5.4")).toBeNull();
  });

  it("stores a non-default id as-is", () => {
    expect(nextModelSelection("anthropic/claude", "openai/gpt-5.4")).toBe(
      "anthropic/claude",
    );
  });

  it("treats an empty id as a clear", () => {
    expect(nextModelSelection("", "openai/gpt-5.4")).toBeNull();
  });

  it("stores a concrete id when there is no server default", () => {
    expect(nextModelSelection("anthropic/claude", null)).toBe(
      "anthropic/claude",
    );
  });
});

describe("AssistantPanel text-size control", () => {
  // The zoom lives on the transcript wrapper (the conversation container's
  // child), not the container itself, so it scales the transcript without
  // scaling the history view's search box and buttons.
  function zoomLayer(container: HTMLElement): HTMLElement {
    const el = container.querySelector('[aria-label="Conversation"] > div');
    if (!el) throw new Error("zoom layer not found");
    return el as HTMLElement;
  }

  it("applies the font scale as a transcript zoom and respects the bounds", () => {
    const { container } = renderPanel(makeChat(), () => (
      <div data-testid="host-transcript" />
    ));
    // Default scale 1 → no visual change.
    expect(zoomLayer(container).style.zoom).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Increase text size" }));
    expect(zoomLayer(container).style.zoom).toBe("1.125");

    // Walk down to the minimum (0.875) and confirm the control disables there.
    fireEvent.click(screen.getByRole("button", { name: "Decrease text size" }));
    fireEvent.click(screen.getByRole("button", { name: "Decrease text size" }));
    expect(zoomLayer(container).style.zoom).toBe("0.875");
    expect(
      (
        screen.getByRole("button", {
          name: "Decrease text size",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("does not apply the zoom to the history view", () => {
    const chat = makeChat({ threadId: "t1", status: "idle" });
    const { container } = renderWith(chat, deleteClient([thread("t1")]));
    fireEvent.click(screen.getByRole("button", { name: "Increase text size" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    // The conversation container itself carries no zoom, and the history branch
    // has no zoom wrapper — so the search box and list render at 1x.
    const log = container.querySelector(
      '[aria-label="Conversation"]',
    ) as HTMLElement;
    expect(log.style.zoom).toBe("");
  });
});

describe("AssistantPanel history view", () => {
  it("toggles the conversation area between the chat and the history list", async () => {
    const chat = makeChat({ threadId: "t1", status: "idle" });
    renderWith(chat, deleteClient([thread("t1")]));

    // The toggle swaps the conversation for the full-panel history view.
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    expect(
      screen.getByRole("searchbox", { name: "Search conversations" }),
    ).toBeTruthy();
    await screen.findByText("t1");
    expect(
      screen
        .getByRole("button", { name: "Chat history" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    // Toggling again returns to the conversation.
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    expect(
      screen.queryByRole("searchbox", { name: "Search conversations" }),
    ).toBeNull();
  });

  it("filters the list by the search query", async () => {
    const chat = makeChat({ status: "idle" });
    renderWith(chat, deleteClient([thread("alpha"), thread("beta")]));
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    await screen.findByText("alpha");

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search conversations" }),
      { target: { value: "bet" } },
    );
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.getByText("beta")).toBeTruthy();
  });

  it("switches to the chosen thread and returns to the conversation", async () => {
    const chat = makeChat({ threadId: "t1", status: "idle" });
    renderWith(chat, deleteClient([thread("t1"), thread("t2")]));
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    fireEvent.click(await screen.findByText("t2"));
    expect(chat.switchThread).toHaveBeenCalledWith("t2");
    expect(
      screen.queryByRole("searchbox", { name: "Search conversations" }),
    ).toBeNull();
  });

  it("returns to the conversation on Escape and refocuses the toggle", async () => {
    const chat = makeChat({ threadId: "t1", status: "idle" });
    renderWith(chat, deleteClient([thread("t1")]));
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    await screen.findByText("t1");

    // Escape from inside the history view returns to the conversation.
    fireEvent.keyDown(
      screen.getByRole("searchbox", { name: "Search conversations" }),
      { key: "Escape" },
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("searchbox", { name: "Search conversations" }),
      ).toBeNull(),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Chat history" }),
    );
  });

  it("ignores an Escape that originates outside the history view", async () => {
    const chat = makeChat({ threadId: "t1", status: "idle" });
    renderWith(chat, deleteClient([thread("t1")]));
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    await screen.findByText("t1");
    // An Escape from elsewhere (e.g. an open composer popover) must not yank the
    // user out of the history view.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(
      screen.getByRole("searchbox", { name: "Search conversations" }),
    ).toBeTruthy();
  });

  it("marks the conversation as a live log only in the chat view", async () => {
    const chat = makeChat({ threadId: "t1", status: "idle" });
    const { container } = renderWith(chat, deleteClient([thread("t1")]));
    expect(
      container.querySelector('[aria-label="Conversation"]')?.getAttribute("role"),
    ).toBe("log");
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    await screen.findByText("t1");
    expect(
      container.querySelector('[aria-label="Conversation"]')?.getAttribute("role"),
    ).toBeNull();
  });

  it("returns to the chat view when a message is sent from history", async () => {
    const chat = makeChat({ threadId: "t1", status: "idle" });
    renderWith(chat, deleteClient([thread("t1")]));
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    await screen.findByText("t1");
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(chat.send).toHaveBeenCalledWith("hello");
    expect(
      screen.queryByRole("searchbox", { name: "Search conversations" }),
    ).toBeNull();
  });

  it("returns to the chat view when starting a new chat from history", async () => {
    const chat = makeChat({ threadId: "t1", status: "idle" });
    renderWith(chat, deleteClient([thread("t1")]));
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    await screen.findByText("t1");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(chat.reset).toHaveBeenCalled();
    expect(
      screen.queryByRole("searchbox", { name: "Search conversations" }),
    ).toBeNull();
  });
});

describe("AssistantPanel model selection display", () => {
  // A client whose model catalog is controlled; everything else is the real
  // same-origin client (its background fetches fail harmlessly).
  function modelsClient(data: AssistantModels): AssistantClient {
    return {
      ...createAssistantClient({ baseUrl: "/api/v1/assistant" }),
      fetchModels: async () => ({ ok: true, data }),
    };
  }

  const catalog: AssistantModels = {
    default: "openai/gpt-5.4",
    models: [{ slug: "openai/gpt-5.4", label: "GPT-5.4" }],
  };

  function renderWithModels(chat: AssistantChat, data: AssistantModels) {
    return render(
      <AssistantClientProvider client={modelsClient(data)}>
        <AssistantPanel
          chat={chat}
          userId="u1"
          onClose={() => {}}
          renderTranscript={() => <div data-testid="host-transcript" />}
        />
      </AssistantClientProvider>,
    );
  }

  it("keeps a selection the catalog omits visible without rewriting chat state", async () => {
    const chat = makeChat();
    chat.selectedModel = "retired/model";
    renderWithModels(chat, catalog);
    // The active slug stays shown on the trigger (so the displayed model is the
    // one the next turn sends) and the panel never mutates the user's choice.
    await screen.findByRole("button", { name: /retired\/model/ });
    expect(chat.setModel).not.toHaveBeenCalled();
  });

  it("shows the catalog label for a selection the catalog lists", async () => {
    const chat = makeChat();
    chat.selectedModel = "openai/gpt-5.4";
    renderWithModels(chat, catalog);
    await screen.findByRole("button", { name: /GPT-5\.4/ });
    expect(chat.setModel).not.toHaveBeenCalled();
  });

  it("shows each model's prompt price in the open picker so cost is visible", async () => {
    const priced: AssistantModels = {
      default: "openai/gpt-5.4",
      models: [
        { slug: "openai/gpt-5.4", label: "GPT-5.4", promptUsdPerMillion: 3 },
      ],
    };
    renderWithModels(makeChat(), priced);
    // Open the picker from its trigger; the row renders the compact "$3/M" that
    // the sandbox surface used to drop by stripping the catalog price.
    fireEvent.click(await screen.findByRole("button", { name: /GPT-5\.4/ }));
    expect(await screen.findByText("$3/M")).toBeTruthy();
  });
});

describe("AssistantPanel composer seed", () => {
  it("forwards composerSeed into the composer and reports it applied", async () => {
    const onComposerSeedApplied = vi.fn();
    const { rerender } = render(
      <AssistantClientProvider client={client}>
        <AssistantPanel
          chat={makeChat()}
          userId="u1"
          onClose={() => {}}
          composerSeed={null}
          onComposerSeedApplied={onComposerSeedApplied}
        />
      </AssistantClientProvider>,
    );

    rerender(
      <AssistantClientProvider client={client}>
        <AssistantPanel
          chat={makeChat()}
          userId="u1"
          onClose={() => {}}
          composerSeed="Draft this workflow"
          onComposerSeedApplied={onComposerSeedApplied}
        />
      </AssistantClientProvider>,
    );

    const input = (await screen.findByLabelText(
      "Message input",
    )) as HTMLTextAreaElement;
    expect(input.value).toBe("Draft this workflow");
    expect(onComposerSeedApplied).toHaveBeenCalledOnce();
  });
});
