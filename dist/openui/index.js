import {
  OPENUI_INPUT_KINDS,
  OPENUI_INTERACTIVE_AUTHORING_GUIDE
} from "../chunk-UGWQLQDS.js";

// src/openui/segments.ts
var FENCE = /```openui\s*\n([\s\S]*?)```/g;
function isNodeLike(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.type === "string";
}
function nodesFrom(parsed) {
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  return candidates.filter(isNodeLike);
}
function pushText(segments, text) {
  const trimmed = text.trim();
  if (trimmed) segments.push({ type: "markdown", text: trimmed });
}
function parseOpenUISegments(content) {
  const segments = [];
  let lastIndex = 0;
  FENCE.lastIndex = 0;
  let match;
  while ((match = FENCE.exec(content)) !== null) {
    if (match.index > lastIndex) pushText(segments, content.slice(lastIndex, match.index));
    const body = match[1] ?? "";
    let nodes = [];
    try {
      nodes = nodesFrom(JSON.parse(body));
    } catch {
      nodes = [];
    }
    if (nodes.length > 0) segments.push({ type: "openui", nodes });
    else pushText(segments, `\`\`\`json
${body}\`\`\``);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) pushText(segments, content.slice(lastIndex));
  if (segments.length === 0 && content.trim()) segments.push({ type: "markdown", text: content });
  return segments;
}
function hasOpenUISegment(content) {
  return parseOpenUISegments(content).some((segment) => segment.type === "openui");
}
function parseOpenUIArtifact(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { succeeded: false, error: { code: "artifact_not_json", message: "Stored page is not JSON." } };
  }
  const envelope = parsed && typeof parsed === "object" && !Array.isArray(parsed) && "schema" in parsed ? parsed : null;
  const nodes = nodesFrom(envelope ? envelope.schema : parsed);
  if (nodes.length === 0) {
    return { succeeded: false, error: { code: "artifact_no_nodes", message: "Stored page carries no nodes." } };
  }
  const title = envelope && typeof envelope.title === "string" ? envelope.title : void 0;
  return { succeeded: true, value: { nodes, ...title ? { title } : {} } };
}

