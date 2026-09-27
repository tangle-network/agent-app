/**
 * Framework-neutral intake API: the get-current / save-answer / complete logic,
 * lifted out of any one app's route file. Each app mounts these in its own
 * route with its own auth — the handlers take an already-resolved store (the
 * caller built it from `createUserIntakeStore` / `createProjectIntakeStore`
 * after running RBAC), the intake graph, and the parsed inputs. They return
 * web-standard `Response`s (available in Workers, Node 18+, Deno, browsers), so
 * "framework-neutral" is literal: no Remix/React-Router/Express import anywhere.
 *
 * The handlers own the graph→HTTP mapping the UI needs: `getCurrentIntake`
 * returns the loaded state PLUS the next question to ask (the question-graph
 * traversal from the `./intakes` leaf) and the progress counter, so the client
 * renders one question at a time without re-deriving the graph. Store
 * `IntakeError`s map to typed 4xx codes, never a generic 500 — an invalid
 * answer is a 400, an incomplete-complete is a 409, never a silent success.
 *
 * Imports `drizzle-orm` transitively (through the store types), so this is a
 * subpath, never re-exported from root.
 */
import { type IntakeAnswerValue, type IntakeGraph, type IntakeQuestion } from './model';
import { type IntakeStore } from './drizzle/store';
/** What the client renders: the saved state, the next prompt, and progress. */
export interface CurrentIntakeView {
    graphId: string;
    title: string;
    description?: string;
    answers: Record<string, IntakeAnswerValue>;
    /** The next question to ask, or null when the interview is done. */
    nextQuestion: IntakeQuestion | null;
    completed: boolean;
    completedAt: string | null;
    progress: {
        answered: number;
        total: number;
    };
}
/** Define configuration options for initializing the intake API with store and graph components */
export interface IntakeApiOptions {
    store: IntakeStore;
    graph: IntakeGraph;
}
/**
 * Build the intake API bound to one store + graph. Returns three handlers; an
 * app maps its route methods onto them (GET→getCurrentIntake, POST→saveAnswer,
 * a complete action→completeIntake).
 */
export declare function createIntakeApi(opts: IntakeApiOptions): {
    getCurrentIntake: () => Promise<Response>;
    saveAnswer: (input: {
        questionId?: string;
        value?: IntakeAnswerValue;
    }) => Promise<Response>;
    completeIntake: () => Promise<Response>;
};
