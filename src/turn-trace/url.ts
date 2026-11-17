/**
 * Where a turn's owner reads its trace. The server names it on the turn receipt (`traceUrl`); a client builds the same
 * URL for a turn in its history from the path it posts turns to and the turn's execution id, which an assistant row's
 * id carries. Browser-safe: no fetch, no environment.
 */

/** `routes.trace` for one turn: the turn's path plus `/turns/<execution id>/trace`. */
export function turnTraceUrl(turnPath: string, executionId: string): string {
  return `${turnPath.replace(/\/+$/, '')}/turns/${encodeURIComponent(executionId)}/trace`
}

const ASSISTANT_ROW_PREFIX = 'assistant:'

/** The deterministic assistant-row id for a turn: readable on purpose (an operator grepping a transcript row id finds the
 *  run), and stable across re-entries because every input already is. */
export function assistantRowIdForTurn(turnKey: string): string {
  return `${ASSISTANT_ROW_PREFIX}${turnKey}`
}

/** The execution id an assistant row written by the chat route is keyed by, or null for a row it did not key. */
export function executionIdOfAssistantRow(messageId: string): string | null {
  return messageId.startsWith(ASSISTANT_ROW_PREFIX) && messageId.length > ASSISTANT_ROW_PREFIX.length
    ? messageId.slice(ASSISTANT_ROW_PREFIX.length)
    : null
}
