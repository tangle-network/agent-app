import { describe, expect, it } from "vitest";
import { describeProposal, presentError } from "./presentation";
import {
  type AssistantState,
  assistantReducer,
  initialAssistantState,
  selectVisibleState,
} from "./reducer";
import type { AssistantStreamEvent, ChatMessage } from "./types";

function send(state: AssistantState, text: string): AssistantState {
  return assistantReducer(state, {
    type: "send",
    messageId: "u1",
    assistantId: "a1",
    text,
  });
}

function stream(
  state: AssistantState,
  event: AssistantStreamEvent,
): AssistantState {
  return assistantReducer(state, { type: "stream", event });
}

function assistantText(state: AssistantState, id = "a1"): string | undefined {
  return state.messages.find((m) => m.id === id)?.text;
}

describe("send", () => {
  it("appends the user message and an empty assistant bubble, entering streaming", () => {
    const s = send(initialAssistantState(), "Hi there");
    expect(s.status).toBe("streaming");
    expect(s.streamingId).toBe("a1");
    expect(s.messages).toEqual([
      { id: "u1", role: "user", text: "Hi there" },
      { id: "a1", role: "assistant", text: "" },
    ]);
  });

  it("clears prior error and usage on a new turn", () => {
    const dirty: AssistantState = {
      ...initialAssistantState(),
      error: { code: "X", message: "old" },
      usage: { costUsd: 1, balanceUsd: 1, promptTokens: null, completionTokens: null, durationMs: null, replayed: false },
    };
    const s = send(dirty, "again");
    expect(s.error).toBeNull();
    expect(s.usage).toBeNull();
  });

  it("preserves an unresolved proposal rather than silently dropping it", () => {
    const withProposal: AssistantState = {
      ...initialAssistantState(),
      pendingProposals: [
        { proposalId: "p", callId: "c", name: "create_workflow", args: {} },
      ],
    };
    // The hook/composer block sending while a proposal is pending; even if a
    // send slips through, the reducer must not orphan the server-side proposal.
    const s = send(withProposal, "again");
    expect(s.pendingProposals).toEqual(withProposal.pendingProposals);
  });
});

describe("streaming renders incrementally", () => {
  it("appends each delta to the live assistant message in order", () => {
    let s = send(initialAssistantState(), "Hi");
    s = stream(s, { type: "thread", data: { threadId: "T1", turnId: "R1" } });
    expect(s.threadId).toBe("T1");

    s = stream(s, { type: "delta", data: { text: "Hello" } });
    expect(assistantText(s)).toBe("Hello");

    s = stream(s, { type: "delta", data: { text: " world" } });
    expect(assistantText(s)).toBe("Hello world");

    s = stream(s, {
      type: "usage",
      data: {
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0.0002,
        balanceUsd: 4.5,
      },
    });
    s = stream(s, {
      type: "done",
      data: { turnId: "R1", status: "completed" },
    });
    expect(s.status).toBe("idle");
    expect(s.streamingId).toBeNull();
    expect(s.usage).toEqual({
      costUsd: 0.0002,
      balanceUsd: 4.5,
      promptTokens: 10,
      completionTokens: 5,
      durationMs: null,
      replayed: false,
    });
    // The fully streamed reply is preserved.
    expect(assistantText(s)).toBe("Hello world");
  });
});

describe("a capped turn is surfaced, never silent", () => {
  it("appends a step-limit status note when done.capped is true", () => {
    let s = send(initialAssistantState(), "build me a complex workflow");
    s = stream(s, { type: "delta", data: { text: "Let me check…" } });
    s = stream(s, {
      type: "done",
      data: { turnId: "R9", status: "completed", capped: true },
    });
    expect(s.status).toBe("idle");
    // The partial reply is kept, plus a status note telling the user it stopped
    // at the step limit (so a partial answer isn't read as a complete one).
    expect(assistantText(s)).toBe("Let me check…");
    const note = s.messages.at(-1);
    expect(note?.role).toBe("status");
    expect(note?.text).toContain("step limit");
  });

  it("adds no note on a normal (uncapped) completion", () => {
    let s = send(initialAssistantState(), "hi");
    s = stream(s, { type: "delta", data: { text: "Hello" } });
    s = stream(s, {
      type: "done",
      data: { turnId: "R1", status: "completed" },
    });
    expect(s.messages.some((m) => m.role === "status")).toBe(false);
  });
});

