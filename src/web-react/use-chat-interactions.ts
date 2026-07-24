/**
 * useChatInteractions — the interaction-state wiring every consumer of
 * `ChatStreamCallbacks.onInteraction` re-implements: an id-keyed,
 * insertion-ordered list with
 *
 *   - forward-only status transitions (a replayed/stale `pending` never
 *     resurrects a resolved card),
 *   - pending-question content dedupe (a re-emitted duplicate ask never renders
 *     a second card),
 *   - cancel-event application (`interaction.cancel` → cancelled/expired),
 *   - local resolution marking (the card's `onResolved`),
 *   - reload restore from the answer route's GET list (sidecar registry is the
 *     source of truth after a reload),
 *   - turn-end settling (client mirror of the server's finalize pass: a turn
 *     that completed without a cancel was answered; a failed turn can make no
 *     such claim).
 *
 * The reducer functions are pure and exported for non-React consumers/tests;
 * the hook is a thin `useState` shell over them.
 */

import { useCallback, useMemo, useState } from 'react'
import {
  cancelStatusFor,
  interactionFromWireRequest,
  isTerminalInteractionStatus,
  questionInteractionContentSignature,
  type ChatInteraction,
  type ChatInteractionStatus,
  type InteractionAnswers,
  type InteractionCancelData,
  type InteractionRequestWire,
} from './chat-interactions'

function hasPendingContentDuplicate(list: ChatInteraction[], interaction: ChatInteraction): boolean {
  if (interaction.status !== 'pending') return false
  const signature = questionInteractionContentSignature(interaction)
  if (!signature) return false
  return list.some((item) =>
    item.id !== interaction.id &&
    item.status === 'pending' &&
    questionInteractionContentSignature(item) === signature)
}

/** Insert or update one interaction. A terminal existing entry wins over any
 *  incoming state for the same id; a new pending ask that duplicates another
 *  pending ask's content is dropped. Returns the same array when unchanged. */
export function upsertChatInteraction(list: ChatInteraction[], interaction: ChatInteraction): ChatInteraction[] {
  const index = list.findIndex((item) => item.id === interaction.id)
  if (index === -1) {
    if (hasPendingContentDuplicate(list, interaction)) return list
    return [...list, interaction]
  }
  const existing = list[index]
  if (!existing) return list
  if (isTerminalInteractionStatus(existing.status)) {
    if (
      existing.status === interaction.status &&
      (!existing.answers && interaction.answers || !existing.cancelReason && interaction.cancelReason)
    ) {
      const next = [...list]
      next[index] = { ...existing, ...interaction }
      return next
    }
    return list
  }
  const next = [...list]
  next[index] = interaction
  return next
}

/** Applies an `interaction.cancel` event: only a pending ask moves, to
 *  `expired` (reason:"timeout") or `cancelled`. */
export function cancelChatInteraction(list: ChatInteraction[], cancel: InteractionCancelData): ChatInteraction[] {
  const index = list.findIndex((item) => item.id === cancel.id)
  const existing = list[index]
  if (!existing || existing.status !== 'pending') return list
  const next = [...list]
  next[index] = {
    ...existing,
    status: cancelStatusFor(cancel.reason),
    ...(cancel.reason ? { cancelReason: cancel.reason } : {}),
  }
  return next
}

/** Marks one ask resolved locally (the card's `onResolved`). Forward-only. */
export function resolveChatInteraction(
  list: ChatInteraction[],
  id: string,
  status: Exclude<ChatInteractionStatus, 'pending'>,
  answers?: InteractionAnswers,
): ChatInteraction[] {
  const index = list.findIndex((item) => item.id === id)
  const existing = list[index]
  if (!existing || existing.status !== 'pending') return list
  const next = [...list]
  next[index] = { ...existing, status, ...(answers ? { answers } : {}) }
  return next
}

/** Settles every still-pending ask when the turn ends: `answered` for a turn
 *  that completed cleanly, `expired` for one that failed. */
export function terminalizePendingChatInteractions(
  list: ChatInteraction[],
  status: Extract<ChatInteractionStatus, 'answered' | 'expired'>,
): ChatInteraction[] {
  if (!list.some((item) => item.status === 'pending')) return list
  return list.map((item) => (item.status === 'pending' ? { ...item, status } : item))
}

/** Define modes for restoring chat interactions with legacy or durable strategies */
export type ChatInteractionRestoreMode = 'legacy' | 'durable'

/** Define options to control how chat interactions are restored during the restore process */
export interface RestoreChatInteractionsOptions {
  /**
   * `legacy` settles pending asks absent from the sidecar list as answered,
   * preserving the pre-durable restore contract. `durable` leaves them
   * pending because absence is ambiguous until `hydrateChatInteractions`
   * applies the durable projection.
   */
  mode?: ChatInteractionRestoreMode
}

