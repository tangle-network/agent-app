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

import {
  type IntakeAnswerValue,
  type IntakeGraph,
  type IntakeQuestion,
  intakeProgress,
  nextQuestion,
} from './model'
import { type IntakeStore, IntakeError } from './drizzle/store'

/** What the client renders: the saved state, the next prompt, and progress. */
export interface CurrentIntakeView {
  graphId: string
  title: string
  description?: string
  answers: Record<string, IntakeAnswerValue>
  /** The next question to ask, or null when the interview is done. */
  nextQuestion: IntakeQuestion | null
  completed: boolean
  completedAt: string | null
  progress: { answered: number; total: number }
}

/** Define configuration options for initializing the intake API with store and graph components */
export interface IntakeApiOptions {
  store: IntakeStore
  graph: IntakeGraph
}

/**
 * Build the intake API bound to one store + graph. Returns three handlers; an
 * app maps its route methods onto them (GET→getCurrentIntake, POST→saveAnswer,
 * a complete action→completeIntake).
 */
export function createIntakeApi(opts: IntakeApiOptions) {
  const { store, graph } = opts

  function view(state: Awaited<ReturnType<IntakeStore['get']>>): CurrentIntakeView {
    return {
      graphId: graph.id,
      title: graph.title,
      ...(graph.description ? { description: graph.description } : {}),
      answers: state.payload.answers,
      nextQuestion: nextQuestion(graph, state.payload.answers),
      completed: state.completed,
      completedAt: state.completedAt ? state.completedAt.toISOString() : null,
      progress: intakeProgress(graph, state.payload.answers),
    }
  }

  async function getCurrentIntake(): Promise<Response> {
    const state = await store.get()
    return Response.json(view(state))
  }

  async function saveAnswer(input: { questionId?: string; value?: IntakeAnswerValue }): Promise<Response> {
    if (!input.questionId) return Response.json({ error: 'Missing questionId' }, { status: 400 })
    try {
      const state = await store.save(input.questionId, input.value ?? null)
      return Response.json(view(state))
    } catch (err) {
      return intakeErrorResponse(err)
    }
  }

  async function completeIntake(): Promise<Response> {
    try {
      const state = await store.complete()
      return Response.json(view(state))
    } catch (err) {
      return intakeErrorResponse(err)
    }
  }

  return { getCurrentIntake, saveAnswer, completeIntake }
}

const ERROR_STATUS: Record<string, number> = {
  'invalid-answer': 400,
  'unknown-question': 404,
  incomplete: 409,
  'stale-graph': 409,
}

function intakeErrorResponse(err: unknown): Response {
  if (err instanceof IntakeError) {
    return Response.json({ error: err.message, code: err.code }, { status: ERROR_STATUS[err.code] ?? 400 })
  }
  throw err
}
