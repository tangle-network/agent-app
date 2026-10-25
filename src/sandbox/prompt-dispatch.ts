import type { SandboxSpendHooks, SandboxRuntimeConfig } from './configuration'
import type { SandboxInstance } from '@tangle-network/sandbox'
import {
  classifySandboxTransientFailure,
  sandboxTransientBackoffMs,
  SandboxTransientDeadlineError,
} from './transient-failure'
import {
  type PromptInputPart,
  resolveSandboxPromptBackend,
  flattenHistory,
  mergeHistoryIntoParts,
} from './prompt-profile'
import type { StreamSandboxPromptOptions } from './prompt-options'
import {
  detachedSandboxPromptEvents,
  type StreamPromptOptions,
  classifySeveredStream,
  isTerminalPromptEvent,
  detectInteractiveQuestion,
} from './prompt-events'
import { traceSandboxPromptEvents } from './prompt-trace'
import { dropTrustedBox } from './runtime-cache'
import { SandboxRunError } from './sandbox-run-error'
import { SandboxModelResolutionError } from './model'

/** Fire an activity tap without letting it affect the turn it reports on. */
export function emitSandboxActivity(spend: SandboxSpendHooks | undefined, box: SandboxInstance): void {
  if (!spend?.onActivity) return
  try {
    spend.onActivity({ sandboxId: box.id, at: Date.now() })
  } catch {
    // An observability seam must never take down the turn it reports on.
  }
}

/**
 * How long a refused dispatch is resent. Shorter than the completion
 * Workflow's 10-minute wait for a dispatch to appear, so the request gives up
 * before that Workflow reports the dispatch missing.
 */
export const SANDBOX_DISPATCH_TRANSIENT_DEADLINE_MS = 8 * 60_000

/**
 * Resend the same execution while the box refuses it with a transient
 * failure and nothing has been delivered yet. The execution id makes a resend
 * idempotent; after the first event a failure is the run's own.
 */
async function* resendRefusedDispatch(
  dispatch: () => AsyncIterable<unknown>,
  signal: AbortSignal | undefined,
): AsyncGenerator<unknown> {
  let delivered = false
  let firstSeenAt: number | undefined
  for (let attempts = 1; ; attempts += 1) {
    try {
      signal?.throwIfAborted()
      for await (const event of dispatch()) {
        delivered = true
        yield event
      }
      return
    } catch (error) {
      const failure = delivered ? null : classifySandboxTransientFailure(error)
      if (!failure || failure.code === 'sandbox.control_plane_transient') throw error
      const at = Date.now()
      firstSeenAt ??= at
      const delayMs = sandboxTransientBackoffMs(attempts)
      if (at + delayMs - firstSeenAt > SANDBOX_DISPATCH_TRANSIENT_DEADLINE_MS) {
        throw new SandboxTransientDeadlineError(failure, firstSeenAt, attempts, error)
      }
      console.warn('[sandbox] resending a dispatch the box refused', { code: failure.code, attempt: attempts, delayMs })
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        const timer = setTimeout(resolve, delayMs)
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
      })
    }
  }
}

/** Resolve and stream AI-generated responses from a sandboxed environment based on input messages and options */
export async function* streamSandboxPrompt(
  shell: SandboxRuntimeConfig,
  box: SandboxInstance,
  message: string | PromptInputPart[],
  options?: StreamSandboxPromptOptions,
): AsyncGenerator<unknown> {
  let backend: Awaited<ReturnType<typeof resolveSandboxPromptBackend>>
  try {
    options?.signal?.throwIfAborted()
    backend = await resolveSandboxPromptBackend(shell, options ?? {}, 'streamSandboxPrompt')
    options?.signal?.throwIfAborted()
  } catch (error) {
    // A known local refusal before dispatch differs from losing observation of
    // an admitted execution. Callers can release admission for this outcome.
    if (error instanceof SandboxModelResolutionError) throw error
    throw new SandboxRunError('sandbox_unavailable', error instanceof Error ? error.message : 'The sandbox prompt was not dispatched because its configuration or admission was refused.', { cause: error })
  }
  const prompt =
    typeof message === 'string'
      ? flattenHistory(message, options?.history)
      : mergeHistoryIntoParts(message, options?.history)

  const dispatch = () => options?.detach
    ? detachedSandboxPromptEvents(box, prompt, options, backend)
    : box.streamPrompt(prompt, {
        sessionId: options?.sessionId,
        executionId: options?.executionId,
        turnId: options?.turnId,
        lastEventId: options?.lastEventId,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
        ...(options?.requireVisibleAssistantOutput !== undefined
          ? { requireVisibleAssistantOutput: options.requireVisibleAssistantOutput }
          : {}),
        ...(options?.expectedPublicProfileRequestDigest
          ? { expectedPublicProfileRequestDigest: options.expectedPublicProfileRequestDigest }
          : {}),
        ...(options?.expectedSecretProfileReceipt
          ? { expectedSecretProfileReceipt: options.expectedSecretProfileReceipt }
          : {}),
        ...(options?.trace ? { traceId: options.trace.traceId } : {}),
        backend,
      } as StreamPromptOptions)
  const stream = options?.lastEventId ? dispatch() : resendRefusedDispatch(dispatch, options?.signal)

  emitSandboxActivity(options?.spend, box)
  let severedFinishReason: string | null = null
  const observed = options?.trace
    ? traceSandboxPromptEvents(stream, {
      trace: options.trace,
      ...(options.traceParent ? { parent: options.traceParent } : {}),
      meta: {
        'sandbox.id': box.id,
        ...(options.model ? { 'gen_ai.request.model': options.model } : {}),
        ...(options.harness ? { 'sandbox.harness': options.harness } : {}),
        ...(options.detach ? { 'sandbox.detached': true } : {}),
      },
    })
    : stream
  let delivered = false
  try {
    for await (const event of observed) {
      delivered = true
      const step = classifySeveredStream(event)
      if (step) severedFinishReason = step.kind === 'step-finish' && step.severed ? step.reason : null
      if (severedFinishReason && isTerminalPromptEvent(event)) {
        throw new Error(`sandbox model stream severed mid-turn (reason="${severedFinishReason}")`)
      }
      if (options?.disallowQuestions) {
        const q = detectInteractiveQuestion(event)
        if (q) {
          throw new Error(`sandbox agent asked an interactive question during an autonomous run: ${q}`)
        }
      }
      yield event
    }
  } catch (error) {
    // The first call on a box handed out without an exec probe is its probe:
    // the next ensure checks it in full.
    if (!delivered && !options?.signal?.aborted) dropTrustedBox(box)
    throw error
  } finally {
    // The box was working right up to here, however this turn ended — a throw,
    // an abandoned generator and a clean finish all bill the same.
    emitSandboxActivity(options?.spend, box)
  }
  // Reconnect-exhausted path: the stream ended on a severed step without a
  // terminal event. A truncated turn must fail loud, not return silently.
  if (severedFinishReason) {
    throw new Error(`sandbox model stream severed mid-turn (reason="${severedFinishReason}")`)
  }
}
