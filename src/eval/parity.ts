/**
 * Parity eval: the same asks through two or more lanes of one app (for example
 * the Router turn and the sandbox turn), graded the same way, so a lane change
 * is judged by numbers rather than by feel.
 *
 * An ask is covered (the app's own knowledge holds the answer) or uncovered
 * (it does not). A covered answer is correct when it states the expected
 * value; it fabricates when it states the common default instead. An uncovered
 * answer is correct when it says the fact is not available; asserting a value
 * or an absence ("there is no gym") is a fabrication.
 *
 * Use answers that differ from industry defaults (checkout 12 pm, not 11), so
 * a model guessing from priors fails visibly.
 */

export interface ParityAsk {
  id: string
  prompt: string
  /** Covered asks: the value the reply must state. Omit for an uncovered ask. */
  expect?: RegExp
  /** Covered asks: the common default that, stated instead, is a fabrication. */
  fabricated?: RegExp
}

/** One lane's answer to one ask. `failed` is a turn that did not settle with a reply. */
export interface LaneAnswer {
  text: string
  failed?: boolean
  /** Send to first visible words, when the lane measures it. */
  firstWordsMs?: number
}

export type ParityLane = (prompt: string, ask: ParityAsk) => Promise<LaneAnswer>

export interface AskVerdict {
  correct: boolean
  fabricated: boolean
}

export interface ParityReport {
  lanes: Record<string, {
    asks: number
    correct: number
    fabricated: number
    failed: number
    firstWordsMs: { p50: number | null; p90: number | null }
  }>
  asks: Array<{ id: string; prompt: string; verdicts: Record<string, AskVerdict & { text: string }>; agree: boolean }>
}

/** Says the fact is not available, or offers to find out. */
const UNAVAILABLE = /(don'?t|do not|doesn'?t|does not) (have|see|find) (any )?(information|details|that|it listed|a listing|anything)|(don'?t|do not|couldn'?t|could not|can'?t|cannot|didn'?t|did not) (see|find)|not (sure|listed|mentioned|in (my|our|the) )|no information|isn'?t (listed|mentioned)|(can|could|I'?ll|let me|want me to) (ask|check with)/i
/** States a price, a time, a flat yes/no, or an absence. */
const ASSERTS = /\$\s?\d|\b\d{1,2}(:\d\d)?\s*(am|pm)\b|^\s*(yes|no)\b|\b(we|there) (do not|don'?t|does not|doesn'?t) have\b|\bthere (is|are) no\b/im

export function gradeAnswer(text: string, ask: ParityAsk): AskVerdict {
  if (ask.expect) {
    const stated = ask.expect.test(text)
    return { correct: stated, fabricated: !stated && Boolean(ask.fabricated?.test(text)) }
  }
  const asserts = ASSERTS.test(text)
  return { correct: UNAVAILABLE.test(text) && !asserts, fabricated: asserts }
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!
}

/**
 * Ask every lane every question, one ask at a time per lane (lanes run in
 * parallel), and grade each answer the same way. `style` is appended to every
 * other ask, so the score holds with and without a reply-style instruction.
 */
export async function runParityEval(options: {
  asks: readonly ParityAsk[]
  lanes: Record<string, ParityLane>
  style?: string
}): Promise<ParityReport> {
  const names = Object.keys(options.lanes)
  const prompts = options.asks.map((ask, index) => options.style && index % 2 ? `${ask.prompt} ${options.style}` : ask.prompt)
  const answers = await Promise.all(names.map(async name => {
    const out: LaneAnswer[] = []
    for (const [index, ask] of options.asks.entries()) {
      try { out.push(await options.lanes[name]!(prompts[index]!, ask)) }
      catch (error) { out.push({ text: error instanceof Error ? error.message : String(error), failed: true }) }
    }
    return out
  }))
  const asks = options.asks.map((ask, index) => {
    const verdicts = Object.fromEntries(names.map((name, lane) => {
      const answer = answers[lane]![index]!
      const verdict = answer.failed ? { correct: false, fabricated: false } : gradeAnswer(answer.text, ask)
      return [name, { ...verdict, text: answer.text }]
    }))
    const outcomes = Object.values(verdicts).map(verdict => verdict.correct)
    return { id: ask.id, prompt: prompts[index]!, verdicts, agree: outcomes.every(value => value === outcomes[0]) }
  })
  const lanes = Object.fromEntries(names.map((name, lane) => {
    const laneAnswers = answers[lane]!
    const firstWords = laneAnswers.flatMap(answer => answer.firstWordsMs === undefined ? [] : [answer.firstWordsMs])
    return [name, {
      asks: asks.length,
      correct: asks.filter(ask => ask.verdicts[name]!.correct).length,
      fabricated: asks.filter(ask => ask.verdicts[name]!.fabricated).length,
      failed: laneAnswers.filter(answer => answer.failed).length,
      firstWordsMs: { p50: quantile(firstWords, 0.5), p90: quantile(firstWords, 0.9) },
    }]
  }))
  return { lanes, asks }
}

/** The release bar: every lane at or above `minCorrect` of its asks, with no fabrication and no failed turn. */
export function parityGate(report: ParityReport, bar: { minCorrectRatio: number; maxFabricated?: number; maxFailed?: number }) {
  const reasons = Object.entries(report.lanes).flatMap(([name, lane]) => [
    ...(lane.correct < Math.ceil(lane.asks * bar.minCorrectRatio) ? [`${name}: ${lane.correct}/${lane.asks} correct, below ${Math.ceil(lane.asks * bar.minCorrectRatio)}`] : []),
    ...(lane.fabricated > (bar.maxFabricated ?? 0) ? [`${name}: ${lane.fabricated} fabricated`] : []),
    ...(lane.failed > (bar.maxFailed ?? 0) ? [`${name}: ${lane.failed} failed turns`] : []),
  ])
  return { pass: reasons.length === 0, reasons }
}
