// src/interactions/contract.ts
import {
  InteractionRequestSchema
} from "@tangle-network/agent-interface";
var INTERACTION_EVENT = "interaction";
var INTERACTION_CANCEL_EVENT = "interaction.cancel";
var INTERACTION_RESOLVED_EVENT = "interaction.resolved";
var RENDERABLE_INTERACTION_KINDS = /* @__PURE__ */ new Set(["question", "plan"]);
function isRenderableInteractionKind(kind) {
  return RENDERABLE_INTERACTION_KINDS.has(kind);
}
function isSafeInteractionFieldKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}
function parseInteractionAnswers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { succeeded: false, error: "interaction answers must be an object" };
  }
  const answers = {};
  for (const [key, selection] of Object.entries(value)) {
    if (!isSafeInteractionFieldKey(key)) {
      return { succeeded: false, error: `interaction answers contain an unsafe field key: ${key}` };
    }
    const valid = typeof selection === "string" || typeof selection === "number" || typeof selection === "boolean" || Array.isArray(selection) && selection.every((item) => typeof item === "string");
    if (!valid) {
      return { succeeded: false, error: `interaction answer ${key} must be a string, number, boolean, or string array` };
    }
    answers[key] = Array.isArray(selection) ? [...selection] : selection;
  }
  return { succeeded: true, value: answers };
}
function isTerminalInteractionStatus(status) {
  return status !== "pending";
}
function canTransitionInteractionStatus(from, to) {
  return from === "pending" && to !== from;
}
function cancelStatusFor(reason) {
  return reason === "timeout" ? "expired" : "cancelled";
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stableValue(nested)])
  );
}
function normalizedInteractionText(value) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
function questionInteractionContentSignature(interaction) {
  if (interaction.kind !== "question") return null;
  return JSON.stringify(stableValue({
    kind: interaction.kind,
    title: normalizedInteractionText(interaction.title),
    body: normalizedInteractionText(interaction.body),
    fields: interaction.fields
  }));
}
function dedupeQuestionInteractionsByContent(interactions) {
  const seen = /* @__PURE__ */ new Set();
  return interactions.filter((interaction) => {
    const signature = questionInteractionContentSignature(interaction);
    if (!signature) return true;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}
function parseInteractionRequest(data) {
  const request = data?.request;
  if (!request || typeof request !== "object") {
    return { succeeded: false, error: "interaction event carried no request object" };
  }
  const validation = InteractionRequestSchema.safeParse(request);
  if (!validation.success) {
    return { succeeded: false, error: `malformed interaction request: ${validation.error.message}` };
  }
  return { succeeded: true, value: validation.data };
}
function parseInteractionCancel(data) {
  const id = typeof data?.id === "string" && data.id ? data.id : null;
  if (!id) return { succeeded: false, error: "interaction.cancel event carried no id" };
  const reason = typeof data?.reason === "string" && data.reason ? data.reason : void 0;
  return { succeeded: true, value: { id, ...reason ? { reason } : {} } };
}
function fieldAcceptsFreeText(field) {
  if (field.type === "text") return true;
  if (field.type === "select") return field.allowCustom === true;
  return false;
}
function composerAnswerDeliveries(pending) {
  const deliveries = [];
  for (const interaction of pending) {
    if (interaction.kind !== "question") continue;
    const field = interaction.fields.find(fieldAcceptsFreeText) ?? interaction.fields[0];
    if (!field) continue;
    deliveries.push({ interactionId: interaction.id, field });
  }
  return deliveries;
}
function composerAnswerData(field, text) {
  return { [field.name]: field.type === "select" ? [text] : text };
}
function interactionPartKey(id) {
  return `interaction:${id}`;
}
function noticePartKey(id) {
  return `notice:${id}`;
}
function noticePart(noticeKind, id, text) {
  return { type: "notice", id, noticeKind, text };
}
function interactionFromWireRequest(request) {
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    ...request.body ? { body: request.body } : {},
    fields: request.answerSpec.fields,
    status: "pending"
  };
}
function interactionToPersistedPart(request, status, cancelReason, answers) {
  const parsedAnswers = answers === void 0 ? void 0 : parseInteractionAnswers(answers);
  if (parsedAnswers && !parsedAnswers.succeeded) throw new TypeError(parsedAnswers.error);
  return {
    type: "interaction",
    id: request.id,
    kind: request.kind,
    title: request.title,
    ...request.body ? { body: request.body } : {},
    answerSpec: { fields: request.answerSpec.fields },
    status,
    ...parsedAnswers?.succeeded ? { answers: parsedAnswers.value } : {},
    ...cancelReason ? { cancelReason } : {}
  };
}
function stampInteractionAnswers(parts, answersByInteractionId) {
  return parts.map((part) => {
    if (String(part.type ?? "") !== "interaction" || typeof part.id !== "string") return part;
    if (!Object.prototype.hasOwnProperty.call(answersByInteractionId, part.id)) return part;
    const rawAnswers = answersByInteractionId[part.id];
    if (rawAnswers === void 0) return part;
    const parsed = parseInteractionAnswers(rawAnswers);
    if (!parsed.succeeded) throw new TypeError(parsed.error);
    return { ...part, answers: parsed.value };
  });
}
function persistedPartToInteraction(part) {
  if (String(part.type ?? "") !== "interaction") return null;
  const id = typeof part.id === "string" && part.id ? part.id : null;
  const kind = typeof part.kind === "string" && part.kind ? part.kind : null;
  const title = typeof part.title === "string" ? part.title : "";
  const answerSpec = part.answerSpec;
  const fields = Array.isArray(answerSpec?.fields) ? answerSpec.fields : null;
  const status = part.status;
  const validStatus = status && ["pending", "answered", "declined", "cancelled", "expired"].includes(status);
  const parsedAnswers = part.answers === void 0 ? void 0 : parseInteractionAnswers(part.answers);
  if (!id || !kind || !fields || !validStatus || parsedAnswers && !parsedAnswers.succeeded) return null;
  return {
    id,
    kind,
    title,
    ...typeof part.body === "string" && part.body ? { body: part.body } : {},
    fields,
    status,
    ...parsedAnswers?.succeeded ? { answers: parsedAnswers.value } : {},
    ...typeof part.cancelReason === "string" && part.cancelReason ? { cancelReason: part.cancelReason } : {}
  };
}

export {
  INTERACTION_EVENT,
  INTERACTION_CANCEL_EVENT,
  INTERACTION_RESOLVED_EVENT,
  isRenderableInteractionKind,
  isSafeInteractionFieldKey,
  parseInteractionAnswers,
  isTerminalInteractionStatus,
  canTransitionInteractionStatus,
  cancelStatusFor,
  questionInteractionContentSignature,
  dedupeQuestionInteractionsByContent,
  parseInteractionRequest,
  parseInteractionCancel,
  fieldAcceptsFreeText,
  composerAnswerDeliveries,
  composerAnswerData,
  interactionPartKey,
  noticePartKey,
  noticePart,
  interactionFromWireRequest,
  interactionToPersistedPart,
  stampInteractionAnswers,
  persistedPartToInteraction
};
//# sourceMappingURL=chunk-M3K2HVQD.js.map