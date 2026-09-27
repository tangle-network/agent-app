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
export type IntakeAnswerType = 'text' | 'long-text' | 'single-select' | 'multi-select' | 'boolean' | 'number' | 'url' | 'email';
/** A selectable option for single/multi-select questions. */
export interface IntakeOption {
    value: string;
    label: string;
}
/** A flat map of answers keyed by question id. */
export type IntakeAnswers = Record<string, IntakeAnswerValue>;
/** Any value an answer can hold; the type is validated per-question. */
export type IntakeAnswerValue = string | string[] | number | boolean | null;
/**
 * One question in the graph. `next` (optional) makes the graph branch: given
 * the answers so far it returns the id of the question to ask next, or null to
 * end the interview early. With no `next`, traversal falls through to the next
 * question in declaration order.
 */
export interface IntakeQuestion {
    id: string;
    /** The prompt the interviewer asks. */
    prompt: string;
    type: IntakeAnswerType;
    /** Required questions gate completion; optional ones may be skipped. */
    required?: boolean;
    /** Help text shown under the prompt. */
    help?: string;
    /** Options for single/multi-select questions. */
    options?: IntakeOption[];
    /** Min length (text) or min value (number); inclusive. */
    min?: number;
    /** Max length (text) or max value (number); inclusive. */
    max?: number;
    /**
     * Branch override: given the answers so far, the id of the next question
     * (or null to end early). Omit for linear flow (next in declaration order).
     */
    next?(answers: IntakeAnswers): string | null;
}
/** The intake definition: an ordered, addressable set of questions. */
export interface IntakeGraph {
    /** Stable id for the intake definition (e.g. 'user-onboarding-v1'). */
    id: string;
    /** Human title shown at the top of the interview. */
    title: string;
    /** Optional one-line description. */
    description?: string;
    /** Questions in declaration (default traversal) order. */
    questions: IntakeQuestion[];
}
/** The reason an answer failed validation. */
export type AnswerRejectionReason = 'required' | 'wrong-type' | 'too-short' | 'too-long' | 'too-small' | 'too-large' | 'not-an-option' | 'invalid-url' | 'invalid-email' | 'unknown-question';
/** Describe validation outcome of an answer including success status and optional rejection reason */
export interface AnswerValidationResult {
    ok: boolean;
    reason?: AnswerRejectionReason;
}
/** Look up a question by id, or null if the graph has none. */
export declare function getQuestion(graph: IntakeGraph, questionId: string): IntakeQuestion | null;
/** True when an answer value is present (not null/undefined/empty). */
export declare function hasAnswer(value: IntakeAnswerValue | undefined): boolean;
/**
 * Validate one answer against its question. Pure: no I/O, no graph mutation.
 * An empty value is rejected as `required` only when the question is required;
 * an empty value for an optional question is OK (the user skipped it).
 */
export declare function validateAnswer(question: IntakeQuestion, value: IntakeAnswerValue | undefined): AnswerValidationResult;
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
export declare function nextQuestion(graph: IntakeGraph, answers: IntakeAnswers): IntakeQuestion | null;
/**
 * True when every REQUIRED question reachable under the current answers has a
 * valid answer. Pure: it replays the same traversal `nextQuestion` uses and is
 * complete exactly when that traversal has no question left to ask.
 */
export declare function isComplete(graph: IntakeGraph, answers: IntakeAnswers): boolean;
/**
 * Progress as answered-vs-total over the REACHABLE required questions under the
 * current answers — what a progress bar renders. Optional questions don't count
 * toward the denominator (they never block completion).
 */
export declare function intakeProgress(graph: IntakeGraph, answers: IntakeAnswers): {
    answered: number;
    total: number;
};
/** The questions reachable under the current answers, in traversal order. */
export declare function reachableQuestions(graph: IntakeGraph, answers: IntakeAnswers): IntakeQuestion[];
