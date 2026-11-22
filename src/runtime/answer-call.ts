import type { LoopEvent, LoopMessage } from './loop'
import type { TurnTrace } from '../turn-trace/recorder'

type StreamTurn = (messages: LoopMessage[]) => AsyncIterable<LoopEvent>

/**
 * The answer call: it writes the answer, and its tool calls never run. A model that ignores `tool_choice: "none"` sends
 * them anyway (Z.AI documents `tool_choice` as `auto` only; on 2026-11-22 a GLM seat answered two answer calls with
 * `sandbox_run`, both ran, and the turn reached its budget with no answer). They are dropped, and a call that wrote no
 * word is sent once more with no tools listed, so the model can only write. The call ends at the hop's budget
 * (`endsAt`), keeping what it wrote: with no tools a GLM call once wrote "Reading…" for 12 minutes (317,197
 * characters), and nothing ended it. A `turn.answer_call` span says which happened.
 */
export function answerOnlyCall(
  call: (body: Record<string, unknown>, stop: AbortSignal, listTools: boolean) => StreamTurn,
  hop: { endsAt: number; signal: AbortSignal | undefined; trace: TurnTrace | undefined },
): StreamTurn {
  const note = (how: 'budget' | 'tools_dropped' | 'bare_tools_dropped', dropped: number) => {
    const now = Date.now()
    hop.trace?.record('turn.answer_call', 'other', now, now, { 'tangle.turn.answer_call': how, 'tangle.turn.answer_call_dropped': dropped })
  }
  return async function* (messages) {
    for (const listTools of [true, false]) {
      const budget = new AbortController()
      const timer = setTimeout(() => budget.abort(new DOMException('The hop reached its budgetMs.', 'AbortError')),
        Math.min(Math.max(0, hop.endsAt - Date.now()), 2 ** 31 - 1))
      let wrote = false
      let dropped = 0
      try {
        const body = listTools ? { tool_choice: 'none' } : { tool_choice: undefined, parallel_tool_calls: undefined }
        for await (const event of call(body, budget.signal, listTools)(messages)) {
          if (event.type === 'tool_call') { dropped++; continue }
          wrote ||= event.type === 'text' && Boolean(event.text)
          yield event
        }
      } catch (error) {
        // The budget ended the call: what it wrote is the answer. Any other failure is the call's own.
        if (!budget.signal.aborted || hop.signal?.aborted) throw error
      } finally {
        clearTimeout(timer)
      }
      if (budget.signal.aborted) { note('budget', dropped); return }
      if (dropped) note(listTools ? 'tools_dropped' : 'bare_tools_dropped', dropped)
      if (wrote || !listTools) return
    }
  }
}