/** Reload restore from the answer route's GET list. Legacy consumers retain
 * the historical absence→answered behavior; durable consumers opt into the
 * ambiguity-preserving mode and apply terminal parts through `hydrate`. */
export function restoreChatInteractions(
  list: ChatInteraction[],
  outstanding: InteractionRequestWire[],
  options: RestoreChatInteractionsOptions = {},
): ChatInteraction[] {
  let next = list
  for (const request of outstanding) {
    const interaction = interactionFromWireRequest(request)
    const exact = next.findIndex((item) => item.id === interaction.id)
    if (exact !== -1) {
      next = upsertChatInteraction(next, interaction)
      continue
    }
    const signature = questionInteractionContentSignature(interaction)
    const obsolete = signature
      ? next.findIndex((item) => item.status === 'pending' && questionInteractionContentSignature(item) === signature)
      : -1
    if (obsolete === -1) {
      next = [...next, interaction]
      continue
    }
    next = [...next]
    next[obsolete] = interaction
  }
  if (options.mode !== 'durable') {
    const outstandingIds = new Set(outstanding.map((request) => request.id))
    next = next.map((item) =>
      item.status === 'pending' && !outstandingIds.has(item.id)
        ? { ...item, status: 'answered' as const }
        : item)
  }
  return next
}

/** Applies transcript/state-store projections after reload. Terminal state and
 * acknowledged answer values enrich an existing pending card without relying
 * on the sidecar's outstanding-list absence. */
export function hydrateChatInteractions(
  list: ChatInteraction[],
  persisted: ChatInteraction[],
): ChatInteraction[] {
  return persisted.reduce(upsertChatInteraction, list)
}

/** Resolve and manage chat interactions with methods to update, cancel, mark resolved, and restore state */
export interface UseChatInteractionsResult {
  /** All known interactions, insertion-ordered. */
  interactions: ChatInteraction[]
  /** The asks currently blocking the run (waiting on the user). */
  pending: ChatInteraction[]
  /** Wire to `ChatStreamCallbacks.onInteraction` (and persisted-part replay). */
  upsert: (interaction: ChatInteraction) => void
  /** Wire to `interaction.cancel` events. */
  applyCancel: (cancel: InteractionCancelData) => void
  /** Wire to the cards' `onResolved`. */
  markResolved: (id: string, status: Exclude<ChatInteractionStatus, 'pending'>, answers?: InteractionAnswers) => void
  /** Wire to the answer route's GET list after a reload/reconnect. */
  restore: (outstanding: InteractionRequestWire[], options?: RestoreChatInteractionsOptions) => void
  /** Apply durable transcript/state projections after a reload. */
  hydrate: (persisted: ChatInteraction[]) => void
  /** Settle still-pending asks when the turn ends. */
  terminalizePending: (status: Extract<ChatInteractionStatus, 'answered' | 'expired'>) => void
  /** Drop everything (thread switch). */
  reset: () => void
}

/** Resolve options for restoring chat interactions from previous sessions */
export type UseChatInteractionsOptions = RestoreChatInteractionsOptions

/** Manage chat interactions state with upsert, cancel, resolve, and restore capabilities */
export function useChatInteractions(options: UseChatInteractionsOptions = {}): UseChatInteractionsResult {
  const [interactions, setInteractions] = useState<ChatInteraction[]>([])

  const upsert = useCallback((interaction: ChatInteraction) => {
    setInteractions((prev) => upsertChatInteraction(prev, interaction))
  }, [])
  const applyCancel = useCallback((cancel: InteractionCancelData) => {
    setInteractions((prev) => cancelChatInteraction(prev, cancel))
  }, [])
  const markResolved = useCallback((id: string, status: Exclude<ChatInteractionStatus, 'pending'>, answers?: InteractionAnswers) => {
    setInteractions((prev) => resolveChatInteraction(prev, id, status, answers))
  }, [])
  const restore = useCallback((outstanding: InteractionRequestWire[], restoreOptions?: RestoreChatInteractionsOptions) => {
    setInteractions((prev) => restoreChatInteractions(prev, outstanding, {
      mode: restoreOptions?.mode ?? options.mode,
    }))
  }, [options.mode])
  const hydrate = useCallback((persisted: ChatInteraction[]) => {
    setInteractions((prev) => hydrateChatInteractions(prev, persisted))
  }, [])
  const terminalizePending = useCallback((status: Extract<ChatInteractionStatus, 'answered' | 'expired'>) => {
    setInteractions((prev) => terminalizePendingChatInteractions(prev, status))
  }, [])
  const reset = useCallback(() => setInteractions([]), [])

  const pending = useMemo(() => interactions.filter((item) => item.status === 'pending'), [interactions])

  return { interactions, pending, upsert, applyCancel, markResolved, restore, hydrate, terminalizePending, reset }
}
