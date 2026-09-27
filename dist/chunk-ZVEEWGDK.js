// src/work-product/types.ts
var WORK_PRODUCT_STATUSES = [
  "draft",
  "blocked",
  "ready",
  "changes_requested",
  "approved",
  "superseded"
];
function isWorkProductStatus(value) {
  return typeof value === "string" && WORK_PRODUCT_STATUSES.includes(value);
}
function unresolvedBlockingExceptions(exceptions) {
  return exceptions.filter((entry) => entry.severity === "blocking" && !entry.resolved);
}
function fail(field, error) {
  return { ok: false, field, error };
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function parseEvidenceInput(raw, path = "entry") {
  const record = asRecord(raw);
  if (!record) return fail(path, "must be an object");
  if (!nonEmptyString(record.id)) return fail(`${path}.id`, "must be a non-empty string (stable per entry; re-emitting the same id replaces it)");
  if (!nonEmptyString(record.sourceRef)) return fail(`${path}.sourceRef`, "must be a non-empty source document ref");
  if (!nonEmptyString(record.target)) return fail(`${path}.target`, "must name the artifact field/claim this evidence supports");
  if (!nonEmptyString(record.claim)) return fail(`${path}.claim`, "must state the value/assertion at the target");
  const locatorRaw = record.locator === void 0 ? {} : asRecord(record.locator);
  if (!locatorRaw) return fail(`${path}.locator`, "must be an object when present");
  const locator = {};
  if (locatorRaw.page !== void 0) {
    if (typeof locatorRaw.page !== "number" || !Number.isFinite(locatorRaw.page)) {
      return fail(`${path}.locator.page`, "must be a finite number when present");
    }
    locator.page = locatorRaw.page;
  }
  if (locatorRaw.range !== void 0) {
    if (!nonEmptyString(locatorRaw.range)) return fail(`${path}.locator.range`, "must be a non-empty string when present");
    locator.range = locatorRaw.range;
  }
  if (locatorRaw.quote !== void 0) {
    if (typeof locatorRaw.quote !== "string") return fail(`${path}.locator.quote`, "must be a string when present");
    locator.quote = locatorRaw.quote;
  }
  if (locatorRaw.find !== void 0) {
    if (typeof locatorRaw.find !== "string" || locatorRaw.find.trim().length === 0) {
      return fail(`${path}.locator.find`, "must be a non-empty string \u2014 the value or text to locate in the source");
    }
    locator.find = locatorRaw.find;
  }
  if (locatorRaw.findOccurrence !== void 0) {
    const value = locatorRaw.findOccurrence;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return fail(`${path}.locator.findOccurrence`, "must be a positive integer (1 = the first occurrence)");
    }
    locator.findOccurrence = value;
  }
  if (locatorRaw.span !== void 0) {
    const spanRaw = asRecord(locatorRaw.span);
    if (!spanRaw) return fail(`${path}.locator.span`, "must be an object { start, end } when present");
    for (const field of ["start", "end"]) {
      const value = spanRaw[field];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        return fail(`${path}.locator.span.${field}`, "must be a non-negative integer character offset");
      }
    }
    if (spanRaw.end <= spanRaw.start) {
      return fail(`${path}.locator.span`, `end (${String(spanRaw.end)}) must be greater than start (${String(spanRaw.start)}) \u2014 the range is half-open [start, end)`);
    }
    locator.span = { start: spanRaw.start, end: spanRaw.end };
  }
  const entry = {
    id: record.id.trim(),
    sourceRef: record.sourceRef.trim(),
    locator,
    target: record.target.trim(),
    claim: record.claim
  };
  if (record.confidence !== void 0) {
    if (typeof record.confidence !== "number" || !(record.confidence >= 0 && record.confidence <= 1)) {
      return fail(`${path}.confidence`, "must be a number in 0..1 when present");
    }
    entry.confidence = record.confidence;
  }
  return { ok: true, value: entry };
}
var EXCEPTION_SEVERITIES = ["blocking", "material", "advisory"];
function parseExceptionInput(raw, path = "exception") {
  const record = asRecord(raw);
  if (!record) return fail(path, "must be an object");
  if (!nonEmptyString(record.id)) return fail(`${path}.id`, "must be a non-empty string (stable per entry; re-emitting the same id replaces it)");
  if (!EXCEPTION_SEVERITIES.includes(record.severity)) {
    return fail(`${path}.severity`, `must be one of: ${EXCEPTION_SEVERITIES.join(", ")}`);
  }
  if (!nonEmptyString(record.kind)) return fail(`${path}.kind`, "must be a non-empty exception kind");
  if (!nonEmptyString(record.message)) return fail(`${path}.message`, "must describe the problem");
  const entry = {
    id: record.id.trim(),
    severity: record.severity,
    kind: record.kind.trim(),
    message: record.message,
    resolved: record.resolved === true
  };
  if (record.targets !== void 0) {
    if (!Array.isArray(record.targets) || !record.targets.every(nonEmptyString)) {
      return fail(`${path}.targets`, "must be an array of non-empty strings when present");
    }
    entry.targets = record.targets;
  }
  if (record.resolvedBy !== void 0) {
    if (record.resolvedBy !== "agent" && record.resolvedBy !== "reviewer") {
      return fail(`${path}.resolvedBy`, "must be 'agent' or 'reviewer' when present");
    }
    entry.resolvedBy = record.resolvedBy;
  }
  if (record.resolutionNote !== void 0) {
    if (typeof record.resolutionNote !== "string") return fail(`${path}.resolutionNote`, "must be a string when present");
    entry.resolutionNote = record.resolutionNote;
  }
  return { ok: true, value: entry };
}
function parseArtifactInput(raw, path = "artifact") {
  const record = asRecord(raw);
  if (!record) return fail(path, "must be an object");
  if (!nonEmptyString(record.kind)) return fail(`${path}.kind`, "must be a non-empty artifact kind");
  if (!nonEmptyString(record.title)) return fail(`${path}.title`, "must be a non-empty title");
  for (const key of ["path", "content", "mediaType"]) {
    if (record[key] !== void 0 && !nonEmptyString(record[key])) {
      return fail(`${path}.${key}`, "must be a non-empty string when present");
    }
  }
  let baseline;
  if (record.baseline !== void 0) {
    const baselineRecord = asRecord(record.baseline);
    if (!baselineRecord) return fail(`${path}.baseline`, "must be an object when present");
    baseline = {};
    if (baselineRecord.path !== void 0) {
      if (!nonEmptyString(baselineRecord.path)) return fail(`${path}.baseline.path`, "must be a non-empty string when present");
      baseline.path = baselineRecord.path.trim();
    }
    if (baselineRecord.content !== void 0) {
      if (typeof baselineRecord.content !== "string") return fail(`${path}.baseline.content`, "must be a string when present");
      baseline.content = baselineRecord.content;
    }
  }
  let fields;
  if (record.fields !== void 0) {
    const fieldsRecord = asRecord(record.fields);
    if (!fieldsRecord) return fail(`${path}.fields`, "must be an object when present");
    fields = fieldsRecord;
  }
  if (record.path === void 0 && record.content === void 0 && fields === void 0) {
    return fail(path, "must carry a body: at least one of path, content, or fields");
  }
  const artifact = {
    kind: record.kind.trim(),
    title: record.title.trim()
  };
  if (record.path !== void 0) artifact.path = record.path.trim();
  if (record.content !== void 0) artifact.content = record.content;
  if (record.mediaType !== void 0) artifact.mediaType = record.mediaType.trim();
  if (baseline !== void 0) artifact.baseline = baseline;
  if (fields !== void 0) artifact.fields = fields;
  return { ok: true, value: artifact };
}
function parseAgentCheckInput(raw, path = "check") {
  const record = asRecord(raw);
  if (!record) return fail(path, "must be an object");
  if (!nonEmptyString(record.id)) return fail(`${path}.id`, "must be a non-empty string");
  if (!nonEmptyString(record.name)) return fail(`${path}.name`, "must be a non-empty check name");
  if (typeof record.passed !== "boolean") return fail(`${path}.passed`, "must be a boolean");
  const check = {
    id: record.id.trim(),
    name: record.name.trim(),
    passed: record.passed
  };
  if (record.detail !== void 0) {
    if (typeof record.detail !== "string") return fail(`${path}.detail`, "must be a string when present");
    check.detail = record.detail;
  }
  return { ok: true, value: check };
}
function workProductToPersistedPart(record) {
  return {
    type: "work_product",
    ref: { id: record.id, version: record.version },
    kind: record.artifact?.kind ?? "",
    title: record.artifact?.title ?? record.scopeKey,
    status: record.status
  };
}
function persistedPartToWorkProduct(part) {
  if (!part || part.type !== "work_product") return null;
  const ref = asRecord(part.ref);
  if (!ref || !nonEmptyString(ref.id) || typeof ref.version !== "number" || !Number.isFinite(ref.version)) return null;
  if (typeof part.kind !== "string" || !nonEmptyString(part.title) || !isWorkProductStatus(part.status)) return null;
  return {
    type: "work_product",
    ref: { id: ref.id, version: ref.version },
    kind: part.kind,
    title: part.title,
    status: part.status
  };
}

export {
  isWorkProductStatus,
  unresolvedBlockingExceptions,
  parseEvidenceInput,
  parseExceptionInput,
  parseArtifactInput,
  parseAgentCheckInput,
  workProductToPersistedPart,
  persistedPartToWorkProduct
};
//# sourceMappingURL=chunk-ZVEEWGDK.js.map