describe("a proposed workflow shows its YAML and requires confirmation", () => {
  const yaml = "name: nightly\non:\n  schedule: { cron: '0 3 * * *' }";

  it("parks a workflow proposal awaiting confirmation, exposing the YAML, without running it", () => {
    let s = send(initialAssistantState(), "make a nightly workflow");
    s = stream(s, {
      type: "tool_proposal",
      data: {
        proposalId: "prop_1",
        callId: "call_1",
        name: "create_workflow",
        args: { yaml },
      },
    });
    s = stream(s, {
      type: "done",
      data: { turnId: "R1", status: "completed", proposed: true },
    });

    expect(s.status).toBe("awaiting_confirm");
    expect(s.pendingProposals).toHaveLength(1);

    const view = describeProposal(s.pendingProposals[0]!);
    expect(view.title).toBe("Create workflow");
    expect(view.preview).toEqual({
      label: "Workflow definition",
      content: yaml,
      kind: "workflow",
    });

    // No side effect ran: the only messages are the user's and the (empty,
    // now-dropped) assistant bubble — no "created" status note.
    expect(s.messages.some((m) => m.role === "status")).toBe(false);
    // The empty assistant bubble for a pure-proposal turn is dropped.
    expect(s.messages).toHaveLength(1);
  });

  it("removes the proposal and notes the outcome once confirmed", () => {
    let s = send(initialAssistantState(), "make a workflow");
    s = stream(s, {
      type: "tool_proposal",
      data: {
        proposalId: "prop_1",
        callId: "call_1",
        name: "create_workflow",
        args: { yaml },
      },
    });
    s = stream(s, {
      type: "done",
      data: { turnId: "R1", status: "completed", proposed: true },
    });

    s = assistantReducer(s, {
      type: "proposal_resolved",
      callId: "call_1",
      status: {
        id: "st1",
        role: "status",
        text: 'Created workflow "nightly".',
      },
      error: null,
    });
    expect(s.pendingProposals).toHaveLength(0);
    expect(s.status).toBe("idle");
    expect(s.messages.at(-1)).toEqual({
      id: "st1",
      role: "status",
      text: 'Created workflow "nightly".',
    });
  });

  it("does not double-add a proposal with a repeated callId", () => {
    let s = send(initialAssistantState(), "x");
    const ev: AssistantStreamEvent = {
      type: "tool_proposal",
      data: {
        proposalId: "prop_1",
        callId: "call_1",
        name: "create_workflow",
        args: { yaml },
      },
    };
    s = stream(s, ev);
    s = stream(s, ev);
    expect(s.pendingProposals).toHaveLength(1);
  });

  it("carries connection requirements through to the pending proposal", () => {
    let s = send(initialAssistantState(), "review my PRs");
    s = stream(s, {
      type: "tool_proposal",
      data: {
        proposalId: "prop_1",
        callId: "call_1",
        name: "create_workflow",
        args: { yaml },
        requirements: [{ provider: "github", connected: false }],
      },
    });
    expect(s.pendingProposals[0]?.requirements).toEqual([
      { provider: "github", connected: false },
    ]);
  });

  it("keeps the card and shows the reason on a retryable confirm failure", () => {
    let s = send(initialAssistantState(), "review my PRs");
    s = stream(s, {
      type: "tool_proposal",
      data: {
        proposalId: "prop_1",
        callId: "call_1",
        name: "create_workflow",
        args: { yaml },
        requirements: [{ provider: "github", connected: false }],
      },
    });
    s = stream(s, {
      type: "done",
      data: { turnId: "R1", status: "completed", proposed: true },
    });

    s = assistantReducer(s, {
      type: "proposal_retry_failed",
      callId: "call_1",
      message: "connect github first",
    });
    // The card stays (re-confirmable) with the reason attached, and there's no
    // top-level error banner — the message lives on the card next to Connect.
    expect(s.pendingProposals).toHaveLength(1);
    expect(s.pendingProposals[0]?.retryError).toBe("connect github first");
    expect(s.status).toBe("awaiting_confirm");
    expect(s.error).toBeNull();
  });

  it("does not resurrect awaiting_confirm when no matching proposal remains", () => {
    // Defensive: if the card is already gone (no pending proposals) and the
    // conversation has settled to idle, a stray proposal_retry_failed must NOT
    // force the composer back into awaiting_confirm and wedge it.
    const idle: AssistantState = { ...initialAssistantState(), status: "idle" };
    const s = assistantReducer(idle, {
      type: "proposal_retry_failed",
      callId: "gone",
      message: "connect github first",
    });
    expect(s.pendingProposals).toHaveLength(0);
    expect(s.status).toBe("idle");
  });
});