// src/openui/values.ts
function isSafeOpenUIFieldId(id) {
  return /^[A-Za-z0-9_-]+$/.test(id) && id !== "__proto__" && id !== "constructor" && id !== "prototype";
}
var FIELD_KINDS = /* @__PURE__ */ new Set([
  "text",
  "number",
  "currency",
  "select",
  "checkbox",
  "slider"
]);
function isOpenUIFieldKind(kind) {
  return FIELD_KINDS.has(kind);
}
function issue(fieldId, code, message) {
  return { fieldId, code, message };
}
var STEP_EPSILON = 1e-9;
function checkNumeric(field, value) {
  if (!Number.isFinite(value)) return issue(field.id, "type", `${field.id} must be a finite number`);
  if (field.min !== void 0 && value < field.min) {
    return issue(field.id, "range", `${field.id} must be at least ${field.min}`);
  }
  if (field.max !== void 0 && value > field.max) {
    return issue(field.id, "range", `${field.id} must be at most ${field.max}`);
  }
  if (field.step !== void 0 && field.step > 0) {
    const offset = (value - (field.min ?? 0)) / field.step;
    if (Math.abs(offset - Math.round(offset)) > STEP_EPSILON) {
      return issue(field.id, "step", `${field.id} must move in steps of ${field.step}`);
    }
  }
  return null;
}
function isEmpty(value) {
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
function checkField(field, value) {
  if (value === void 0 || isEmpty(value)) {
    if (field.required) return issue(field.id, "required", `${field.id} is required`);
    return null;
  }
  switch (field.kind) {
    case "text": {
      if (typeof value !== "string") return issue(field.id, "type", `${field.id} must be text`);
      if (field.maxLength !== void 0 && value.length > field.maxLength) {
        return issue(field.id, "length", `${field.id} must be at most ${field.maxLength} characters`);
      }
      return null;
    }
    case "number":
    case "currency":
    case "slider": {
      if (typeof value !== "number") return issue(field.id, "type", `${field.id} must be a number`);
      return checkNumeric(field, value);
    }
    case "checkbox": {
      if (typeof value !== "boolean") return issue(field.id, "type", `${field.id} must be true or false`);
      return null;
    }
    case "select": {
      const allowed = field.options ? new Set(field.options.map((option) => option.value)) : null;
      if (field.multiple) {
        if (!Array.isArray(value)) return issue(field.id, "type", `${field.id} must be a list of choices`);
        if (allowed) {
          const rejected = value.find((entry) => !allowed.has(entry));
          if (rejected !== void 0) {
            return issue(field.id, "option", `${field.id} does not offer "${rejected}"`);
          }
        }
        return null;
      }
      if (typeof value !== "string") return issue(field.id, "type", `${field.id} must be a single choice`);
      if (allowed && !allowed.has(value)) return issue(field.id, "option", `${field.id} does not offer "${value}"`);
      return null;
    }
  }
}
function validateOpenUIFormValues(spec, values) {
  const issues = [];
  const seen = /* @__PURE__ */ new Set();
  for (const field of spec.fields) {
    if (!isSafeOpenUIFieldId(field.id)) {
      issues.push(issue(field.id, "unsafe_field_id", `${field.id} is not a usable field id`));
      continue;
    }
    if (seen.has(field.id)) {
      issues.push(issue(field.id, "duplicate_field", `${field.id} is declared more than once`));
      continue;
    }
    seen.add(field.id);
  }
  for (const key of Object.keys(values)) {
    if (!seen.has(key)) issues.push(issue(key, "unknown_field", `${key} is not a field on this form`));
  }
  const accepted = {};
  for (const field of spec.fields) {
    if (!seen.has(field.id)) continue;
    const value = Object.prototype.hasOwnProperty.call(values, field.id) ? values[field.id] : void 0;
    const problem = checkField(field, value);
    if (problem) {
      issues.push(problem);
      continue;
    }
    if (value !== void 0) accepted[field.id] = value;
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, values: accepted };
}

// src/openui/action.ts
function isSafeOpenUIActionId(id) {
  return isSafeOpenUIFieldId(id);
}
function isOpenUIValue(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function optionalId(value, code, label) {
  if (value === void 0 || value === null) return { ok: true, value: void 0 };
  if (typeof value !== "string" || !isSafeOpenUIActionId(value)) {
    return { ok: false, code, error: `Invalid ${label}: letters, numbers, underscores, and hyphens only` };
  }
  return { ok: true, value };
}
function isSafeArtifactPath(path) {
  return path.length > 0 && path.length <= 512 && !path.includes("..") && !path.startsWith("/");
}
function validateOpenUIActionBody(body) {
  const actionId = body.actionId;
  if (typeof actionId !== "string" || actionId.trim() === "") {
    return { ok: false, code: "OPENUI_ACTION_ID_MISSING", error: "Missing actionId" };
  }
  if (!isSafeOpenUIActionId(actionId)) {
    return {
      ok: false,
      code: "OPENUI_ACTION_ID_INVALID",
      error: "Invalid actionId: letters, numbers, underscores, and hyphens only"
    };
  }
  const formId = optionalId(body.formId, "OPENUI_FORM_ID_INVALID", "formId");
  if (!formId.ok) return formId;
  const nodeId = optionalId(body.nodeId, "OPENUI_NODE_ID_INVALID", "nodeId");
  if (!nodeId.ok) return nodeId;
  let artifactPath;
  if (body.artifactPath !== void 0 && body.artifactPath !== null) {
    if (typeof body.artifactPath !== "string" || !isSafeArtifactPath(body.artifactPath)) {
      return { ok: false, code: "OPENUI_ARTIFACT_PATH_INVALID", error: "Invalid artifactPath" };
    }
    artifactPath = body.artifactPath;
  }
  const values = {};
  if (body.values !== void 0 && body.values !== null) {
    if (typeof body.values !== "object" || Array.isArray(body.values)) {
      return { ok: false, code: "OPENUI_VALUES_INVALID", error: "Invalid values: expected an object of field values" };
    }
    for (const [key, value] of Object.entries(body.values)) {
      if (!isSafeOpenUIFieldId(key)) {
        return {
          ok: false,
          code: "OPENUI_FIELD_ID_INVALID",
          error: "Invalid values: field names must contain only letters, numbers, underscores, or hyphens"
        };
      }
      if (!isOpenUIValue(value)) {
        return {
          ok: false,
          code: "OPENUI_FIELD_VALUE_INVALID",
          error: "Invalid values: field values must be strings, numbers, booleans, or string arrays"
        };
      }
      values[key] = value;
    }
  }
  return {
    ok: true,
    submission: {
      actionId,
      values,
      ...formId.value ? { formId: formId.value } : {},
      ...nodeId.value ? { nodeId: nodeId.value } : {},
      ...artifactPath ? { artifactPath } : {}
    }
  };
}
function describeValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}
function describeOpenUIAction(submission) {
  const entries = Object.entries(submission.values);
  const where = submission.formId ? ` on form "${submission.formId}"` : "";
  if (entries.length === 0) return `User pressed "${submission.actionId}"${where}.`;
  const pairs = entries.map(([key, value]) => `${key}=${describeValue(value)}`).join(", ");
  return `User pressed "${submission.actionId}"${where} with ${pairs}.`;
}

// src/openui/route.ts
function failure(code, error, status, extra) {
  return Response.json({ ok: false, code, error, ...extra ?? {} }, { status });
}
function createOpenUIActionRoute(options) {
  const logger = options.logger ?? console;
  async function handle(request) {
    if (request.method !== "POST") return failure("OPENUI_METHOD_NOT_ALLOWED", "Method not allowed", 405);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return failure("OPENUI_BODY_INVALID", "Invalid JSON body", 400);
    }
    const parsed = validateOpenUIActionBody(body);
    if (!parsed.ok) return failure(parsed.code, parsed.error, 400);
    const submission = parsed.submission;
    const handler = Object.prototype.hasOwnProperty.call(options.actions, submission.actionId) ? options.actions[submission.actionId] : void 0;
    if (!handler) {
      return failure(
        "OPENUI_ACTION_UNKNOWN",
        `No handler is registered for "${submission.actionId}".`,
        404,
        { actionId: submission.actionId }
      );
    }
    const resolution = await options.resolve({ request, submission });
    if (!resolution.ok) return resolution.response;
    const spec = submission.formId && options.forms ? Object.prototype.hasOwnProperty.call(options.forms, submission.formId) ? options.forms[submission.formId] : void 0 : void 0;
    let values = submission.values;
    if (spec) {
      const checked = validateOpenUIFormValues(spec, submission.values);
      if (!checked.ok) {
        return failure("OPENUI_VALUES_REJECTED", "Some fields need fixing before this can run.", 422, {
          issues: checked.issues
        });
      }
      values = checked.values;
    }
    const checkedSubmission = { ...submission, values };
    let result;
    try {
      result = await handler({ request, submission: checkedSubmission, context: resolution.context });
    } catch (error) {
      logger.error("[openui] action handler failed:", error);
      return failure("OPENUI_ACTION_FAILED", "That action could not be completed. Try again.", 500, {
        actionId: submission.actionId
      });
    }
    if (!result.ok) {
      return failure(result.code, result.message, result.status ?? 400, {
        actionId: submission.actionId,
        ...result.issues ? { issues: result.issues } : {}
      });
    }
    if (options.recordForAgent) {
      try {
        await options.recordForAgent({
          request,
          submission: checkedSubmission,
          context: resolution.context,
          note: describeOpenUIAction(checkedSubmission)
        });
      } catch (error) {
        logger.warn("[openui] recordForAgent failed:", error);
      }
    }
    return Response.json({
      ok: true,
      actionId: submission.actionId,
      ...result.message ? { message: result.message } : {},
      ...result.values ? { values: result.values } : {},
      ...result.schema ? { schema: result.schema } : {},
      ...result.data ? { data: result.data } : {}
    });
  }
  return { handle };
}
export {
  OPENUI_INPUT_KINDS,
  OPENUI_INTERACTIVE_AUTHORING_GUIDE,
  createOpenUIActionRoute,
  describeOpenUIAction,
  hasOpenUISegment,
  isOpenUIFieldKind,
  isSafeOpenUIActionId,
  isSafeOpenUIFieldId,
  parseOpenUIArtifact,
  parseOpenUISegments,
  validateOpenUIActionBody,
  validateOpenUIFormValues
};
//# sourceMappingURL=index.js.map