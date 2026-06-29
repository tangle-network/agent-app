/**
 * Pure state machine driving the assistant panel. Every UI transition — a user
 * message, each streamed SSE event, a stream failure, a confirmed/cancelled
 * proposal, a manual stop — is modeled as an action here, so the panel's
 * behavior can be verified without a DOM or a live stream.
 */

import type {
  AssistantStreamEvent,
  ChatMessage,
  PendingProposal,
  ToolOutcome,
  UsageInfo,
} from "./types";

export type ChatStatus = "idle" | "streaming" | "awaiting_confirm";

/** Cap on in-memory messages. A session can survive route changes and drawer
 *  open/close for a long time, so the transcript is bounded to the most recent
 *  turns. The streaming message is always appended last, so trimming from the
 *  front never drops it. */
const MAX_MESSAGES = 200;

function capMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.length > MAX_MESSAGES
    ? messages.slice(-MAX_MESSAGES)
    : messages;
}

export interface AssistantState {
  /** The signed-in user this conversation belongs to. Carried in state so it
   *  moves atomically with the data it labels — persistence keys off it, and a
   *  render whose owner doesn't match the current user is masked (see
   *  `selectVisibleState`), preventing a one-frame cross-account leak. */
  ownerId: string | null;
  /** Persisted across reloads to continue the same server-side thread. */
  threadId: string | null;
  messages: ChatMessage[];
  status: ChatStatus;
  /** Id of the assistant message currently accumulating deltas, if any. Set to
   *  null mid-turn when a tool runs, so the next text delta opens a fresh
   *  assistant bubble — keeping each reasoning segment visually distinct. */
  streamingId: string | null;
  /** Base id for the current turn's assistant bubbles (the `send` assistant id).
   *  Post-tool segments derive a unique id from it; null between turns. */
  streamBaseId: string | null;
  /** How many assistant bubbles the current turn has opened (0 = just the first).
   *  Drives the per-segment bubble id so segments never collide across turns. */
  segmentSeq: number;
  pendingProposals: PendingProposal[];
  /** Cost/balance from the most recently settled turn. */
  usage: UsageInfo | null;
  /** Model slug the current/most-recent turn ran against (from the thread
   *  event), or null before any turn this session. */
  model: string | null;
  /** The current turn's accumulated reasoning/thinking text (reasoning models
   *  stream this before the answer). Shown dim while the answer is still pending;
   *  reset at the start of each turn. Null when the model emits no reasoning. */
  reasoning: string | null;
  error: { code: string; message: string } | null;
}

export type AssistantAction =
  | { type: "send"; messageId: string; assistantId: string; text: string }
  | { type: "stream"; event: AssistantStreamEvent }
  | { type: "stream_failed"; error: { code: string; message: string } }
  | {
      type: "proposal_resolved";
      /** The card's canonical identity (the model's tool-call id). */
      callId: string;
      status: ChatMessage | null;
      /** Set on a failed confirmation; null clears any prior error. */
      error: { code: string; message: string } | null;
    }
  | {
      type: "proposal_retry_failed";
      /** The card to KEEP (a retryable confirm failure — an unconnected
       *  integration). The card stays confirmable; the message is shown on it. */
      callId: string;
      message: string;
    }
  | { type: "stopped" }
  | {
      type: "hydrate";
      ownerId: string | null;
      threadId: string | null;
      messages: ChatMessage[];
    }
  | {
      type: "restore_history";
      ownerId: string | null;
      threadId: string;
      messages: ChatMessage[];
      /** Unconfirmed proposals restored alongside the transcript so a card
       *  survives reload. Empty when none are pending. */
      proposals: PendingProposal[];
    }
  | { type: "thread_gone"; ownerId: string | null; threadId: string }
  | {
      type: "history_failed";
      ownerId: string | null;
      threadId: string;
      error: { code: string; message: string };
    }
  | { type: "switch_thread"; threadId: string }
  | { type: "reset" };

export function initialAssistantState(): AssistantState {
  return {
    ownerId: null,
    threadId: null,
    messages: [],
    status: "idle",
    streamingId: null,
    streamBaseId: null,
    segmentSeq: 0,
    pendingProposals: [],
    usage: null,
    model: null,
    reasoning: null,
    error: null,
  };
}

/**
 * The state safe to render for `userId`. When the conversation in state belongs
 * to a different user (the single commit between an auth change and the hydrate
 * that follows it), return a fresh empty state instead of the prior user's
 * transcript — so an account's messages and proposals are never shown, even for
 * one frame, under another account.
 */
