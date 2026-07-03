/**
 * React binding for the assistant panel: owns the reducer, drives the chat SSE
 * stream and the proposal-confirmation call, and persists the thread across
 * reloads. All rendering decisions live in the pure reducer + presentation
 * helpers; this hook is the glue between them and the network.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AssistantClientInputError } from "./client";
import { useAssistantClient } from "./client-context";
import { loadThread, saveThread } from "./persistence";
import { resolveConfirmation } from "./presentation";
import {
  type AssistantState,
  assistantReducer,
  initialAssistantState,
  selectVisibleState,
} from "./reducer";
import type {
  AssistantDeliveryMode,
  ChatMessage,
  PendingProposal,
} from "./types";

export interface AssistantSendOptions {
  deliveryMode?: AssistantDeliveryMode;
}

interface PendingQueuedSend {
  ownerId: string | null;
  text: string;
  model?: string;
  threadId?: string;
}

/** Host integration callbacks for {@link useAssistantChat}. */
export interface UseAssistantChatOptions {
  /**
   * Called after a workflow-mutating tool (`create_workflow`, `author_workflow`,
   * …) is confirmed successfully — the host re-fetches its workflow list so the
   * result appears without a manual reload. Replaces the in-app cross-module
   * signal the platform used.
   */
  onWorkflowMutation?: () => void;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/** Confirmed tools whose success changes the caller's workflow set — on success
 *  the Workflows page is signaled to refetch so the result appears without a
 *  manual reload. */
const WORKFLOW_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "create_workflow",
  "author_workflow",
  "update_workflow",
  "set_workflow_enabled",
]);

function statusMessage(text: string): ChatMessage {
  return { id: `status-${uuid()}`, role: "status", text };
}

function uuid(): string {
  return crypto.randomUUID();
}

export interface AssistantChat {
  state: AssistantState;
  /** Proposal ids whose confirmation is currently in flight (for disabling). */
  confirmingIds: ReadonlySet<string>;
  /** The user's selected model slug, or null to use the server default. */
  selectedModel: string | null;
  /** Choose the model for subsequent turns (persisted per user). */
  setModel: (model: string | null) => void;
  send: (message: string, options?: AssistantSendOptions) => void;
  stop: () => void;
  confirm: (proposal: PendingProposal) => Promise<void>;
  cancel: (proposal: PendingProposal) => void;
  reset: () => void;
  /** Open an existing thread from history, loading its transcript. */
  switchThread: (threadId: string) => void;
  /** True while a switched-to thread's transcript is loading — the composer is
   *  held closed until it resolves so a turn can't run against hidden context. */
  restoring: boolean;
}

