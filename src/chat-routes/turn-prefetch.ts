/**
 * The turn's read-only prefetch: the inputs its prompt needs (profile, knowledge, catalogs), read while `authorize`
 * finishes instead of after it.
 *
 * `authorize` calls `identified({ tenantId, userId })` once it has verified who is asking, and the route starts the
 * product's `prefetch` then, beside the rest of `authorize` (billing gates, rate limits). Nothing it read reaches the
 * producer unless `authorize` allows the turn for that same identity; on a refusal its signal aborts and its result
 * is dropped. An `authorize` that never calls `identified` still gets the prefetch, started once it allows the turn.
 *
 * Why: Legal's turns ran `authorize` (~716 ms) and then the prompt reads (~597 ms) in series before the model call
 * (dispatchMs median 1,567 ms); Creative overlaps the same reads by hand (creative-agent
 * chat-vertical.ts:289). The contract: the prefetch only reads. It writes nothing and calls nothing paid or external
 * as the member beyond what the verified identity already allows.
 */
import type { TurnTrace } from '../turn-trace/recorder'
import type { ChatTurnRequestPayload } from './wire'

/** Who `authorize` verified the caller to be: the workspace (tenant) and the member. */
export interface ChatTurnPrefetchIdentity {
  tenantId: string
  userId: string
}

export interface ChatTurnPrefetchArgs extends ChatTurnPrefetchIdentity {
  request: Request
  body: ChatTurnRequestPayload
  trace: TurnTrace
  /** Aborts when the turn is refused; stop reading. */
  signal: AbortSignal
}

export type ChatTurnPrefetch = (args: ChatTurnPrefetchArgs) => unknown

export interface TurnPrefetchRun {
  /** For `authorize`: the caller's identity is verified; start the prefetch now. Later calls are ignored. */
  identified(identity: ChatTurnPrefetchIdentity): void
  /** `authorize` allowed the turn: the prefetch for this identity, started now if `identified` never ran or named
   *  someone else. */
  admitted(identity: ChatTurnPrefetchIdentity): Promise<unknown>
  /** The turn was refused: abort the prefetch and drop what it read. */
  discard(): void
}

export function startTurnPrefetch(
  prefetch: ChatTurnPrefetch,
  input: { request: Request; body: ChatTurnRequestPayload; trace: TurnTrace },
): TurnPrefetchRun {
  let started: { identity: ChatTurnPrefetchIdentity; abort: AbortController; result: Promise<unknown> } | undefined
  const start = (identity: ChatTurnPrefetchIdentity) => {
    const abort = new AbortController()
    const result = input.trace.measure('admission.prefetch', 'admission', async () => prefetch({
      ...input, tenantId: identity.tenantId, userId: identity.userId, signal: abort.signal,
    }))
    // A refused turn never awaits it; its failure must not become an unhandled rejection.
    result.catch(() => {})
    started = { identity: { ...identity }, abort, result }
  }
  return {
    identified(identity) {
      if (!started) start(identity)
    },
    admitted(identity) {
      if (started && (started.identity.tenantId !== identity.tenantId || started.identity.userId !== identity.userId)) {
        // Read for a different identity than the one admitted: never hand it on.
        started.abort.abort()
        started = undefined
      }
      if (!started) start(identity)
      return started!.result
    },
    discard() {
      started?.abort.abort()
      started = undefined
    },
  }
}