describe("credit-exhausted surfaces the add-credits CTA", () => {
  it("stores the error and maps it to an Add credits action to billing", () => {
    let s = send(initialAssistantState(), "do a thing");
    s = stream(s, {
      type: "error",
      data: {
        code: "INSUFFICIENT_BALANCE",
        message: "Credit balance is exhausted",
      },
    });

    expect(s.status).toBe("idle");
    expect(s.streamingId).toBeNull();
    // The empty assistant bubble is dropped on a pre-delta failure.
    expect(s.messages).toHaveLength(1);

    const error = s.error;
    if (!error) throw new Error("expected an error to be set");
    expect(error.code).toBe("INSUFFICIENT_BALANCE");

    const view = presentError(error.code, error.message);
    expect(view.cta).toEqual({ label: "Add credits", to: "/app/billing" });
  });
});

describe("transcript edge cases", () => {
  it("keeps a partially streamed reply when the user stops", () => {
    let s = send(initialAssistantState(), "hi");
    s = stream(s, { type: "delta", data: { text: "partial" } });
    s = assistantReducer(s, { type: "stopped" });
    expect(s.status).toBe("idle");
    expect(s.streamingId).toBeNull();
    expect(assistantText(s)).toBe("partial");
  });

  it("drops the empty assistant bubble when stopped before the first delta", () => {
    let s = send(initialAssistantState(), "hi");
    // No delta arrived; the assistant bubble is still empty.
    s = assistantReducer(s, { type: "stopped" });
    expect(s.status).toBe("idle");
    expect(s.streamingId).toBeNull();
    // Only the user's message remains — no permanent blank assistant bubble.
    expect(s.messages).toEqual([{ id: "u1", role: "user", text: "hi" }]);
  });

  it("shows a running tool chip on tool_call and resolves it on tool_result", () => {
    let s = send(initialAssistantState(), "list my workflows");
    s = stream(s, {
      type: "tool_call",
      data: { callId: "c1", name: "list_workflows" },
    });
    const running = s.messages.find((m) => m.id === "tool-c1");
    expect(running?.role).toBe("tool");
    expect(running?.tool).toEqual({
      name: "list_workflows",
      status: "running",
    });
    // The empty assistant bubble is finalized so the chip isn't preceded by a
    // blank bubble, and the next delta will open a fresh segment.
    expect(s.streamingId).toBeNull();

    s = stream(s, {
      type: "tool_result",
      data: { callId: "c1", name: "list_workflows", ok: true, output: {} },
    });
    // The SAME chip is updated in place — no duplicate, now marked ok.
    expect(s.messages.filter((m) => m.id === "tool-c1")).toHaveLength(1);
    expect(s.messages.find((m) => m.id === "tool-c1")?.tool?.status).toBe("ok");
    expect(s.status).toBe("streaming");
  });

  it("carries tool args on the chip and preserves them across tool_result", () => {
    let s = send(initialAssistantState(), "get workflow wf_1");
    s = stream(s, {
      type: "tool_call",
      data: { callId: "c1", name: "get_workflow", args: { id: "wf_1" } },
    });
    expect(s.messages.find((m) => m.id === "tool-c1")?.tool?.args).toEqual({
      id: "wf_1",
    });
    s = stream(s, {
      type: "tool_result",
      data: { callId: "c1", name: "get_workflow", ok: true, output: {} },
    });
    // tool_result carries no args of its own, so the call's args must survive.
    expect(s.messages.find((m) => m.id === "tool-c1")?.tool?.args).toEqual({
      id: "wf_1",
    });
  });

  it("records cost, tokens, and duration from the usage event", () => {
    let s = send(initialAssistantState(), "hi");
    s = stream(s, {
      type: "usage",
      data: {
        promptTokens: 12,
        completionTokens: 34,
        costUsd: 0.001,
        balanceUsd: 9.5,
        durationMs: 1500,
      },
    });
    expect(s.usage).toEqual({
      costUsd: 0.001,
      balanceUsd: 9.5,
      promptTokens: 12,
      completionTokens: 34,
      durationMs: 1500,
      replayed: false,
    });
  });

  it("marks the tool chip failed and carries the error text", () => {
    let s = send(initialAssistantState(), "get workflow zzz");
    s = stream(s, {
      type: "tool_call",
      data: { callId: "c1", name: "get_workflow" },
    });
    s = stream(s, {
      type: "tool_result",
      data: {
        callId: "c1",
        name: "get_workflow",
        ok: false,
        error: { code: "UNKNOWN", message: "not found" },
      },
    });
    const chip = s.messages.find((m) => m.id === "tool-c1");
    expect(chip?.tool?.status).toBe("failed");
    expect(chip?.text).toBe("not found");
  });

  it("retains the tool result outcome on the chip so a renderer can show the body", () => {
    let s = send(initialAssistantState(), "list my workflows");
    s = stream(s, {
      type: "tool_call",
      data: { callId: "c1", name: "list_workflows" },
    });
    s = stream(s, {
      type: "tool_result",
      data: { callId: "c1", name: "list_workflows", ok: true, output: { count: 2 } },
    });
    expect(s.messages.find((m) => m.id === "tool-c1")?.tool?.outcome).toEqual({
      ok: true,
      result: { count: 2 },
    });
  });

  it("retains the error outcome on a failed tool chip", () => {
    let s = send(initialAssistantState(), "get workflow zzz");
    s = stream(s, {
      type: "tool_call",
      data: { callId: "c1", name: "get_workflow" },
    });
    s = stream(s, {
      type: "tool_result",
      data: {
        callId: "c1",
        name: "get_workflow",
        ok: false,
        error: { code: "UNKNOWN", message: "not found" },
      },
    });
    expect(s.messages.find((m) => m.id === "tool-c1")?.tool?.outcome).toEqual({
      ok: false,
      error: { code: "UNKNOWN", message: "not found" },
    });
  });

  it("splits pre- and post-tool reasoning into distinct assistant bubbles", () => {
    let s = send(initialAssistantState(), "build a workflow");
    s = stream(s, {
      type: "delta",
      data: { text: "Let me check the format." },
    });
    s = stream(s, {
      type: "tool_call",
      data: { callId: "c1", name: "get_workflow_schema" },
    });
    s = stream(s, {
      type: "tool_result",
      data: { callId: "c1", name: "get_workflow_schema", ok: true, output: {} },
    });
    s = stream(s, { type: "delta", data: { text: "Here is your workflow:" } });
    s = stream(s, {
      type: "done",
      data: { turnId: "R1", status: "completed" },
    });

    // Two separate assistant bubbles, not one concatenated blob, with the tool
    // chip between them — in wire order.
    const assistantTexts = s.messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.text);
    expect(assistantTexts).toEqual([
      "Let me check the format.",
      "Here is your workflow:",
    ]);
    const roles = s.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("reset returns to the initial empty state", () => {
    let s = send(initialAssistantState(), "hi");
    s = stream(s, { type: "thread", data: { threadId: "T", turnId: "R" } });
    s = assistantReducer(s, { type: "reset" });
    expect(s).toEqual(initialAssistantState());
  });
});

describe("restore_history rehydrates a thread, but never clobbers live state", () => {
  const restored: ChatMessage[] = [
    { id: "t1:u", role: "user", text: "earlier question" },
    { id: "t1:a", role: "assistant", text: "earlier answer" },
  ];

  function idleThread(): AssistantState {
    return {
      ...initialAssistantState(),
      ownerId: "userA",
      threadId: "T1",
    };
  }

  it("applies the server transcript when the thread is idle and empty", () => {
    const s = assistantReducer(idleThread(), {
      type: "restore_history",
      ownerId: "userA",
      threadId: "T1",
      messages: restored,
      proposals: [],
    });
    expect(s.messages).toEqual(restored);
  });

  it("ignores a restore once a turn has started", () => {
    let s = idleThread();
    s = send(s, "new question"); // status streaming, messages non-empty
    const before = s.messages;
    s = assistantReducer(s, {
      type: "restore_history",
      ownerId: "userA",
      threadId: "T1",
      messages: restored,
      proposals: [],
    });
    expect(s.messages).toBe(before);
  });

  it("ignores a restore for a different owner or thread (late/cross response)", () => {
    const base = idleThread();
    expect(
      assistantReducer(base, {
        type: "restore_history",
        ownerId: "userB",
        threadId: "T1",
        messages: restored,
        proposals: [],
      }).messages,
    ).toEqual([]);
    expect(
      assistantReducer(base, {
        type: "restore_history",
        ownerId: "userA",
        threadId: "T2",
        messages: restored,
        proposals: [],
      }).messages,
    ).toEqual([]);
  });

  it("does not clobber an already-restored idle transcript (idle + non-empty)", () => {
    const existing: ChatMessage[] = [
      { id: "old:u", role: "user", text: "already here" },
      { id: "old:a", role: "assistant", text: "already answered" },
    ];
    const s: AssistantState = { ...idleThread(), messages: existing };
    const next = assistantReducer(s, {
      type: "restore_history",
      ownerId: "userA",
      threadId: "T1",
      messages: restored,
      proposals: [],
    });
    // A late/duplicate restore must not overwrite a transcript already shown.
    expect(next.messages).toBe(existing);
  });

  it("restores unconfirmed proposals and re-enters awaiting_confirm", () => {
    const s = assistantReducer(idleThread(), {
      type: "restore_history",
      ownerId: "userA",
      threadId: "T1",
      messages: restored,
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
          ],
        },
      ],
    });
    // The card comes back AND the conversation is gated on confirming it again.
    expect(s.messages).toEqual(restored);
    expect(s.pendingProposals).toHaveLength(1);
    expect(s.pendingProposals[0]?.proposalId).toBe("p1");
    expect(s.status).toBe("awaiting_confirm");
  });

  it("never clobbers a live pending proposal already in state", () => {
    const liveProposal = {
      proposalId: "live",
      callId: "c1",
      name: "create_workflow",
      args: { yaml: "name: live" },
    };
    // An idle+empty conversation that still carries a live, unconfirmed proposal:
    // a late/duplicate restore must defer to it rather than overwrite it with a
    // stale server snapshot (the exact proposal loss this PR prevents).
    const s: AssistantState = {
      ...idleThread(),
      pendingProposals: [liveProposal],
    };
    const next = assistantReducer(s, {
      type: "restore_history",
      ownerId: "userA",
      threadId: "T1",
      messages: restored,
      proposals: [
        {
          proposalId: "stale",
          callId: "c2",
          name: "create_workflow",
          args: { yaml: "name: stale" },
        },
      ],
    });
    // The guard returns the prior state untouched — the live proposal survives.
    expect(next).toBe(s);
    expect(next.pendingProposals).toEqual([liveProposal]);
  });
});

