/**
 * Pure intake MODEL — the question-graph and the answer/completion algebra a
 * one-question-at-a-time interview runs on. Zero dependencies: no drizzle, no
 * env, no react, no I/O. The DB layer (`./intakes/drizzle`), the handlers
 * (`./intakes/api`) and the React surface (`./intakes-react`) all build on
 * these functions; this leaf imports nothing back, so a consumer can pull just
 * the intake math.
 *
 * An intake is an ordered list of questions, optionally branching: a question
 * can declare `next` as a function of the answers so far, so the next prompt
 * depends on what was said (e.g. "do you have a website?" → no → skip the URL
 * question). Traversal is pure and deterministic — `nextQuestion(graph, answers)`
 * folds the answers into the single question to ask next (or null = done), and
 * `isComplete` is true exactly when every REQUIRED reachable question has a
 * valid answer.
 *
 * Answers are a flat `Record<questionId, value>`. Each question declares an
 * answer `type` that `validateAnswer` checks against — the same validation the
 * UI runs before advancing and the store runs before persisting, so an invalid
 * answer can never enter the payload.
 */

/** The kinds of answer a question accepts. */
export type IntakeAnswerType =
  | 'text'
  | 'long-text'
  | 'single-select'
  | 'multi-select'
  | 'boolean'
  | 'number'
  | 'url'
  | 'email'

/** A selectable option for single/multi-select questions. */
export interface IntakeOption {
  value: string
  label: string
}

/** A flat map of answers keyed by question id. */
export type IntakeAnswers = Record<string, IntakeAnswerValue>

/** Any value an answer can hold; the type is validated per-question. */
export type IntakeAnswerValue = string | string[] | number | boolean | null

/**
 * One question in the graph. `next` (optional) makes the graph branch: given
 * the answers so far it returns the id of the question to ask next, or null to
 * end the interview early. With no `next`, traversal falls through to the next
 * question in declaration order.
 */
export interface IntakeQuestion {
  id: string
  /** The prompt the interviewer asks. */
  prompt: string
  type: IntakeAnswerType
  /** Required questions gate completion; optional ones may be skipped. */
  required?: boolean
  /** Help text shown under the prompt. */
  help?: string
  /** Options for single/multi-select questions. */
  options?: IntakeOption[]
  /** Min length (text) or min value (number); inclusive. */
  min?: number
  /** Max length (text) or max value (number); inclusive. */
  max?: number
  /**
   * Branch override: given the answers so far, the id of the next question
   * (or null to end early). Omit for linear flow (next in declaration order).
   */
  next?(answers: IntakeAnswers): string | null
}

/** The intake definition: an ordered, addressable set of questions. */
export interface IntakeGraph {
  /** Stable id for the intake definition (e.g. 'user-onboarding-v1'). */
  id: string
  /** Human title shown at the top of the interview. */
  title: string
  /** Optional one-line description. */
  description?: string
  /** Questions in declaration (default traversal) order. */
  questions: IntakeQuestion[]
}

/** The reason an answer failed validation. */
export type AnswerRejectionReason =
  | 'required'
  | 'wrong-type'
  | 'too-short'
  | 'too-long'
  | 'too-small'
  | 'too-large'
  | 'not-an-option'
  | 'invalid-url'
  | 'invalid-email'
  | 'unknown-question'

export interface AnswerValidationResult {
  ok: boolean
  reason?: AnswerRejectionReason
}