export function selectVisibleState(
  state: AssistantState,
  userId: string | null,
): AssistantState {
  return state.ownerId === userId ? state : initialAssistantState();
}

/** Drop the streaming assistant bubble if it never received any text (e.g. a
 *  turn that only proposed an action, or a failure before the first delta). */
function dropEmptyStreaming(
  messages: ChatMessage[],
  streamingId: string | null,
): ChatMessage[] {
  if (!streamingId) return messages;
  const msg = messages.find((m) => m.id === streamingId);
  if (msg && msg.role === "assistant" && msg.text === "") {
    return messages.filter((m) => m.id !== streamingId);
  }
  return messages;
}

function appendDelta(
  messages: ChatMessage[],
  streamingId: string | null,
  text: string,
): ChatMessage[] {
  if (!streamingId) return messages;
  return messages.map((m) =>
    m.id === streamingId ? { ...m, text: m.text + text } : m,
  );
}

function applyStreamEvent(
  state: AssistantState,
  event: AssistantStreamEvent,
): AssistantState {
  switch (event.type) {
    case "thread":
      return {
        ...state,
        threadId: event.data.threadId,
        // The model the server actually ran this turn against (lets the picker
        // reflect reality even when the user never explicitly chose one).
        model: event.data.model ?? state.model,
      };

    case "delta": {
      if (state.streamingId) {
        return {
          ...state,
          messages: appendDelta(
            state.messages,
            state.streamingId,
            event.data.text,
          ),
        };
      }
      // No open bubble: a tool ran and finalized the prior segment. Open a fresh
      // assistant bubble for this next reasoning segment so the agent's pre- and
      // post-tool text are distinct messages, not one concatenated blob.
      if (!state.streamBaseId) return state; // stray delta outside a turn
      const segmentSeq = state.segmentSeq + 1;
      const id = `${state.streamBaseId}-s${segmentSeq}`;
      return {
        ...state,
        segmentSeq,
        streamingId: id,
        messages: capMessages([
          ...state.messages,
          { id, role: "assistant", text: event.data.text },
        ]),
      };
    }

    case "reasoning":
      // Accumulate the turn's reasoning text; the panel shows it dim while the
      // answer is still pending so a long thinking gap doesn't read as frozen.
      return {
        ...state,
        reasoning: (state.reasoning ?? "") + event.data.text,
      };

    case "tool_call": {
      // A read-only tool started. Finalize the current text segment (dropping it
      // if it never received text, so a tool that runs before any preamble leaves
      // no empty bubble), then append a live "running" activity chip. Dedupe by
      // callId so a re-delivered event can't double-add the chip.
      const trimmed = dropEmptyStreaming(state.messages, state.streamingId);
      const chipId = `tool-${event.data.callId}`;
      if (trimmed.some((m) => m.id === chipId)) {
        return { ...state, messages: trimmed, streamingId: null };
      }
      const chip: ChatMessage = {
        id: chipId,
        role: "tool",
        text: "",
        tool: {
          name: event.data.name,
          status: "running",
          args: event.data.args,
        },
      };
      return {
        ...state,
        streamingId: null,
        messages: capMessages([...trimmed, chip]),
      };
    }

    case "tool_result": {
      // Resolve the activity chip the matching tool_call opened: mark it ok, or
      // failed with the error text. (Mutating tools never arrive here — they are
      // proposed and confirmed through the execute endpoint.)
      const chipId = `tool-${event.data.callId}`;
      const status = event.data.ok ? "ok" : "failed";
      const errText = event.data.ok
        ? ""
        : (event.data.error?.message ?? "unknown error");
      // Retain the outcome on the chip so a renderer can show the tool's result
      // body, not just name + status. (The error text stays in `.text` too, for
      // the built-in timeline's one-line chip.)
      const outcome: ToolOutcome = event.data.ok
        ? { ok: true, result: event.data.output }
        : { ok: false, error: event.data.error };
      if (state.messages.some((m) => m.id === chipId)) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === chipId
              ? {
                  ...m,
                  text: errText,
                  // Preserve the args the matching tool_call recorded — the
                  // result event doesn't carry them.
                  tool: {
                    name: event.data.name,
                    status,
                    args: m.tool?.args,
                    outcome,
                  },
                }
              : m,
          ),
        };
      }
      // Defensive: a result with no preceding tool_call (shouldn't happen now
      // that the server emits both) — surface it as a finished chip rather than
      // dropping the information.
      const chip: ChatMessage = {
        id: chipId,
        role: "tool",
        text: errText,
        tool: { name: event.data.name, status, outcome },
      };
      return { ...state, messages: capMessages([...state.messages, chip]) };
    }

    case "tool_proposal": {
      if (state.pendingProposals.some((p) => p.callId === event.data.callId)) {
        return state;
      }
      // event.data carries requirements (when authoring) — stored verbatim as
      // the PendingProposal so the card can render them.
      return {
        ...state,
        pendingProposals: [...state.pendingProposals, event.data],
      };
    }

    case "usage":
      return {
        ...state,
        usage: {
          costUsd: event.data.costUsd,
          balanceUsd: event.data.balanceUsd,
          promptTokens: event.data.promptTokens,
          completionTokens: event.data.completionTokens,
          durationMs: event.data.durationMs ?? null,
          replayed: event.data.replayed ?? false,
        },
      };

    case "done": {
      let messages = dropEmptyStreaming(state.messages, state.streamingId);
      // A capped turn hit the per-turn step limit before the model finished its
      // plan (e.g. partway through authoring a workflow). Surface it as a status
      // note so a partial reply is never mistaken for a complete answer, and the
      // user knows they can ask it to continue (the thread keeps the context).
      if (event.data.capped) {
        messages = capMessages([
          ...messages,
          {
            id: `cap-${event.data.turnId}`,
            role: "status",
            text: "I reached the step limit for this turn. Ask me to continue and I'll pick up where I left off.",
          },
        ]);
      }
      return {
        ...state,
        messages,
        streamingId: null,
        status: state.pendingProposals.length > 0 ? "awaiting_confirm" : "idle",
      };
    }

    case "error": {
      const messages = dropEmptyStreaming(state.messages, state.streamingId);
      return {
        ...state,
        messages,
        streamingId: null,
        status: "idle",
        // A turn that didn't complete cleanly leaves no confirmable action: a
        // proposal buffered before the failure must not stay actionable.
        pendingProposals: [],
        error: { code: event.data.code, message: event.data.message },
      };
    }
  }
}