describe("thread_gone drops a dead thread id, guarded like restore", () => {
  function idleThread(): AssistantState {
    return { ...initialAssistantState(), ownerId: "userA", threadId: "T1" };
  }

  it("clears the thread id when the thread is gone and the conversation is idle/empty", () => {
    const s = assistantReducer(idleThread(), {
      type: "thread_gone",
      ownerId: "userA",
      threadId: "T1",
    });
    expect(s.threadId).toBeNull();
  });

  it("leaves a started turn untouched", () => {
    let s = idleThread();
    s = send(s, "hi"); // streaming + non-empty
    s = assistantReducer(s, {
      type: "thread_gone",
      ownerId: "userA",
      threadId: "T1",
    });
    expect(s.threadId).toBe("T1");
  });

  it("leaves an idle thread with a restored transcript untouched (idle + non-empty)", () => {
    // A restore succeeded (idle, messages present) and a late thread_gone arrives;
    // the guard must keep the thread id AND the visible transcript intact.
    const existing: ChatMessage[] = [
      { id: "t:u", role: "user", text: "earlier" },
      { id: "t:a", role: "assistant", text: "earlier reply" },
    ];
    const s: AssistantState = { ...idleThread(), messages: existing };
    const next = assistantReducer(s, {
      type: "thread_gone",
      ownerId: "userA",
      threadId: "T1",
    });
    expect(next.threadId).toBe("T1");
    expect(next.messages).toBe(existing);
  });

  it("ignores a stale/cross thread_gone for a different owner or thread", () => {
    const base = idleThread();
    expect(
      assistantReducer(base, {
        type: "thread_gone",
        ownerId: "userB",
        threadId: "T1",
      }).threadId,
    ).toBe("T1");
    expect(
      assistantReducer(base, {
        type: "thread_gone",
        ownerId: "userA",
        threadId: "T2",
      }).threadId,
    ).toBe("T1");
  });
});