export function useAssistantChat(
  userId: string | null,
  options?: UseAssistantChatOptions,
): AssistantChat {
  const [state, dispatch] = useReducer(
    assistantReducer,
    userId,
    (uid): AssistantState => {
      return {
        ...initialAssistantState(),
        ownerId: uid,
        threadId: loadThread(uid).threadId,
      };
    },
  );

  const abortRef = useRef<AbortController | null>(null);
  const pendingQueuedSendRef = useRef<PendingQueuedSend | null>(null);
  // Aborts an in-flight thread-history restore when the user changes or the
  // panel unmounts, so a late response can't land in a different conversation.
  const historyAbortRef = useRef<AbortController | null>(null);
  // Records which userId the state has already been hydrated for, so the
  // user-change effect fires exactly once per switch. Persistence does NOT key
  // off this — it keys off `state.ownerId`, which moves atomically with the data.
  const hydratedUserRef = useRef<string | null>(userId);
  // Monotonic token identifying the authoritative stream. Aborting is async, so
  // a superseded stream can still have buffered events in flight; each stream
  // captures its token at start and its callbacks no-op once the token moves on.
  // This is what stops a prior user's late events from landing in a new user's
  // hydrated state (a cross-account leak that abort alone cannot prevent).
  const streamSeqRef = useRef(0);
  // Same idea for the (non-abortable) confirmation request: it captures this
  // token before awaiting and no-ops once the conversation it belonged to has
  // been replaced by a user switch or reset, so a late confirmation response
  // cannot append into a different user's hydrated thread.
  const confirmSeqRef = useRef(0);
  // Latest state + current userId, readable from event-handler closures without
  // re-creating them. Written during render (not a passive effect) so the owner
  // guard in `send`/`confirm` sees the new user on the very commit after an auth
  // change — a passive effect would lag by a frame, leaving a window where a send
  // could still target the prior user's thread.
  //
  // These refs are read only in event handlers, which fire after a commit (by
  // which point React has committed the latest render and updated them), so they
  // reflect committed state at read time. A render thrown away under concurrent
  // mode could momentarily leave a ref pointing at uncommitted state, but the
  // failure degrades safely: the owner guard (`ownerId !== userIdRef.current`)
  // would at worst DROP a send — never leak — and a mismatched thread id is
  // rejected server-side (404) regardless.
  const stateRef = useRef(state);
  const userIdRef = useRef(userId);
  stateRef.current = state;
  userIdRef.current = userId;

  // The transport, held in a ref so the event-handler callbacks (send/confirm/
  // switchThread) keep stable identities while still reaching the current client.
  const client = useAssistantClient();
  const clientRef = useRef(client);
  clientRef.current = client;

  // Host callbacks held in a ref so the event-handler callbacks below keep
  // stable identities while still calling the latest-supplied handler.
  const onWorkflowMutationRef = useRef(options?.onWorkflowMutation);
  onWorkflowMutationRef.current = options?.onWorkflowMutation;

  // Proposal ids whose confirmation request is in flight. The ref is the
  // synchronous guard against a double-click issuing a duplicate execute; the
  // state mirror drives disabling the card's buttons.
  const confirmingRef = useRef<Set<string>>(new Set());
  const [confirmingIds, setConfirmingIds] =
    useState<ReadonlySet<string>>(EMPTY_IDS);

  // Synchronous "a chat request is in flight" guard. Set before the fetch and
  // cleared when it settles/stops/resets, so two submits in the same tick can't
  // both pass the status check and start two billable streams.
  const sendingRef = useRef(false);

  // True while a thread opened from history is loading its transcript. The
  // composer is disabled until it resolves so a send can't run a turn against
  // server-side context the user can't yet see. The ref is the synchronous guard
  // for `send`; the state drives the disabled composer. Only `switchThread` sets
  // it (the mount restore resumes the user's own current thread).
  const restoringRef = useRef(false);
  const [restoring, setRestoring] = useState(false);
  const setRestoringBoth = useCallback((v: boolean) => {
    restoringRef.current = v;
    setRestoring(v);
  }, []);

  // The user's selected model (a per-user preference, persisted alongside the
  // thread id). A ref mirror lets `send` read the current choice without being
  // re-created. null → the server's default model.
  const [selectedModel, setSelectedModel] = useState<string | null>(
    () => loadThread(userId).model,
  );
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;

  const clearPendingQueuedSend = useCallback(() => {
    pendingQueuedSendRef.current = null;
  }, []);

  const abortActiveStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const startChatStream = useCallback(
    (
      text: string,
      deliveryMode: AssistantDeliveryMode | undefined,
      model: string | undefined,
      threadId: string | undefined,
    ) => {
      dispatch({
        type: "send",
        messageId: uuid(),
        assistantId: uuid(),
        text,
      });

      const seq = ++streamSeqRef.current;
      const ac = new AbortController();
      abortRef.current = ac;
      sendingRef.current = true;
      clientRef.current
        .streamChat(
          {
            message: text,
            deliveryMode,
            // null → omit, so the server applies its default model.
            model,
            threadId,
            turnKey: uuid(),
          },
          (event) => {
            // Drop events from a stream that has been superseded (new turn,
            // stop, reset, or user switch) so they cannot mutate unrelated state.
            if (streamSeqRef.current === seq) dispatch({ type: "stream", event });
          },
          ac.signal,
        )
        .catch((err: unknown) => {
          // A user-initiated abort is reported via the `stopped` action, not as a
          // failure; a superseded stream is ignored entirely. Only surface a
          // genuine network/parse error for the still-current stream.
          if (ac.signal.aborted || streamSeqRef.current !== seq) return;
          dispatch({
            type: "stream_failed",
            error: {
              code:
                err instanceof AssistantClientInputError
                  ? err.code
                  : "NETWORK",
              message:
                err instanceof Error ? err.message : "The connection failed",
            },
          });
        })
        .finally(() => {
          // This stream is over (settled, failed, or aborted) — allow the next
          // send. A superseded stream clearing the flag is harmless: a newer send
          // already set its own.
          if (streamSeqRef.current === seq) sendingRef.current = false;
          if (abortRef.current === ac) abortRef.current = null;
        });
    },
    [],
  );

  // When the signed-in user changes under a mounted panel (auth refresh, or a
  // mount before auth resolved), invalidate the in-flight stream, abort it, and
  // reload that user's own thread. Without this, the prior user's transcript
  // would persist under the new user's key — a cross-account leak.
  useEffect(() => {
    if (hydratedUserRef.current === userId) return;
    streamSeqRef.current += 1;
    confirmSeqRef.current += 1;
    abortActiveStream();
    clearPendingQueuedSend();
    // Abort a pending thread-history load and re-open the composer so a switch
    // that was mid-restore for the prior user doesn't leave the new user's
    // conversation wedged closed.
    historyAbortRef.current?.abort();
    setRestoringBoth(false);
    sendingRef.current = false;
    confirmingRef.current.clear();
    setConfirmingIds(EMPTY_IDS);
    hydratedUserRef.current = userId;
    // Load the new user's own model preference (the prior user's must not carry
    // over). The ref is updated synchronously so a send on this commit reads it.
    const nextModel = loadThread(userId).model;
    selectedModelRef.current = nextModel;
    setSelectedModel(nextModel);
    dispatch({
      type: "hydrate",
      ownerId: userId,
      threadId: loadThread(userId).threadId,
      messages: [],
    });
  }, [userId, abortActiveStream, clearPendingQueuedSend, setRestoringBoth]);

  useEffect(() => {
    const pending = pendingQueuedSendRef.current;
    if (!pending || state.status === "streaming") return;
    pendingQueuedSendRef.current = null;
    if (
      pending.ownerId !== userIdRef.current ||
      state.pendingProposals.length > 0
    ) {
      return;
    }
    startChatStream(pending.text, "queue", pending.model, pending.threadId);
  }, [state.status, state.pendingProposals.length, startChatStream]);

  // Restore the visible transcript for the persisted thread from the server,
  // keyed by user (runs on mount and whenever the signed-in user changes). The
  // transcript is never cached client-side — it can carry workflow YAML or
  // pasted secrets, and localStorage survives logout — so a reload starts blank
  // and the prior conversation is rehydrated here from the durable thread.
  // The reducer applies it only if the conversation is still idle/empty for this
  // exact owner+thread, so a late response can never clobber a started turn, a
  // new chat, or a switched account.
  useEffect(() => {
    const threadId = loadThread(userId).threadId;
    if (!userId || !threadId) return;
    const ac = new AbortController();
    historyAbortRef.current?.abort();
    historyAbortRef.current = ac;
    void clientRef.current
      .fetchThreadHistory(threadId, ac.signal)
      .then((result) => {
        if (ac.signal.aborted) return;
        if (result.status === "ok") {
          // An existing thread with no completed turns AND no pending proposals
          // yields nothing to restore — keep the thread id (it's live). A pending
          // proposal alone is enough to restore (its card must come back).
          if (result.messages.length > 0 || result.proposals.length > 0) {
            dispatch({
              type: "restore_history",
              ownerId: userId,
              threadId,
              messages: result.messages,
              proposals: result.proposals,
            });
          }
        } else if (result.status === "gone") {
          // The thread was deleted server-side (404). Drop the dead id so the next
          // send starts fresh instead of 404-ing forever. The reducer setting
          // threadId to null cascades to the persistence effect, clearing storage.
          dispatch({ type: "thread_gone", ownerId: userId, threadId });
        }
        // status === "error" → transient; keep the thread id and don't restore.
      })
      .catch(() => {
        // fetchThreadHistory returns a typed {status:"error"} rather than
        // rejecting; guard a future change from leaking an unhandled rejection.
      });
    return () => ac.abort();
  }, [userId]);

  // Persist thread id + transcript whenever the conversation settles, under the
  // owner carried in state. Because `state.ownerId` and the data it labels move
  // together (set atomically by the reducer), a write can never land under a
  // different user's key. Skipped while streaming: `state.messages` gets a fresh
  // reference on every delta, so persisting per-delta would hammer localStorage;
  // the turn is saved once it settles (status leaves "streaming").
  useEffect(() => {
    if (state.status === "streaming") return;
    // Skip while the data's owner doesn't match the live user — the window
    // between an auth change and the hydrate that follows it. `selectedModelRef`
    // lives outside the reducer, so it can already hold the NEW user's preference
    // while `state.ownerId` still holds the OLD user's id; persisting then would
    // write the new user's model under the old user's key. The owner guard closes
    // that cross-account write, matching the same pattern `send`/`confirm` use.
    if (state.ownerId !== userIdRef.current) return;
    saveThread(state.ownerId, {
      threadId: state.threadId,
      model: selectedModelRef.current,
    });
    // `selectedModel` is intentionally NOT a dependency: a model-only change is
    // persisted immediately by `setModel` itself, so this effect only needs to
    // re-run on the conversation transitions above. If that direct persist is
    // ever removed, add `selectedModel` here.
  }, [state.ownerId, state.threadId, state.status]);

  // Abort any in-flight stream on unmount so a closed panel stops billing.
  useEffect(() => {
    return () => {
      abortActiveStream();
      clearPendingQueuedSend();
    };
  }, [abortActiveStream, clearPendingQueuedSend]);

  const send = useCallback((message: string, options?: AssistantSendOptions) => {
    const deliveryMode = options?.deliveryMode;
    const shouldQueue = deliveryMode === "queue";
    // Synchronous in-flight guard — closes the window where two submits in the
    // same tick both read a not-yet-committed `idle` status and start two
    // billable streams. Explicit queue is allowed through so the server can
    // append it behind the active response instead of forcing products to guard.
    if (sendingRef.current && !shouldQueue) return;
    if (shouldQueue && pendingQueuedSendRef.current) return;
    const text = message.trim();
    const current = stateRef.current;
    // Refuse if the loaded conversation doesn't belong to the current user. This
    // only differs for the brief committed frame between an auth change and the
    // hydrate that follows it, where `current` still holds the prior user's
    // thread — sending then would attach this message to that thread id.
    if (current.ownerId !== userIdRef.current) return;
    // Refuse while a switched-to thread's transcript is still loading — sending
    // now would run a turn against context the user can't see yet.
    if (restoringRef.current) return;
    // Refuse while a turn is streaming unless the caller explicitly queues the
    // text behind it, or while a mutating proposal is awaiting the user's
    // decision — a new turn must not abandon an unresolved proposal.
    if (!text) return;
    if (current.pendingProposals.length > 0) return;
    if (current.status === "streaming") {
      if (!shouldQueue) return;
      pendingQueuedSendRef.current = {
        ownerId: current.ownerId,
        text,
        model: selectedModelRef.current ?? undefined,
        threadId: current.threadId ?? undefined,
      };
      return;
    }

    startChatStream(
      text,
      deliveryMode,
      selectedModelRef.current ?? undefined,
      current.threadId ?? undefined,
    );
  }, [startChatStream]);

  const stop = useCallback(() => {
    streamSeqRef.current += 1;
    abortActiveStream();
    clearPendingQueuedSend();
    sendingRef.current = false;
    dispatch({ type: "stopped" });
  }, [abortActiveStream, clearPendingQueuedSend]);

  const confirm = useCallback(async (proposal: PendingProposal) => {
    const pid = proposal.proposalId;
    if (!pid) {
      dispatch({
        type: "proposal_resolved",
        callId: proposal.callId,
        status: null,
        error: {
          code: "TOOL_FAILED",
          message: "This action can no longer be confirmed.",
        },
      });
      return;
    }

    // Guard against a double-click issuing a duplicate execute for the same
    // proposal — the second would otherwise hit PROPOSAL_ALREADY_CONSUMED and
    // overwrite the first's success with an error.
    if (confirmingRef.current.has(pid)) return;
    confirmingRef.current.add(pid);
    setConfirmingIds(new Set(confirmingRef.current));

    // Snapshot the conversation generation; if a user switch or reset replaces
    // the conversation while this request is in flight, the late response must
    // not land in the new conversation.
    const seq = confirmSeqRef.current;
    try {
      const result = await clientRef.current.confirmProposal(pid);
      if (confirmSeqRef.current !== seq) return;
      // A RETRYABLE failure (the workflow references an integration that isn't
      // connected): the server re-opened the proposal, so KEEP the card and show
      // the reason on it. The user connects the integration (the card's Connect
      // button) and confirms again — no need to re-ask the assistant.
      if (result.ok && result.retryable) {
        const { error } = resolveConfirmation(proposal.name, result);
        dispatch({
          type: "proposal_retry_failed",
          callId: proposal.callId,
          message:
            error?.message ??
            "Connect the required integration, then confirm again.",
        });
        return;
      }
      const { statusText, error } = resolveConfirmation(proposal.name, result);
      dispatch({
        type: "proposal_resolved",
        callId: proposal.callId,
        status: statusText ? statusMessage(statusText) : null,
        error,
      });
      // A successful workflow mutation won't show on an already-open Workflows
      // page (it fetches on mount and shares no cache) — signal it to refetch.
      // `error === null` is the clean-success signal from resolveConfirmation.
      if (!error && WORKFLOW_MUTATING_TOOLS.has(proposal.name)) {
        onWorkflowMutationRef.current?.();
      }
    } catch (err) {
      if (confirmSeqRef.current !== seq) return;
      // confirmProposal returns a typed outcome rather than throwing, but guard
      // anyway: an unexpected throw must still clear the card and surface an
      // error instead of escaping as an unhandled rejection.
      dispatch({
        type: "proposal_resolved",
        callId: proposal.callId,
        status: null,
        error: {
          code: "TOOL_FAILED",
          message:
            err instanceof Error
              ? err.message
              : "The action could not be completed",
        },
      });
    } finally {
      // Only touch the in-flight set if this confirmation still owns the
      // conversation; a switch/reset already cleared it.
      if (confirmSeqRef.current === seq) {
        confirmingRef.current.delete(pid);
        setConfirmingIds(new Set(confirmingRef.current));
      }
    }
  }, []);

  const cancel = useCallback((proposal: PendingProposal) => {
    // Once a confirmation is in flight the action is already running server-side
    // and can't be cancelled — ignore a cancel click that races it, so the
    // transcript can't show both "cancelled" and the action's success.
    if (proposal.proposalId && confirmingRef.current.has(proposal.proposalId)) {
      return;
    }
    dispatch({
      type: "proposal_resolved",
      callId: proposal.callId,
      status: statusMessage("Action cancelled."),
      error: null,
    });
  }, []);

  const reset = useCallback(() => {
    streamSeqRef.current += 1;
    confirmSeqRef.current += 1;
    abortActiveStream();
    clearPendingQueuedSend();
    historyAbortRef.current?.abort();
    setRestoringBoth(false);
    sendingRef.current = false;
    confirmingRef.current.clear();
    setConfirmingIds(EMPTY_IDS);
    dispatch({ type: "reset" });
  }, [abortActiveStream, clearPendingQueuedSend, setRestoringBoth]);

  // Open a past thread from the history switcher: invalidate any in-flight
  // stream/confirmation (so their late events can't land in the switched-to
  // conversation), pin the chosen thread, persist it, then load its transcript.
  // Guarded by owner so a stale render can't switch under a different account.
  const switchThread = useCallback(
    (threadId: string) => {
      const current = stateRef.current;
      const uid = userIdRef.current;
      if (current.ownerId !== uid) return;
      if (threadId === current.threadId) return;
      // Refuse while a turn is streaming or a proposal is awaiting confirmation —
      // the same guard `send` uses. Navigating away would abandon the live turn /
      // unresolved proposal; the user finishes it, or "New chat" is the explicit
      // discard. The DISABLED switcher in the UI is the primary guard; this is the
      // backstop, so it silently no-ops by design for a programmatic/keyboard
      // caller that bypasses the disabled state.
      if (
        current.status === "streaming" ||
        current.pendingProposals.length > 0
      ) {
        return;
      }
      streamSeqRef.current += 1;
      confirmSeqRef.current += 1;
      abortActiveStream();
      clearPendingQueuedSend();
      sendingRef.current = false;
      confirmingRef.current.clear();
      setConfirmingIds(EMPTY_IDS);
      dispatch({ type: "switch_thread", threadId });
      // Hold the composer closed until the transcript loads — a send before then
      // would run a turn against context the user can't yet see.
      setRestoringBoth(true);
      // Persist the new active thread now so a reload before the next turn restores
      // it (the settled-save effect also covers it). Keep the current model choice.
      saveThread(uid, { threadId, model: selectedModelRef.current });
      // Load the chosen thread's transcript, superseding any in-flight history
      // fetch. restore_history only applies on a matching idle owner+thread, so a
      // mid-load send or a second switch can't be clobbered by this response.
      const ac = new AbortController();
      historyAbortRef.current?.abort();
      historyAbortRef.current = ac;
      void clientRef.current
        .fetchThreadHistory(threadId, ac.signal)
        .then((result) => {
          if (ac.signal.aborted) return;
          if (result.status === "ok") {
            if (result.messages.length > 0 || result.proposals.length > 0) {
              dispatch({
                type: "restore_history",
                ownerId: uid,
                threadId,
                messages: result.messages,
                proposals: result.proposals,
              });
            }
          } else if (result.status === "gone") {
            dispatch({ type: "thread_gone", ownerId: uid, threadId });
          } else {
            // Transient load failure: drop the active thread (it carries
            // server-side context the user can't see) and surface a visible
            // error. The next send then starts a FRESH thread rather than running
            // against the unloaded conversation's hidden context.
            dispatch({
              type: "history_failed",
              ownerId: uid,
              threadId,
              error: {
                code: "HISTORY_LOAD_FAILED",
                message:
                  "Couldn't load that conversation. You're in a new chat — reopen it from history to try again.",
              },
            });
          }
          // Re-open the composer once the load settles (success shows the
          // transcript; failure dropped the thread + showed the error above).
          // Only the current fetch clears it — a superseded one returned early on
          // `aborted`.
          setRestoringBoth(false);
        })
        .catch(() => {
          // fetchThreadHistory returns a typed {status:"error"} rather than
          // rejecting; guard a future change from leaking an unhandled rejection.
          if (!ac.signal.aborted) setRestoringBoth(false);
        });
    },
    [abortActiveStream, clearPendingQueuedSend, setRestoringBoth],
  );

  // Choose the model for subsequent turns. The model preference is per user, not
  // per turn, so persist it immediately (alongside the current thread id) rather
  // than waiting for a turn to settle.
  const setModel = useCallback((model: string | null) => {
    selectedModelRef.current = model;
    setSelectedModel(model);
    // Same owner guard the persistence effect uses: in the window between an auth
    // change and the hydrate that follows it, stateRef still holds the prior
    // user's thread while userIdRef already points to the new user. Persisting
    // then would write the new user's model (and the OLD user's thread id) under
    // a mismatched key. Skip it — the state still updates, and the next settled
    // save persists it once the owner is consistent.
    const currentUserId = userIdRef.current;
    if (stateRef.current.ownerId === currentUserId) {
      saveThread(currentUserId, {
        threadId: stateRef.current.threadId,
        model,
      });
    }
  }, []);

  // Reactive recovery: if a turn is rejected because the selected model is no
  // longer offered (e.g. ASSISTANT_MODELS was changed and a stale slug was still
  // persisted), clear the selection so the NEXT send falls back to the server
  // default instead of failing again. The picker also reconciles proactively
  // once the model list loads; this closes the window where a send races that
  // load. Guarded by owner so a late error from a prior user can't act here.
  useEffect(() => {
    if (
      state.error?.code === "MODEL_NOT_ALLOWED" &&
      state.ownerId === userIdRef.current &&
      selectedModelRef.current !== null
    ) {
      setModel(null);
    }
  }, [state.error, state.ownerId, setModel]);

  // Expose only state that belongs to the current user: between an auth change
  // and the hydrate effect that follows it, the raw state still holds the prior
  // user's conversation, which must never render. Operations (send/confirm) read
  // the raw state via `stateRef`, so they still act on the true thread.
  const visibleState = selectVisibleState(state, userId);
  return {
    state: visibleState,
    confirmingIds,
    selectedModel,
    setModel,
    send,
    stop,
    confirm,
    cancel,
    reset,
    switchThread,
    restoring,
  };
}
