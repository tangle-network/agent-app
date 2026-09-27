// src/intakes/model.ts
var URL_PATTERN = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function getQuestion(graph, questionId) {
  return graph.questions.find((q) => q.id === questionId) ?? null;
}
function hasAnswer(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
function validateAnswer(question, value) {
  if (!hasAnswer(value)) {
    return question.required ? { ok: false, reason: "required" } : { ok: true };
  }
  switch (question.type) {
    case "text":
    case "long-text": {
      if (typeof value !== "string") return { ok: false, reason: "wrong-type" };
      const len = value.trim().length;
      if (question.min != null && len < question.min) return { ok: false, reason: "too-short" };
      if (question.max != null && len > question.max) return { ok: false, reason: "too-long" };
      return { ok: true };
    }
    case "url": {
      if (typeof value !== "string") return { ok: false, reason: "wrong-type" };
      return URL_PATTERN.test(value.trim()) ? { ok: true } : { ok: false, reason: "invalid-url" };
    }
    case "email": {
      if (typeof value !== "string") return { ok: false, reason: "wrong-type" };
      return EMAIL_PATTERN.test(value.trim()) ? { ok: true } : { ok: false, reason: "invalid-email" };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "wrong-type" };
      if (question.min != null && value < question.min) return { ok: false, reason: "too-small" };
      if (question.max != null && value > question.max) return { ok: false, reason: "too-large" };
      return { ok: true };
    }
    case "boolean": {
      return typeof value === "boolean" ? { ok: true } : { ok: false, reason: "wrong-type" };
    }
    case "single-select": {
      if (typeof value !== "string") return { ok: false, reason: "wrong-type" };
      return optionExists(question, value) ? { ok: true } : { ok: false, reason: "not-an-option" };
    }
    case "multi-select": {
      if (!Array.isArray(value)) return { ok: false, reason: "wrong-type" };
      if (!value.every((v) => typeof v === "string" && optionExists(question, v))) {
        return { ok: false, reason: "not-an-option" };
      }
      if (question.min != null && value.length < question.min) return { ok: false, reason: "too-short" };
      if (question.max != null && value.length > question.max) return { ok: false, reason: "too-long" };
      return { ok: true };
    }
    default:
      return { ok: false, reason: "wrong-type" };
  }
}
function nextQuestion(graph, answers) {
  if (graph.questions.length === 0) return null;
  const visited = /* @__PURE__ */ new Set();
  let current = graph.questions[0] ?? null;
  while (current) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    const answer = answers[current.id];
    const validity = validateAnswer(current, answer);
    if (!validity.ok || current.required && !hasAnswer(answer)) {
      return current;
    }
    current = advance(graph, current, answers);
  }
  return null;
}
function isComplete(graph, answers) {
  return nextQuestion(graph, answers) === null;
}
function intakeProgress(graph, answers) {
  const reachable = reachableQuestions(graph, answers);
  const required = reachable.filter((q) => q.required);
  const answered = required.filter((q) => validateAnswer(q, answers[q.id]).ok && hasAnswer(answers[q.id])).length;
  return { answered, total: required.length };
}
function reachableQuestions(graph, answers) {
  if (graph.questions.length === 0) return [];
  const visited = /* @__PURE__ */ new Set();
  const out = [];
  let current = graph.questions[0] ?? null;
  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    out.push(current);
    current = advance(graph, current, answers);
  }
  return out;
}
function advance(graph, current, answers) {
  if (current.next) {
    const nextId = current.next(answers);
    return nextId == null ? null : getQuestion(graph, nextId);
  }
  const index = graph.questions.indexOf(current);
  return graph.questions[index + 1] ?? null;
}
function optionExists(question, value) {
  return (question.options ?? []).some((option) => option.value === value);
}

export {
  getQuestion,
  hasAnswer,
  validateAnswer,
  nextQuestion,
  isComplete,
  intakeProgress,
  reachableQuestions
};
//# sourceMappingURL=chunk-JDEGS53O.js.map