export function assistantReducer(
  state: AssistantState,
  action: AssistantAction,
): AssistantState {
  switch (action.type) {
    case "send":
      // Pending proposals are intentionally preserved, not cleared: a new turn
      // must never silently drop an unconfirmed mutating action (which would
      // orphan its server-side proposal). The hook + composer block sending
      // while any proposal is pending, so a correct flow never reaches here with
      // one outstanding.
      return {
        ...state,
        messages: capMessages([
          ...state.messages,
          { id: action.messageId, role: "user", text: action.text },
          { id: action.assistantId, role: "assistant", text: "" },
        ]),
        status: "streaming",
        streamingId: action.assistantId,
        // The first bubble is segment 0; tool-finalized segments derive their id
        // from this base, so they stay unique across turns.
        streamBaseId: action.assistantId,
        segmentSeq: 0,
        usage: null,
        reasoning: null,
        error: null,
      };

    case "stream":
      return applyStreamEvent(state, action.event);

    case "stream_failed": {
      const messages = dropEmptyStreaming(state.messages, state.streamingId);
      return {
        ...state,
        messages,
        streamingId: null,
        status: "idle",
        // A failed turn leaves no confirmable action (see the `error` case).
        pendingProposals: [],
        error: action.error,
      };
    }

    case "proposal_resolved": {
      // Identify the card by callId — the model's tool-call id, which is always
      // present (proposalId can be null) and unique per proposal. confirm/cancel
      // always carry the card's own callId, so this removes exactly that card and
      // never leaves one stuck.
      const pendingProposals = state.pendingProposals.filter(
        (p) => p.callId !== action.callId,
      );
      const messages = action.status
        ? capMessages([...state.messages, action.status])
        : state.messages;
      return {
        ...state,
        messages,
        pendingProposals,
        error: action.error,
        status:
          pendingProposals.length > 0
            ? "awaiting_confirm"
            : state.status === "awaiting_confirm"
              ? "idle"
              : state.status,
      };
    }

    case "proposal_retry_failed": {
      // A retryable confirm failure (an unconnected integration): KEEP the card
      // and attach the message to it so the user can connect the provider and
      // confirm again. No top-level error banner; the message lives on the card,
      // next to the requirements + connect affordance that fix it.
      const pendingProposals = state.pendingProposals.map((p) =>
        p.callId === action.callId ? { ...p, retryError: action.message } : p,
      );
      // Derive status from whether a proposal is still pending — never force
      // `awaiting_confirm` unconditionally. In the live flow the card is always
      // still here (this handler keeps it), but computing the status the same
      // way `proposal_resolved` does keeps the state machine correct-by-
      // construction: a dropped proposal can't resurrect a stale awaiting state.
      return {
        ...state,
        pendingProposals,
        status:
          pendingProposals.length > 0
            ? "awaiting_confirm"
            : state.status === "awaiting_confirm"
              ? "idle"
              : state.status,
      };
    }

    case "stopped":
      // Keep whatever text already streamed; just stop accumulating. Drop the
      // assistant bubble if it never received a delta (stopped before the first
      // token), and drop a proposal buffered before the stop — the aborted turn
      // leaves no confirmable action.
      return {
        ...state,
        messages: dropEmptyStreaming(state.messages, state.streamingId),
        status: "idle",
        streamingId: null,
        pendingProposals: [],
      };

    case "hydrate":
      // Replace the whole conversation with a freshly loaded thread, dropping
      // all transient state, and stamp it with its owner. Used when the
      // signed-in user changes under a mounted panel so one account's transcript
      // can never carry into another.
      return {
        ...initialAssistantState(),
        ownerId: action.ownerId,
        threadId: action.threadId,
        messages: action.messages,
      };

    case "restore_history":
      // Apply the server-restored transcript ONLY if the conversation hasn't
      // moved on since the fetch began: same owner + thread, still idle, nothing
      // shown yet, AND no live proposal already pending. Otherwise the user
      // already started interacting (or switched account / started a new chat)
      // and a late restore must not clobber the live state or resurrect a prior
      // thread. The `pendingProposals` check is belt-and-suspenders: an idle,
      // empty conversation has no pending proposals (the `done`/resolve handlers
      // keep `idle ⟺ no proposals`), so this can't fire in normal flow — but it
      // makes the restore self-protective against a future invariant change
      // rather than relying on a cross-handler guarantee to avoid dropping a
      // live, unconfirmed proposal (the exact loss this PR exists to prevent).
      if (
        state.ownerId !== action.ownerId ||
        state.threadId !== action.threadId ||
        state.status !== "idle" ||
        state.messages.length > 0 ||
        state.pendingProposals.length > 0
      ) {
        return state;
      }
      // Restore the transcript AND any unconfirmed proposals — a card is
      // otherwise client-ephemeral, so without this the user loses the ability to
      // confirm a pending action on reload. A restored proposal puts the
      // conversation back in `awaiting_confirm` so the card renders and the
      // composer stays gated until it's resolved.
      return {
        ...state,
        messages: capMessages(action.messages),
        pendingProposals: action.proposals,
        status: action.proposals.length > 0 ? "awaiting_confirm" : state.status,
      };

    case "thread_gone":
      // The persisted thread no longer exists server-side (history restore got a
      // 404). Drop the dead id — but only if the conversation hasn't moved on
      // (same owner + thread, still idle, nothing shown), mirroring the
      // restore_history guard — so the next send starts a fresh thread instead of
      // 404-ing forever against a thread that's gone. A started turn / new chat /
      // switched account is left untouched.
      if (
        state.ownerId !== action.ownerId ||
        state.threadId !== action.threadId ||
        state.status !== "idle" ||
        state.messages.length > 0
      ) {
        return state;
      }
      return { ...state, threadId: null };

    case "history_failed":
      // A switched-to thread's transcript couldn't be loaded. Drop the active
      // thread and surface the error — the thread carries server-side context
      // (prior turns, possibly secrets) that isn't on screen, so the next send
      // must NOT run against it; it starts a fresh thread instead. Guarded like
      // restore_history so a late failure can't reset a conversation that has
      // since moved on (a started turn / new chat / switched account).
      if (
        state.ownerId !== action.ownerId ||
        state.threadId !== action.threadId ||
        state.status !== "idle" ||
        state.messages.length > 0
      ) {
        return state;
      }
      return {
        ...initialAssistantState(),
        ownerId: state.ownerId,
        error: action.error,
      };

    case "switch_thread":
      // Open an existing thread the user picked from history. Reset to a clean
      // idle state for the SAME owner and pin the chosen thread id, so the
      // follow-up history fetch (restore_history) — which only applies on a
      // matching owner+thread that is still idle/empty — lands its transcript
      // here. A no-op if it's already the active thread.
      if (state.threadId === action.threadId) return state;
      return {
        ...initialAssistantState(),
        ownerId: state.ownerId,
        threadId: action.threadId,
      };

    case "reset":
      // "New chat" for the same user — start a fresh thread while the prior ones
      // stay reachable from history. Keep the owner so the cleared state stays
      // visible (a null owner would be masked by selectVisibleState).
      return { ...initialAssistantState(), ownerId: state.ownerId };
  }
}
