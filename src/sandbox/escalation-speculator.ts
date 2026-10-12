/**
 * `createEscalationSpeculator`: warm a turn's sandbox box when the turn is
 * likely to escalate to it, so `sandbox_run` finds the box running instead of
 * paying the resume (p50 6.4 s on escalated turns, agent turn architecture S8).
 *
 * TWO SIGNALS, CHEAPEST FIRST. Deterministic rules on the turn's input fire
 * before the model is called: an attachment a process must read (PDF, sheet,
 * archive, code), a fenced code block, or words that ask for execution. Then,
 * while the reply streams, `tool_call_start` for an escalation tool fires as
 * soon as the model names it, seconds before its arguments finish. Either one
 * signals the box's warm lease with reason `escalation-likely`, at most once
 * per turn.
 *
 * NEVER GATES. Signals are fire-and-forget: the lease dedupes across isolates,
 * charges unused warms to the key's daily budget (`escalation-likely` is a
 * budgeted reason), and backs off on capacity. A speculation that is wrong
 * costs box time within that budget; it never delays or fails the turn.
 *
 * MEASURING IT. The `sandbox_run` binding calls `leases.turn(boxKey)` when the
 * tool runs. A `warm_hit` with reason `escalation-likely` is a box the
 * speculation made ready in time. The S8 number is that count over all
 * escalated turns.
 *
 * Off unless the app passes `mode: 'deterministic'` (from `SANDBOX_PREWARM_HINT`).
 */

/** `SANDBOX_PREWARM_HINT`: `off` (default) or `deterministic`. */
export type PrewarmHintMode = 'off' | 'deterministic'

export function parsePrewarmHint(value: string | undefined | null): PrewarmHintMode {
  return value?.trim().toLowerCase() === 'deterministic' ? 'deterministic' : 'off'
}

/** Why a turn was judged likely to escalate. */
export type EscalationHint = 'attachment' | 'code-block' | 'execution-words' | 'tool-call-start'

export interface EscalationInput {
  text?: string
  attachments?: ReadonlyArray<{ mediaType?: string; name?: string }>
}

/** The tools that run in the box. A `tool_call_start` for one of these warms it. */
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
  mode: PrewarmHintMode
  /** The box's warm lease; only `signal` is used. */
  leases: { signal(key: string, reason: 'escalation-likely'): Promise<unknown> }
  /** The warm-lease key of the box `sandbox_run` would use for this turn. */
  boxKey: string
  escalationTools?: readonly string[]
  /** Observability: called once, when the turn's warm is signalled. */
  onSpeculate?(hint: EscalationHint): void
}

export interface EscalationSpeculator {
  /** Call with the turn's input before the model call. */
  onInput(input: EscalationInput): void
  /** Call with each event the model stream yields. Non-tool events are ignored. */
  onEvent(event: { type: string; toolName?: string }): void
  /** The hint that fired for this turn, if any. */
  readonly fired: EscalationHint | null
}

/** One speculator per turn. */
export function createEscalationSpeculator(options: EscalationSpeculatorOptions): EscalationSpeculator {
  const tools = new Set<string>(options.escalationTools ?? DEFAULT_ESCALATION_TOOLS)
  let fired: EscalationHint | null = null

  const speculate = (hint: EscalationHint): void => {
    if (options.mode === 'off' || fired) return
    fired = hint
    try {
      options.onSpeculate?.(hint)
    } catch {
      // Observability must not change the turn.
    }
    // Fire and forget: a warm never gates or fails the turn.
    void options.leases.signal(options.boxKey, 'escalation-likely').catch(() => undefined)
  }

  return {
    onInput(input) {
      const hint = escalationHints(input)[0]
      if (hint) speculate(hint)
    },
    onEvent(event) {
      if (event.type === 'tool_call_start' && event.toolName && tools.has(event.toolName)) speculate('tool-call-start')
    },
    get fired() {
      return fired
    },
  }
}