const URL_PATTERN = /^https?:\/\/[^\s/$.?#].[^\s]*$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Look up a question by id, or null if the graph has none. */
export function getQuestion(graph: IntakeGraph, questionId: string): IntakeQuestion | null {
  return graph.questions.find((q) => q.id === questionId) ?? null
}

/** True when an answer value is present (not null/undefined/empty). */
export function hasAnswer(value: IntakeAnswerValue | undefined): boolean {
  if (value == null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

/**
 * Validate one answer against its question. Pure: no I/O, no graph mutation.
 * An empty value is rejected as `required` only when the question is required;
 * an empty value for an optional question is OK (the user skipped it).
 */
export function validateAnswer(
  question: IntakeQuestion,
  value: IntakeAnswerValue | undefined,
): AnswerValidationResult {
  if (!hasAnswer(value)) {
    return question.required ? { ok: false, reason: 'required' } : { ok: true }
  }

  switch (question.type) {
    case 'text':
    case 'long-text': {
      if (typeof value !== 'string') return { ok: false, reason: 'wrong-type' }
      const len = value.trim().length
      if (question.min != null && len < question.min) return { ok: false, reason: 'too-short' }
      if (question.max != null && len > question.max) return { ok: false, reason: 'too-long' }
      return { ok: true }
    }
    case 'url': {
      if (typeof value !== 'string') return { ok: false, reason: 'wrong-type' }
      return URL_PATTERN.test(value.trim()) ? { ok: true } : { ok: false, reason: 'invalid-url' }
    }
    case 'email': {
      if (typeof value !== 'string') return { ok: false, reason: 'wrong-type' }
      return EMAIL_PATTERN.test(value.trim()) ? { ok: true } : { ok: false, reason: 'invalid-email' }
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'wrong-type' }
      if (question.min != null && value < question.min) return { ok: false, reason: 'too-small' }
      if (question.max != null && value > question.max) return { ok: false, reason: 'too-large' }
      return { ok: true }
    }
    case 'boolean': {
      return typeof value === 'boolean' ? { ok: true } : { ok: false, reason: 'wrong-type' }
    }
    case 'single-select': {
      if (typeof value !== 'string') return { ok: false, reason: 'wrong-type' }
      return optionExists(question, value) ? { ok: true } : { ok: false, reason: 'not-an-option' }
    }
    case 'multi-select': {
      if (!Array.isArray(value)) return { ok: false, reason: 'wrong-type' }
      if (!value.every((v) => typeof v === 'string' && optionExists(question, v))) {
        return { ok: false, reason: 'not-an-option' }
      }
      if (question.min != null && value.length < question.min) return { ok: false, reason: 'too-short' }
      if (question.max != null && value.length > question.max) return { ok: false, reason: 'too-long' }
      return { ok: true }
    }
    default:
      return { ok: false, reason: 'wrong-type' }
  }
}

/**
 * The single question to ask next given the answers so far, or null when the
 * interview is done. Walks the graph from the first question, following each
 * question's `next` branch (or declaration order) and stopping at the first
 * reachable question that has no valid answer yet. Deterministic and pure.
 *
 * A `next` that points at a missing id, or returns null, ends the walk — so a
 * malformed graph terminates rather than looping. A visited-set guards against
 * a cyclic `next`.
 */
export function nextQuestion(graph: IntakeGraph, answers: IntakeAnswers): IntakeQuestion | null {
  if (graph.questions.length === 0) return null
  const visited = new Set<string>()
  let current: IntakeQuestion | null = graph.questions[0] ?? null

  while (current) {
    if (visited.has(current.id)) return null
    visited.add(current.id)

    const answer = answers[current.id]
    const validity = validateAnswer(current, answer)
    if (!validity.ok || (current.required && !hasAnswer(answer))) {
      return current
    }

    current = advance(graph, current, answers)
  }

  return null
}

/**
 * True when every REQUIRED question reachable under the current answers has a
 * valid answer. Pure: it replays the same traversal `nextQuestion` uses and is
 * complete exactly when that traversal has no question left to ask.
 */
export function isComplete(graph: IntakeGraph, answers: IntakeAnswers): boolean {
  return nextQuestion(graph, answers) === null
}

/**
 * Progress as answered-vs-total over the REACHABLE required questions under the
 * current answers — what a progress bar renders. Optional questions don't count
 * toward the denominator (they never block completion).
 */
export function intakeProgress(graph: IntakeGraph, answers: IntakeAnswers): { answered: number; total: number } {
  const reachable = reachableQuestions(graph, answers)
  const required = reachable.filter((q) => q.required)
  const answered = required.filter((q) => validateAnswer(q, answers[q.id]).ok && hasAnswer(answers[q.id])).length
  return { answered, total: required.length }
}

/** The questions reachable under the current answers, in traversal order. */
export function reachableQuestions(graph: IntakeGraph, answers: IntakeAnswers): IntakeQuestion[] {
  if (graph.questions.length === 0) return []
  const visited = new Set<string>()
  const out: IntakeQuestion[] = []
  let current: IntakeQuestion | null = graph.questions[0] ?? null

  while (current) {
    if (visited.has(current.id)) break
    visited.add(current.id)
    out.push(current)
    current = advance(graph, current, answers)
  }
  return out
}

function advance(graph: IntakeGraph, current: IntakeQuestion, answers: IntakeAnswers): IntakeQuestion | null {
  if (current.next) {
    const nextId = current.next(answers)
    return nextId == null ? null : getQuestion(graph, nextId)
  }
  const index = graph.questions.indexOf(current)
  return graph.questions[index + 1] ?? null
}

function optionExists(question: IntakeQuestion, value: string): boolean {
  return (question.options ?? []).some((option) => option.value === value)
}
