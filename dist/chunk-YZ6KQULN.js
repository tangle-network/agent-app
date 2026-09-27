import {
  isComplete
} from "./chunk-JDEGS53O.js";

// src/intakes/completion.ts
function emptyPayload(graph) {
  return { graphId: graph.id, answers: {} };
}
function withAnswer(payload, questionId, value) {
  return { ...payload, answers: { ...payload.answers, [questionId]: value } };
}
function payloadComplete(graph, payload) {
  if (payload.graphId !== graph.id) return false;
  return isComplete(graph, payload.answers);
}
function payloadIsStale(graph, payload) {
  return payload.graphId !== graph.id;
}
function markComplete(payload, at = /* @__PURE__ */ new Date()) {
  return { ...payload, completedAt: at.toISOString() };
}

export {
  emptyPayload,
  withAnswer,
  payloadComplete,
  payloadIsStale,
  markComplete
};
//# sourceMappingURL=chunk-YZ6KQULN.js.map