describe("hydrate replaces the conversation for a new user", () => {
  it("loads the new thread and drops all transient state from the prior user", () => {
    // Build up a dirty mid-conversation state for user A.
    let s = send(initialAssistantState(), "secret from user A");
    s = stream(s, { type: "thread", data: { threadId: "T_A", turnId: "R" } });
    s = stream(s, { type: "delta", data: { text: "private reply" } });
    s = stream(s, {
      type: "tool_proposal",
      data: {
        proposalId: "p",
        callId: "c",
        name: "create_workflow",
        args: { yaml: "name: x" },
      },
    });

    // Switching users hydrates user B's (empty) thread; none of A's data remains.
    const hydrated = assistantReducer(s, {
      type: "hydrate",
      ownerId: "userB",
      threadId: null,
      messages: [],
    });
    expect(hydrated).toEqual({ ...initialAssistantState(), ownerId: "userB" });
    expect(hydrated.messages).toEqual([]);
    expect(hydrated.pendingProposals).toEqual([]);
    expect(hydrated.streamingId).toBeNull();
  });

  it("restores a persisted thread stamped with the incoming user", () => {
    const prior: ChatMessage[] = [
      { id: "u", role: "user", text: "earlier question" },
      { id: "a", role: "assistant", text: "earlier answer" },
    ];
    const s = assistantReducer(initialAssistantState(), {
      type: "hydrate",
      ownerId: "userB",
      threadId: "T_B",
      messages: prior,
    });
    expect(s.ownerId).toBe("userB");
    expect(s.threadId).toBe("T_B");
    expect(s.messages).toEqual(prior);
    expect(s.status).toBe("idle");
  });
});

