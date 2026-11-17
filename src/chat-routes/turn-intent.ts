/** Optional intent preview for an already admitted turn; never owns execution. */
import type { AdmittedTurn } from './turn-admission'
import type { ResolvedChatTurnRoutesOptions } from './route-storage'
import { INTENT_LINE_TIMEOUT_MS, INTENT_LINE_HISTORY_MESSAGES, INTENT_LINE_MAX_CHARS } from './turn-route-contracts'

/** Start the admitted turn's intent line; resolves to the line, or null. Never rejects. */
export function startTurnIntentLine<TContext, TResource>(
  options: ResolvedChatTurnRoutesOptions<TContext, TResource>,
  log: (message: string, meta?: Record<string, unknown>) => void,
  admitted: AdmittedTurn<TContext>,
  stop?: AbortSignal,
): Promise<string | null> | undefined {
  const intentLine = options.intentLine
  if (!intentLine) return undefined
  const { parsed, auth } = admitted
  const threadId = parsed.payload.threadId
  const controller = new AbortController()
  const signal = stop ? AbortSignal.any([controller.signal, stop]) : controller.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, intentLine.timeoutMs ?? INTENT_LINE_TIMEOUT_MS)
  })
  const generated = (async () => {
    signal.throwIfAborted()
    const history = (await options.store.listMessages(threadId))
      .slice(-INTENT_LINE_HISTORY_MESSAGES)
      .map((message) => ({ role: message.role, content: message.content }))
    signal.throwIfAborted()
    const text = await intentLine.generate({
      content: parsed.content,
      history,
      tenantId: auth.tenantId,
      userId: auth.userId,
      threadId,
      context: auth.context,
      signal,
    })
    const line = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : ''
    return line ? line.slice(0, INTENT_LINE_MAX_CHARS) : null
  })().catch((err) => {
    if (!signal.aborted) {
      log('[chat-routes] intent line failed; showing none', { error: err instanceof Error ? err.message : String(err) })
    }
    return null
  })
  return Promise.race([generated, deadline]).finally(() => clearTimeout(timer))
}
