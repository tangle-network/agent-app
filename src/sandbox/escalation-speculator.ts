/**
 * `createEscalationSpeculator`: start a turn's sandbox box when the turn is
 * likely to escalate to it, so `sandbox_run` finds the box running instead of
 * paying the resume (p50 6.4 s on escalated turns, agent turn architecture S8).
 *
 * TWO SIGNALS, CHEAPEST FIRST. Deterministic rules on the turn's input fire
 * before the model is called: an attachment a process must read (PDF, sheet,
 * archive, code), a fenced code block, or words that ask for execution. Then,
 * while the reply streams, the start of a call to an escalation tool fires as
 * soon as the model names it, seconds before its arguments finish. Either one
 * calls `warm` once per turn.
 *
 * ALWAYS ON. There is no mode: a turn that can reach the box speculates. The
 * hybrid producer (`createHybridTurnProducer` in `/chat-routes`) passes its own
 * single-flight box start as `warm`, so a speculative start and the tool's own
 * start are one start.
 *
 * NEVER GATES. `warm` is fire-and-forget. A speculation that is wrong costs a
 * box that idles out; it never delays or fails the turn.
 */

/** Why a turn was judged likely to escalate. */
export type EscalationHint = 'attachment' | 'code-block' | 'execution-words' | 'tool-call-start'

export interface EscalationInput {
  text?: string
  attachments?: ReadonlyArray<{ mediaType?: string; name?: string }>
}

/** The tools that run in the box. The start of a call to one of these warms it. */
export const DEFAULT_ESCALATION_TOOLS = ['sandbox_run', 'sandbox_exec'] as const

const PROCESS_MEDIA = /^(application\/(pdf|zip|x-zip|gzip|x-tar|vnd\.openxmlformats|vnd\.ms-excel|vnd\.oasis)|text\/(csv|x-python|x-script))/i
const PROCESS_EXTENSIONS = /\.(pdf|xlsx?|csv|tsv|ods|zip|tar|gz|py|ipynb|js|ts|sh|sql|parquet|json)$/i
const EXECUTION_WORDS =
  /\b(run|execute|compile|convert|parse|extract|install|script|python|notebook|spreadsheet|csv|xlsx|regex|calculate|plot|chart|test suite|build the)\b/i

/** Pure: the reasons this input suggests the turn will need the box, if any. */
export function escalationHints(input: EscalationInput): EscalationHint[] {
  const hints: EscalationHint[] = []
  if ((input.attachments ?? []).some((a) => PROCESS_MEDIA.test(a.mediaType ?? '') || PROCESS_EXTENSIONS.test(a.name ?? ''))) {
    hints.push('attachment')
  }
  const text = input.text ?? ''
  if (/```/.test(text)) hints.push('code-block')
  if (EXECUTION_WORDS.test(text)) hints.push('execution-words')
  return hints
}

export interface EscalationSpeculatorOptions {
  /** Start the box. Called at most once per turn; a rejection is swallowed. */
  warm(): Promise<unknown> | void
  escalationTools?: readonly string[]
  /** Observability: called once, when the turn's warm starts. */
  onSpeculate?(hint: EscalationHint): void
}

export interface EscalationSpeculator {
  /** Call with the turn's input before the model call. */
  onInput(input: EscalationInput): void
  /** Call with each engine event. Only the start of a call to an escalation tool
   *  (`tool_start`, or the loop's `tool_call_start`) is read. */
  onEvent(event: { type: string; toolName?: string }): void
  /** The hint that fired for this turn, if any. */
  readonly fired: EscalationHint | null
}

/** One speculator per turn. */
export function createEscalationSpeculator(options: EscalationSpeculatorOptions): EscalationSpeculator {
  const tools = new Set<string>(options.escalationTools ?? DEFAULT_ESCALATION_TOOLS)
  let fired: EscalationHint | null = null

  const speculate = (hint: EscalationHint): void => {
    if (fired) return
    fired = hint
    try {
      options.onSpeculate?.(hint)
    } catch {
      // Observability must not change the turn.
    }
    // Fire and forget: a warm never gates or fails the turn.
    try {
      void Promise.resolve(options.warm()).catch(() => undefined)
    } catch {
      // A warm that throws synchronously is a warm that did not start.
    }
  }

  return {
    onInput(input) {
      const hint = escalationHints(input)[0]
      if (hint) speculate(hint)
    },
    onEvent(event) {
      if ((event.type === 'tool_start' || event.type === 'tool_call_start') && event.toolName && tools.has(event.toolName)) {
        speculate('tool-call-start')
      }
    },
    get fired() {
      return fired
    },
  }
}