describe("selectVisibleState masks a foreign owner", () => {
  function ownedState(ownerId: string): AssistantState {
    return assistantReducer(initialAssistantState(), {
      type: "hydrate",
      ownerId,
      threadId: "T",
      messages: [{ id: "m", role: "user", text: "private" }],
    });
  }

  it("returns the state unchanged when the owner matches the current user", () => {
    const s = ownedState("userA");
    expect(selectVisibleState(s, "userA")).toBe(s);
  });

  it("returns a fresh empty state when the owner does not match", () => {
    // The single commit after an auth switch (state still belongs to A, prop is
    // now B) must never expose A's transcript.
    const s = ownedState("userA");
    const visible = selectVisibleState(s, "userB");
    expect(visible).toEqual(initialAssistantState());
    expect(visible.messages).toEqual([]);
    expect(visible.threadId).toBeNull();
  });

  it("masks a signed-in user's state from an anonymous (null) viewer", () => {
    const s = ownedState("userA");
    expect(selectVisibleState(s, null).messages).toEqual([]);
  });

  it("keeps reset's cleared state visible (owner preserved)", () => {
    const reset = assistantReducer(ownedState("userA"), { type: "reset" });
    expect(selectVisibleState(reset, "userA")).toBe(reset);
    expect(reset.ownerId).toBe("userA");
  });
});

