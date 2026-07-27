/**
 * The LIVE half: judge each turn the moment it settles.
 *
 * This adds no control flow. `createChatTurnRoutes` already exposes a
 * `lifecycle` seam that fires exactly one of `onTurnComplete`/`onTurnError`
 * after a turn settles, and already swallows hook errors so telemetry cannot
 * fail a turn. That seam was shipped and then wired by nobody, which is a fair
 * description of why the outage lasted 17 days. This function fills it.
 *
 * The shape is declared structurally rather than imported from
 * `/chat-routes`, so `/turn-health` stays free of the server chat vertical and
 * can be used by any turn driver that reports the same three moments.
 */

import { classifyTurnOutcome } from './classify.js'
import { type AlertSink, createGuardedAlertSink, turnAlert } from './sink.js'

/** Structural mirror of `/chat-routes`' `ChatTurnLifecycle` complete payload. */
export interface TurnHealthCompleteInfo {
  finalText: string
  usage?: { outputTokens?: number | null } | null
  durationMs: number
  threadId?: string
  turnStreamId?: string
  executionId?: string
}

/** Structural mirror of the lifecycle error payload. */
export interface TurnHealthErrorInfo {
  error: unknown
  durationMs: number
  threadId?: string
  turnStreamId?: string
  executionId?: string
}

/** What {@link createTurnHealthLifecycle} returns — assignable to
 *  `createChatTurnRoutes`' `lifecycle` option. */
export interface TurnHealthLifecycle {
  onTurnComplete(info: TurnHealthCompleteInfo): Promise<void>
  onTurnError(info: TurnHealthErrorInfo): Promise<void>
}

export interface TurnHealthLifecycleOptions {
  /** Names the product in every alert. */
  product: string
  sink: AlertSink
  /** Called for every verdict, healthy or not — the hook for a counter or a
   *  metrics push. Alerts are for humans; this is for graphs. */
  onVerdict?(verdict: {
    product: string
    healthy: boolean
    kinds: string[]
    durationMs: number
  }): void
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

/**
 * Build the lifecycle hooks that page on a turn which succeeded at nothing.
 *
 * The live lane sees `finalText` and usage but not the persisted parts, so it
 * catches the blank-completion and hard-failure shapes immediately. The
 * parts-dependent shapes (a tool call whose arguments never parsed, a tool
 * call that left no effect) are caught by {@link sweepSilentFailures}, which
 * reads what was actually written to the store — the honest place to ask
 * whether an effect persisted.
 */
export function createTurnHealthLifecycle(
  options: TurnHealthLifecycleOptions,
): TurnHealthLifecycle {
  // Guarded: a paging failure must never take down a customer's turn.
  const sink = createGuardedAlertSink(options.sink)

  return {
    async onTurnComplete(info) {
      const verdict = classifyTurnOutcome({
        finalText: info.finalText,
        outputTokens: info.usage?.outputTokens ?? null,
        durationMs: info.durationMs,
      })
      options.onVerdict?.({
        product: options.product,
        healthy: verdict.healthy,
        kinds: verdict.reasons.map((r) => r.kind),
        durationMs: info.durationMs,
      })
      if (verdict.healthy || verdict.severity === null) return
      await sink.deliver(
        turnAlert({
          product: options.product,
          severity: verdict.severity,
          reasons: verdict.reasons,
          ...(info.threadId ? { threadId: info.threadId } : {}),
          ...(info.executionId ? { turnId: info.executionId } : {}),
        }),
      )
    },

    async onTurnError(info) {
      const verdict = classifyTurnOutcome({
        failed: true,
        failureReason: errorText(info.error),
        durationMs: info.durationMs,
      })
      options.onVerdict?.({
        product: options.product,
        healthy: false,
        kinds: verdict.reasons.map((r) => r.kind),
        durationMs: info.durationMs,
      })
      await sink.deliver(
        turnAlert({
          product: options.product,
          severity: 'critical',
          reasons: verdict.reasons,
          ...(info.threadId ? { threadId: info.threadId } : {}),
          ...(info.executionId ? { turnId: info.executionId } : {}),
        }),
      )
    },
  }
}
