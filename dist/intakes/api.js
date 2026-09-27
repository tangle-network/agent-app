import {
  IntakeError
} from "../chunk-VWAEWOWK.js";
import "../chunk-YZ6KQULN.js";
import {
  intakeProgress,
  nextQuestion
} from "../chunk-JDEGS53O.js";

// src/intakes/api.ts
function createIntakeApi(opts) {
  const { store, graph } = opts;
  function view(state) {
    return {
      graphId: graph.id,
      title: graph.title,
      ...graph.description ? { description: graph.description } : {},
      answers: state.payload.answers,
      nextQuestion: nextQuestion(graph, state.payload.answers),
      completed: state.completed,
      completedAt: state.completedAt ? state.completedAt.toISOString() : null,
      progress: intakeProgress(graph, state.payload.answers)
    };
  }
  async function getCurrentIntake() {
    const state = await store.get();
    return Response.json(view(state));
  }
  async function saveAnswer(input) {
    if (!input.questionId) return Response.json({ error: "Missing questionId" }, { status: 400 });
    try {
      const state = await store.save(input.questionId, input.value ?? null);
      return Response.json(view(state));
    } catch (err) {
      return intakeErrorResponse(err);
    }
  }
  async function completeIntake() {
    try {
      const state = await store.complete();
      return Response.json(view(state));
    } catch (err) {
      return intakeErrorResponse(err);
    }
  }
  return { getCurrentIntake, saveAnswer, completeIntake };
}
var ERROR_STATUS = {
  "invalid-answer": 400,
  "unknown-question": 404,
  incomplete: 409,
  "stale-graph": 409
};
function intakeErrorResponse(err) {
  if (err instanceof IntakeError) {
    return Response.json({ error: err.message, code: err.code }, { status: ERROR_STATUS[err.code] ?? 400 });
  }
  throw err;
}
export {
  createIntakeApi
};
//# sourceMappingURL=api.js.map