describe("proposal_resolved targets the card by callId", () => {
  function withTwoProposals(): AssistantState {
    return {
      ...initialAssistantState(),
      status: "awaiting_confirm",
      pendingProposals: [
        { proposalId: "p1", callId: "c1", name: "create_workflow", args: {} },
        { proposalId: "p2", callId: "c2", name: "revoke_api_key", args: {} },
      ],
    };
  }

  it("removes exactly the card whose callId matches", () => {
    const s = assistantReducer(withTwoProposals(), {
      type: "proposal_resolved",
      callId: "c1",
      status: null,
      error: null,
    });
    expect(s.pendingProposals.map((p) => p.callId)).toEqual(["c2"]);
    expect(s.status).toBe("awaiting_confirm");
  });

  it("resolves to idle once the last card is removed", () => {
    let s = withTwoProposals();
    s = assistantReducer(s, {
      type: "proposal_resolved",
      callId: "c1",
      status: null,
      error: null,
    });
    s = assistantReducer(s, {
      type: "proposal_resolved",
      callId: "c2",
      status: null,
      error: null,
    });
    expect(s.pendingProposals).toEqual([]);
    expect(s.status).toBe("idle");
  });
});

describe("in-memory messages are capped", () => {
  it("bounds the transcript and keeps the most recent + streaming message", () => {
    // Seed a state already at/over the cap with identifiable messages.
    const seeded: AssistantState = {
      ...initialAssistantState(),
      ownerId: "userA",
      messages: Array.from({ length: 205 }, (_, i) => ({
        id: `old-${i}`,
        role: "assistant" as const,
        text: `old ${i}`,
      })),
    };
    const afterSend = assistantReducer(seeded, {
      type: "send",
      messageId: "u-new",
      assistantId: "a-new",
      text: "newest",
    });
    expect(afterSend.messages.length).toBeLessThanOrEqual(200);
    // The just-sent user message and the streaming assistant bubble survive.
    const ids = afterSend.messages.map((m) => m.id);
    expect(ids).toContain("u-new");
    expect(ids).toContain("a-new");
    expect(afterSend.streamingId).toBe("a-new");
    // The oldest messages were dropped.
    expect(ids).not.toContain("old-0");
  });
});

describe("an incomplete turn leaves no confirmable proposal", () => {
  function withBufferedProposal() {
    let s = send(initialAssistantState(), "do a mutating thing");
    s = stream(s, {
      type: "tool_proposal",
      data: {
        proposalId: "p1",
        callId: "c1",
        name: "create_workflow",
        args: { yaml: "name: x" },
      },
    });
    expect(s.pendingProposals).toHaveLength(1);
    return s;
  }

  it("clears the proposal when the stream errors", () => {
    const s = stream(withBufferedProposal(), {
      type: "error",
      data: { code: "STREAM_FAILED", message: "boom" },
    });
    expect(s.pendingProposals).toEqual([]);
    expect(s.status).toBe("idle");
  });

  it("clears the proposal when the user stops the turn", () => {
    const s = assistantReducer(withBufferedProposal(), { type: "stopped" });
    expect(s.pendingProposals).toEqual([]);
  });

  it("clears the proposal on a network stream failure", () => {
    const s = assistantReducer(withBufferedProposal(), {
      type: "stream_failed",
      error: { code: "NETWORK", message: "lost" },
    });
    expect(s.pendingProposals).toEqual([]);
  });

  it("keeps the proposal when the turn completes cleanly", () => {
    const s = stream(withBufferedProposal(), {
      type: "done",
      data: { turnId: "R1", status: "completed", proposed: true },
    });
    expect(s.pendingProposals).toHaveLength(1);
    expect(s.status).toBe("awaiting_confirm");
  });
});

describe("switch_thread opens a past conversation", () => {
  it("pins the chosen thread and clears the conversation for a restore", () => {
    // A live conversation on thread A with a message and a selection.
    let s: AssistantState = {
      ...initialAssistantState(),
      ownerId: "u1",
      threadId: "thr_A",
      messages: [{ id: "m1", role: "user", text: "hello" }],
    };
    s = assistantReducer(s, { type: "switch_thread", threadId: "thr_B" });
    expect(s.threadId).toBe("thr_B");
    expect(s.ownerId).toBe("u1");
    expect(s.messages).toEqual([]);
    expect(s.status).toBe("idle");
    // The follow-up restore for the switched-to thread now applies.
    const restored = assistantReducer(s, {
      type: "restore_history",
      ownerId: "u1",
      threadId: "thr_B",
      messages: [{ id: "b1", role: "user", text: "earlier" }],
      proposals: [],
    });
    expect(restored.messages).toEqual([
      { id: "b1", role: "user", text: "earlier" },
    ]);
  });

  it("is a no-op when the chosen thread is already active", () => {
    const s: AssistantState = {
      ...initialAssistantState(),
      ownerId: "u1",
      threadId: "thr_A",
      messages: [{ id: "m1", role: "user", text: "hello" }],
    };
    const next = assistantReducer(s, {
      type: "switch_thread",
      threadId: "thr_A",
    });
    expect(next).toBe(s);
  });
});

describe("history_failed drops the active thread and surfaces the error", () => {
  it("resets to a fresh state (no thread) with the error, on the failed thread", () => {
    const s: AssistantState = {
      ...initialAssistantState(),
      ownerId: "u1",
      threadId: "T",
    };
    const next = assistantReducer(s, {
      type: "history_failed",
      ownerId: "u1",
      threadId: "T",
      error: { code: "HISTORY_LOAD_FAILED", message: "nope" },
    });
    // The thread is dropped so the next send can't run against hidden context.
    expect(next.threadId).toBeNull();
    expect(next.ownerId).toBe("u1");
    expect(next.messages).toEqual([]);
    expect(next.error).toEqual({
      code: "HISTORY_LOAD_FAILED",
      message: "nope",
    });
  });

  it("ignores a late failure once the conversation moved on", () => {
    const s: AssistantState = {
      ...initialAssistantState(),
      ownerId: "u1",
      threadId: "OTHER",
      messages: [{ id: "m", role: "user", text: "hi" }],
    };
    const next = assistantReducer(s, {
      type: "history_failed",
      ownerId: "u1",
      threadId: "T",
      error: { code: "x", message: "y" },
    });
    expect(next).toBe(s);
  });
});
