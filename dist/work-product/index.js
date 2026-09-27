import {
  parseReviewQueueItem,
  projectReviewQueue
} from "../chunk-GEYACSFW.js";
import {
  ToolInputError,
  defineAppTool
} from "../chunk-TX6S7XXU.js";
import "../chunk-UGWQLQDS.js";
import {
  isWorkProductStatus,
  parseAgentCheckInput,
  parseArtifactInput,
  parseEvidenceInput,
  parseExceptionInput,
  persistedPartToWorkProduct,
  unresolvedBlockingExceptions,
  workProductToPersistedPart
} from "../chunk-ZVEEWGDK.js";

// src/work-product/claim-support.ts
var CURRENCY = /[$€£¥₹]/gu;
var NUMBER_IN_TEXT = /[$€£¥₹]?\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?|[$€£¥₹]?\s*\d+(?:\.\d+)?/gu;
var FIGURE_IN_PROSE = /[$€£¥₹]\s*[-+]?\d[\d,]*(?:\.\d+)?|[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-+]?\d+\.\d{2}(?!\d)/gu;
var WHOLE_VALUE = /^[$€£¥₹]?\s*[-+]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*%?$/u;
function canonicalizeValue(token) {
  let text = token.trim();
  if (text.length === 0) return null;
  if (/^\(.*\)$/u.test(text)) text = text.slice(1, -1).trim();
  text = text.replace(CURRENCY, "").trim();
  text = text.replace(/^[-+]\s*/u, "").trim();
  text = text.replace(/%$/u, "").trim();
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/u.test(text)) return null;
  text = text.replace(/,/gu, "");
  if (text.includes(".")) text = text.replace(/0+$/u, "").replace(/\.$/u, "");
  text = text.replace(/^0+(?=\d)/u, "");
  return text.length === 0 ? null : text;
}
function valuesInText(text) {
  const seen = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(NUMBER_IN_TEXT)) {
    const canonical = canonicalizeValue(match[0]);
    if (canonical !== null) seen.add(canonical);
  }
  return [...seen];
}
function claimValues(claim) {
  const trimmed = claim.trim();
  if (WHOLE_VALUE.test(trimmed)) {
    const whole = canonicalizeValue(trimmed);
    if (whole !== null) return [whole];
  }
  const seen = /* @__PURE__ */ new Set();
  for (const match of trimmed.matchAll(FIGURE_IN_PROSE)) {
    const canonical = canonicalizeValue(match[0]);
    if (canonical !== null) seen.add(canonical);
  }
  return [...seen];
}
function verifyClaimSupport(quote, claim) {
  if (quote.trim().length === 0) return { status: "not_applicable" };
  const claimed = claimValues(claim);
  if (claimed.length === 0) return { status: "not_applicable" };
  const present = valuesInText(quote);
  const matched = claimed.find((value) => present.includes(value));
  if (matched !== void 0) return { status: "supported", matched };
  return { status: "unsupported", claimed, present };
}
function excerpt(quote, limit = 120) {
  const flat = quote.replace(/\s+/gu, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}\u2026`;
}
function claimSupportErrorDetail(failure, quote) {
  const wanted = failure.claimed.length === 1 ? failure.claimed[0] : `any of ${failure.claimed.join(", ")}`;
  const carries = failure.present.length === 0 ? "that line carries no figure at all" : `the only figures on it are ${failure.present.join(", ")}`;
  return `the cited text does not contain ${wanted}. It reads "${excerpt(quote)}", and ${carries}. Cite locator.find with the value exactly as it appears in the document and the platform will locate the right line for you. If this figure was COMPUTED rather than read from the document, omit the locator entirely and state the computation in claim.`;
}
function foldLabel(value) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function verifyTargetLabel(quote, target, groups) {
  if (quote.trim().length === 0) return { status: "not_applicable" };
  const group = groups.find((candidate) => Object.hasOwn(candidate.labels, target));
  if (!group) return { status: "not_applicable" };
  const line = ` ${foldLabel(quote)} `;
  const own = group.labels[target] ?? [];
  for (const label of own) {
    const folded = foldLabel(label);
    if (folded.length > 0 && line.includes(folded)) return { status: "identified", label };
  }
  for (const [rival, labels] of Object.entries(group.labels)) {
    if (rival === target) continue;
    for (const label of labels) {
      const folded = foldLabel(label);
      if (folded.length === 0 || !line.includes(folded)) continue;
      return {
        status: "crossed",
        rival,
        rivalLabel: label,
        expected: own,
        ...group.note === void 0 ? {} : { note: group.note }
      };
    }
  }
  return { status: "not_applicable" };
}
function targetLabelErrorDetail(failure, target, quote) {
  const ownLooks = failure.expected.length === 0 ? "" : ` A citation for ${target} should land on the line naming ${failure.expected.map((label) => JSON.stringify(label)).join(" or ")}.`;
  const note = failure.note === void 0 ? "" : ` (${failure.note})`;
  return `the line it cites reads "${excerpt(quote)}", which is the line for ${failure.rival} \u2014 it names ${JSON.stringify(failure.rivalLabel)}${note}.${ownLooks} Cite the line that belongs to this target, or attach this citation to ${failure.rival} instead. The figure is real; it is on the wrong line.`;
}
function indexArtifactValues(fields, normalizeTarget) {
  const index = /* @__PURE__ */ new Map();
  for (const [key, raw] of Object.entries(fields ?? {})) {
    const value = typeof raw === "number" && Number.isFinite(raw) ? canonicalizeValue(String(raw)) : typeof raw === "string" ? canonicalizeValue(raw) : null;
    if (value === null) continue;
    index.set(normalizeTarget ? normalizeTarget(key) : key, value);
  }
  return index;
}
function verifyArtifactAgreement(target, claim, fieldValues) {
  const expected = fieldValues.get(target);
  if (expected === void 0) return { status: "not_applicable" };
  const claimed = claimValues(claim);
  if (claimed.length === 0) return { status: "not_applicable" };
  if (claimed.includes(expected)) return { status: "agrees", value: expected };
  for (const value of claimed) {
    for (const [other, otherValue] of fieldValues) {
      if (other === target || otherValue !== value) continue;
      return { status: "contradicts", claimed: value, expected, belongsTo: other };
    }
  }
  return { status: "not_applicable" };
}
function artifactAgreementErrorDetail(failure, target) {
  return `the artifact reports ${failure.expected} on ${target} and ${failure.claimed} on ${failure.belongsTo}, so a citation claiming ${failure.claimed} does not support ${target} \u2014 it supports ${failure.belongsTo}. Attach this citation to ${failure.belongsTo}, or correct the artifact if ${target} really is ${failure.claimed}. The package cannot state both.`;
}

// src/work-product/service.ts
var WORK_PRODUCT_TRANSITIONS = {
  draft: /* @__PURE__ */ new Set(["blocked", "ready"]),
  blocked: /* @__PURE__ */ new Set(["draft"]),
  ready: /* @__PURE__ */ new Set(["changes_requested", "approved", "superseded"]),
  changes_requested: /* @__PURE__ */ new Set(["draft", "superseded"]),
  approved: /* @__PURE__ */ new Set(["superseded"]),
  superseded: /* @__PURE__ */ new Set()
};
function canTransitionWorkProduct(from, to) {
  return WORK_PRODUCT_TRANSITIONS[from].has(to);
}
function isWorkProductTerminal(status) {
  return WORK_PRODUCT_TRANSITIONS[status].size === 0;
}
function rejected(error) {
  return { succeeded: false, error, conflict: false };
}
function lostRace(id) {
  return { succeeded: false, error: `Work product ${id} changed concurrently`, conflict: true };
}
function mergeById(existing, incoming) {
  const merged = existing.slice();
  const indexById = new Map(merged.map((entry, index) => [entry.id, index]));
  for (const entry of incoming) {
    const at = indexById.get(entry.id);
    if (at === void 0) {
      indexById.set(entry.id, merged.length);
      merged.push(entry);
    } else {
      merged[at] = entry;
    }
  }
  return merged;
}
function evidenceIdentity(entry) {
  const whole = canonicalizeValue(entry.claim);
  const claimKey = whole ?? entry.claim.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  return `${entry.target}\0${entry.sourceRef}\0${claimKey}`;
}
function mergeEvidence(existing, incoming) {
  const merged = existing.slice();
  for (const entry of incoming) {
    const identity = evidenceIdentity(entry);
    const hits = [];
    for (let index = 0; index < merged.length; index += 1) {
      const candidate = merged[index];
      if (candidate.id === entry.id || evidenceIdentity(candidate) === identity) hits.push(index);
    }
    if (hits.length === 0) {
      merged.push(entry);
      continue;
    }
    merged[hits[0]] = entry;
    for (const index of hits.slice(1).reverse()) merged.splice(index, 1);
  }
  return merged;
}
function createWorkProductService(options) {
  const { store } = options;
  const now = options.now ?? (() => Date.now());
  const generateId = options.generateId ?? (() => crypto.randomUUID());
  async function appendEvent(record, step, message, metadata = {}) {
    await store.appendEvent({
      workProductId: record.id,
      workspaceId: record.workspaceId,
      step,
      message,
      metadata,
      at: now()
    });
  }
  async function transition(id, to, patch = {}, eventMeta = {}) {
    const record = await store.load(id);
    if (!record) return rejected(`Work product ${id} not found`);
    const from = record.status;
    if (isWorkProductTerminal(from)) {
      return rejected(`Work product ${id} is terminal (${from}); cannot transition to ${to}`);
    }
    if (!canTransitionWorkProduct(from, to)) {
      return rejected(`Illegal work-product transition ${from} -> ${to} for ${id}`);
    }
    const updated = await store.update(
      id,
      { status: from, version: record.version },
      { status: to, updatedAt: now(), ...patch }
    );
    if (!updated) return lostRace(id);
    await appendEvent(updated, `wp.${to}`, `Work product ${from} -> ${to}`, { from, to, ...eventMeta });
    return { succeeded: true, value: updated };
  }
  async function guardedMerge(id, legalStatuses, build, event) {
    const record = await store.load(id);
    if (!record) return rejected(`Work product ${id} not found`);
    if (!legalStatuses.includes(record.status)) {
      return rejected(`Work product ${id} is ${record.status}; expected ${legalStatuses.join("/")}`);
    }
    const updated = await store.update(
      id,
      { status: record.status, version: record.version },
      { updatedAt: now(), ...build(record) }
    );
    if (!updated) return lostRace(id);
    await appendEvent(updated, event.step, event.message(updated), event.metadata?.(updated) ?? {});
    return { succeeded: true, value: updated };
  }
  const create = async (input) => {
    const at = now();
    const record = await store.insert(
      {
        id: input.id ?? generateId(),
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        scopeKey: input.scopeKey,
        status: "draft",
        version: input.version ?? 1,
        artifact: null,
        evidence: [],
        exceptions: [],
        checks: [],
        provenance: input.provenance,
        history: [],
        createdAt: at,
        updatedAt: at
      },
      input.extras
    );
    await appendEvent(record, "wp.created", `Work product draft v${record.version} created for ${record.scopeKey}`, {
      scopeKey: record.scopeKey,
      version: record.version,
      threadId: record.threadId
    });
    return record;
  };
  async function findByScopeAndStatus(workspaceId, scopeKey, status) {
    const rows = await store.listByWorkspace(workspaceId, { status: [status] });
    return rows.find((row) => row.scopeKey === scopeKey) ?? null;
  }
  const nextVersion = async (workspaceId, scopeKey) => {
    const reviewed = await store.listByWorkspace(workspaceId, { status: ["approved", "superseded"] });
    const versions = reviewed.filter((row) => row.scopeKey === scopeKey).map((row) => row.version);
    return versions.length === 0 ? 1 : Math.max(...versions) + 1;
  };
  const reopen = async (id) => {
    const record = await store.load(id);
    if (!record) return rejected(`Work product ${id} not found`);
    if (record.status !== "changes_requested") {
      return rejected(`Work product ${id} is ${record.status}; only changes_requested reopens`);
    }
    const updated = await store.update(
      id,
      { status: "changes_requested", version: record.version },
      { status: "draft", version: record.version + 1, updatedAt: now() }
    );
    if (!updated) return lostRace(id);
    await appendEvent(updated, "wp.reopened", `Correction draft v${updated.version} opened`, {
      from: record.version,
      to: updated.version
    });
    return { succeeded: true, value: updated };
  };
  const upsertEvidence = (id, entries) => guardedMerge(
    id,
    ["draft", "blocked"],
    (record) => ({ evidence: mergeEvidence(record.evidence, entries) }),
    {
      step: "wp.evidence",
      message: (record) => `Evidence upserted (${entries.length} entries, ${record.evidence.length} total)`,
      metadata: () => ({ upserted: entries.map((entry) => entry.id) })
    }
  );
  const upsertExceptions = async (id, entries) => {
    const merged = await guardedMerge(
      id,
      ["draft", "blocked"],
      (record2) => ({ exceptions: mergeById(record2.exceptions, entries) }),
      {
        step: "wp.exception",
        message: (record2) => `Exceptions upserted (${entries.length} entries, ${unresolvedBlockingExceptions(record2.exceptions).length} blocking unresolved)`,
        metadata: () => ({ upserted: entries.map((entry) => entry.id) })
      }
    );
    if (!merged.succeeded) return merged;
    const record = merged.value;
    const blocking = unresolvedBlockingExceptions(record.exceptions).length;
    if (record.status === "draft" && blocking > 0) {
      return transition(id, "blocked", {}, { blocking });
    }
    if (record.status === "blocked" && blocking === 0) {
      return transition(id, "draft", {}, { blocking });
    }
    return merged;
  };
  const recordChecks = (id, checks) => guardedMerge(
    id,
    ["draft", "blocked"],
    () => ({ checks: checks.slice() }),
    {
      step: "wp.checks",
      message: () => `Checks recorded (${checks.length}, ${checks.filter((check) => !check.passed).length} failed)`,
      metadata: () => ({ failed: checks.filter((check) => !check.passed).map((check) => check.name) })
    }
  );
  const submit = async (id, input) => {
    const record = await store.load(id);
    if (!record) return rejected(`Work product ${id} not found`);
    if (record.status !== "draft") {
      return rejected(`Work product ${id} is ${record.status}; only a draft submits`);
    }
    const blocking = unresolvedBlockingExceptions(record.exceptions);
    if (blocking.length > 0) {
      return rejected(
        `Work product ${id} has ${blocking.length} unresolved blocking exception(s): ${blocking.map((entry2) => entry2.id).join(", ")}`
      );
    }
    const artifactPath = input.artifactPath ?? input.artifact.path;
    const entry = {
      version: record.version,
      status: "ready",
      provenance: input.provenance,
      ...artifactPath === void 0 ? {} : { artifactPath },
      at: now()
    };
    return transition(
      id,
      "ready",
      {
        artifact: input.artifact,
        checks: input.checks.slice(),
        provenance: input.provenance,
        history: [...record.history, entry]
      },
      { version: record.version, failedChecks: input.checks.filter((check) => !check.passed).length }
    );
  };
  const applyVerdict = async (id, input) => {
    const record = await store.load(id);
    if (!record) return rejected(`Work product ${id} not found`);
    if (record.status !== "ready") {
      return rejected(`Work product ${id} is ${record.status}; a verdict applies only to ready`);
    }
    const to = input.verdict === "approve" ? "approved" : "changes_requested";
    const entry = {
      version: record.version,
      status: to,
      provenance: record.provenance,
      ...record.artifact?.path === void 0 ? {} : { artifactPath: record.artifact.path },
      reviewedBy: input.reviewedBy,
      ...input.note === void 0 ? {} : { reviewNote: input.note },
      at: now()
    };
    const outcome = await transition(
      id,
      to,
      { history: [...record.history, entry] },
      { verdict: input.verdict, reviewedBy: input.reviewedBy }
    );
    if (!outcome.succeeded || to !== "approved") return outcome;
    const priorApproved = await store.listByWorkspace(record.workspaceId, { status: ["approved"] });
    for (const prior of priorApproved) {
      if (prior.id === id || prior.scopeKey !== record.scopeKey) continue;
      await transition(prior.id, "superseded", {}, { supersededBy: id });
    }
    return outcome;
  };
  return {
    create,
    get: (id) => store.load(id),
    openDraft: (workspaceId, scopeKey) => store.findDraft(workspaceId, scopeKey),
    awaitingCorrection: (workspaceId, scopeKey) => findByScopeAndStatus(workspaceId, scopeKey, "changes_requested"),
    awaitingReview: (workspaceId, scopeKey) => findByScopeAndStatus(workspaceId, scopeKey, "ready"),
    nextVersion,
    reopen,
    upsertEvidence,
    upsertExceptions,
    recordChecks,
    submit,
    applyVerdict,
    supersede: (id) => transition(id, "superseded")
  };
}
function createInMemoryWorkProductStore() {
  const rows = /* @__PURE__ */ new Map();
  const events = [];
  return {
    async load(id) {
      const record = rows.get(id);
      return record ? structuredClone(record) : null;
    },
    async findDraft(workspaceId, scopeKey) {
      for (const record of rows.values()) {
        if (record.workspaceId === workspaceId && record.scopeKey === scopeKey && (record.status === "draft" || record.status === "blocked")) {
          return structuredClone(record);
        }
      }
      return null;
    },
    async listByWorkspace(workspaceId, opts) {
      const out = [];
      for (const record of rows.values()) {
        if (record.workspaceId !== workspaceId) continue;
        if (opts?.status && !opts.status.includes(record.status)) continue;
        out.push(structuredClone(record));
      }
      return out;
    },
    async insert(record) {
      if (rows.has(record.id)) throw new Error(`Work product ${record.id} already exists`);
      rows.set(record.id, structuredClone(record));
      return structuredClone(record);
    },
    async update(id, guard, patch) {
      const current = rows.get(id);
      if (!current) return null;
      if (guard.status !== void 0 && current.status !== guard.status) return null;
      if (guard.version !== void 0 && current.version !== guard.version) return null;
      const next = { ...current };
      if (patch.status !== void 0) next.status = patch.status;
      if (patch.version !== void 0) next.version = patch.version;
      if (patch.artifact !== void 0) next.artifact = patch.artifact;
      if (patch.evidence !== void 0) next.evidence = patch.evidence;
      if (patch.exceptions !== void 0) next.exceptions = patch.exceptions;
      if (patch.checks !== void 0) next.checks = patch.checks;
      if (patch.provenance !== void 0) next.provenance = patch.provenance;
      if (patch.history !== void 0) next.history = patch.history;
      if (patch.updatedAt !== void 0) next.updatedAt = patch.updatedAt;
      rows.set(id, structuredClone(next));
      return structuredClone(next);
    },
    async appendEvent(event) {
      events.push(structuredClone(event));
    },
    events() {
      return events.map((event) => structuredClone(event));
    },
    put(record) {
      rows.set(record.id, structuredClone(record));
    }
  };
}

// src/work-product/provenance.ts
function stampProvenance(base, now = Date.now) {
  return { ...base, servingModels: [], producedAt: now() };
}
async function finalizeWorkProductProvenance(store, input) {
  const rows = await store.listByWorkspace(input.workspaceId);
  const updated = [];
  for (const record of rows) {
    const recordMatches = record.provenance.runId === input.runId;
    const historyMatches = record.history.some((entry) => entry.provenance.runId === input.runId);
    if (!recordMatches && !historyMatches) continue;
    const finalize = (provenance) => ({
      ...provenance,
      servingModels: [...input.servingModels],
      ...input.costUsd === void 0 ? {} : { costUsd: input.costUsd }
    });
    const next = await store.update(
      record.id,
      { status: record.status, version: record.version },
      {
        ...recordMatches ? { provenance: finalize(record.provenance) } : {},
        history: record.history.map(
          (entry) => entry.provenance.runId === input.runId ? { ...entry, provenance: finalize(entry.provenance) } : entry
        )
      }
    );
    if (!next) {
      input.logger?.warn(`[work-product] provenance back-fill lost a race on ${record.id}; skipped`);
      continue;
    }
    await store.appendEvent({
      workProductId: record.id,
      workspaceId: record.workspaceId,
      step: "wp.provenance",
      message: `Serving models back-filled for run ${input.runId}`,
      metadata: { runId: input.runId, servingModels: [...input.servingModels], costUsd: input.costUsd ?? null },
      at: Date.now()
    });
    updated.push(next);
  }
  return updated;
}
function workProductTrustInputs(records, verdictsFor) {
  const items = [];
  for (const record of records) {
    const verdicts = verdictsFor(record);
    if (!verdicts || verdicts.length === 0) continue;
    items.push({ itemId: record.id, verdicts });
  }
  return items;
}

// src/work-product/quote.ts
var WHITESPACE = /[\s\p{Zs}\u2028\u2029\u200b-\u200d\ufeff]+/gu;
var DASHES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/gu;
var SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032\u2035\u00b4`]/gu;
var DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033\u2036\u00ab\u00bb]/gu;
function normalizeQuoteText(value) {
  return value.normalize("NFKC").replace(DASHES, "-").replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(WHITESPACE, " ").trim();
}
function sourceContainsQuote(sourceText, quote) {
  const trimmed = quote.trim();
  if (trimmed.length === 0) return false;
  if (sourceText.includes(trimmed)) return true;
  const normalizedQuote = normalizeQuoteText(quote);
  if (normalizedQuote.length === 0) return false;
  return normalizeQuoteText(sourceText).includes(normalizedQuote);
}
var MIN_NEEDLE_LENGTH = 3;
var MAX_AMBIGUOUS_MATCHES = 8;
function lineAround(text, index) {
  let start = text.lastIndexOf("\n", index);
  start = start < 0 ? 0 : start + 1;
  let end = text.indexOf("\n", index);
  if (end < 0) end = text.length;
  if (end > start && text[end - 1] === "\r") end -= 1;
  return { start, end };
}
function findSourceLine(sourceText, needle, occurrence = 1) {
  const trimmed = needle.trim();
  if (trimmed.length === 0) return { ok: false, failure: { reason: "blank_needle" } };
  if (trimmed.length < MIN_NEEDLE_LENGTH) {
    return { ok: false, failure: { reason: "not_distinctive", needle: trimmed, found: 0 } };
  }
  const eachLine = (visit) => {
    let cursor = 0;
    while (cursor <= sourceText.length) {
      const bound2 = lineAround(sourceText, cursor);
      visit(bound2, sourceText.slice(bound2.start, bound2.end));
      if (bound2.end >= sourceText.length) break;
      cursor = bound2.end + 1;
    }
  };
  const positions = [];
  const wantedValue = canonicalizeValue(trimmed);
  if (wantedValue !== null) {
    eachLine((bound2, line) => {
      if (valuesInText(line).includes(wantedValue)) positions.push(bound2.start);
    });
  } else {
    for (let at = sourceText.indexOf(trimmed); at >= 0; at = sourceText.indexOf(trimmed, at + 1)) {
      positions.push(at);
    }
    if (positions.length === 0) {
      const wanted = normalizeQuoteText(trimmed);
      if (wanted.length > 0) {
        eachLine((bound2, line) => {
          if (normalizeQuoteText(line).includes(wanted)) positions.push(bound2.start);
        });
      }
    }
  }
  if (positions.length === 0) return { ok: false, failure: { reason: "not_found" } };
  if (occurrence === 1 && positions.length > MAX_AMBIGUOUS_MATCHES) {
    return { ok: false, failure: { reason: "not_distinctive", needle: trimmed, found: positions.length } };
  }
  if (occurrence < 1 || occurrence > positions.length) {
    return { ok: false, failure: { reason: "occurrence_out_of_range", found: positions.length } };
  }
  const bound = lineAround(sourceText, positions[occurrence - 1]);
  const quote = sourceText.slice(bound.start, bound.end);
  if (quote.trim().length === 0) return { ok: false, failure: { reason: "not_found" } };
  return { ok: true, span: bound, quote, occurrences: positions.length };
}
function sliceSourceSpan(sourceText, span) {
  for (const field of ["start", "end"]) {
    const value = span[field];
    if (!Number.isInteger(value)) return { ok: false, failure: { reason: "not_integer", field } };
    if (value < 0) return { ok: false, failure: { reason: "negative", field } };
  }
  if (span.end <= span.start) return { ok: false, failure: { reason: "inverted" } };
  if (span.end > sourceText.length) {
    return { ok: false, failure: { reason: "out_of_range", totalChars: sourceText.length } };
  }
  const quote = sourceText.slice(span.start, span.end);
  if (quote.trim().length === 0) return { ok: false, failure: { reason: "blank" } };
  return { ok: true, quote };
}

// src/work-product/tools.ts
var MAX_WORK_PRODUCT_BATCH = 50;
var EVIDENCE_COVERAGE_CHECK = "evidence_coverage";
var QUOTE_VERIFICATION_CHECK = "quote_verification";
var CLAIM_SUPPORT_CHECK = "claim_support";
var TARGET_CORRECTNESS_CHECK = "target_correctness";
var ARTIFACT_AGREEMENT_CHECK = "artifact_agreement";
async function unwrap(run, code) {
  let outcome = await run();
  if (!outcome.succeeded && outcome.conflict) outcome = await run();
  if (!outcome.succeeded) throw new ToolInputError(code, outcome.error, outcome.conflict ? 409 : 400);
  return outcome.value;
}
function requireScopeKey(args) {
  const scopeKey = typeof args.scopeKey === "string" ? args.scopeKey.trim() : "";
  if (!scopeKey) throw new ToolInputError("missing_scope_key", "scopeKey is required \u2014 the engagement key this work product belongs to.");
  return scopeKey;
}
function requireBatch(args, field) {
  const raw = args[field];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolInputError("missing_entries", `${field} must be a non-empty array.`);
  }
  if (raw.length > MAX_WORK_PRODUCT_BATCH) {
    throw new ToolInputError("batch_too_large", `${field} accepts at most ${MAX_WORK_PRODUCT_BATCH} entries per call \u2014 send smaller batches.`);
  }
  return raw;
}
async function resolveDraft(service, config, scopeKey, ctx) {
  const open = await service.openDraft(ctx.workspaceId, scopeKey);
  if (open) return open;
  const awaitingReview = await service.awaitingReview(ctx.workspaceId, scopeKey);
  if (awaitingReview) {
    throw new ToolInputError(
      "awaiting_review",
      `Work product for ${scopeKey} (v${awaitingReview.version}) is awaiting review \u2014 no further emission until a reviewer verdict.`,
      409
    );
  }
  const awaitingCorrection = await service.awaitingCorrection(ctx.workspaceId, scopeKey);
  if (awaitingCorrection) {
    return unwrap(() => service.reopen(awaitingCorrection.id), "reopen_failed");
  }
  return service.create({
    workspaceId: ctx.workspaceId,
    threadId: ctx.threadId,
    scopeKey,
    version: await service.nextVersion(ctx.workspaceId, scopeKey),
    provenance: stampProvenance(config.provenance(ctx), config.now)
  });
}
function spanErrorDetail(failure) {
  switch (failure.reason) {
    case "not_integer":
      return `${failure.field} must be a whole character offset.`;
    case "negative":
      return `${failure.field} must not be negative.`;
    case "inverted":
      return "end must be greater than start \u2014 the range is half-open [start, end).";
    case "out_of_range":
      return `end is past the end of the document, which is ${failure.totalChars} characters. Offsets are absolute in the whole document: when you read with an offset, add that offset to the position within the returned text.`;
    case "blank":
      return "that range is only whitespace. Widen it to the characters that carry the value.";
  }
}
function findErrorDetail(failure, needle) {
  switch (failure.reason) {
    case "blank_needle":
      return "the value to locate is empty.";
    case "not_found":
      return `${JSON.stringify(needle)} does not occur in that document. Read it again and cite a value it actually contains, or \u2014 if this figure is COMPUTED rather than read \u2014 omit the locator and state the computation in claim.`;
    case "occurrence_out_of_range":
      return `that value occurs ${failure.found} time(s) in the document; findOccurrence is out of range.`;
    case "not_distinctive":
      return failure.found === 0 ? `${JSON.stringify(failure.needle)} is too short to identify a place in the document \u2014 a digit or two matches somewhere in almost any text. Cite the labelled line instead (for example "Box 1   Wages, tips, other compensation ......... 128,450.00"). If the document does not state this value at all, omit the locator and say so in claim rather than pointing at an unrelated line.` : `${JSON.stringify(failure.needle)} occurs ${failure.found} times, so it names no particular place. Cite a longer stretch of the supporting line, or pass findOccurrence to say which one you mean.`;
  }
}
async function resolveEvidenceQuotes(config, entries, ctx) {
  const readSourceText = config.readSourceText;
  const texts = /* @__PURE__ */ new Map();
  const readText = async (ref) => {
    if (!texts.has(ref)) texts.set(ref, await readSourceText(ref, ctx));
    return texts.get(ref) ?? null;
  };
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const find = entry.locator.find;
    const span = entry.locator.span;
    const quote = entry.locator.quote;
    if (find !== void 0) {
      if (!readSourceText) {
        throw new ToolInputError(
          "span_unsupported",
          `entries[${index}].locator.find: this deployment cannot read source text, so a value cannot be located. Record the entry without locator.find.`,
          500
        );
      }
      const text2 = await readText(entry.sourceRef);
      if (text2 === null) {
        throw new ToolInputError(
          "unverifiable_quote",
          `entries[${index}].locator.find: "${entry.sourceRef}" has no readable text, so the value cannot be located. Record the entry without a locator and state the basis in claim.`
        );
      }
      const located = findSourceLine(text2, find, entry.locator.findOccurrence ?? 1);
      if (!located.ok) {
        throw new ToolInputError(
          "value_not_found",
          `entries[${index}].locator.find into "${entry.sourceRef}": ${findErrorDetail(located.failure, find)}`
        );
      }
      entry.locator.span = located.span;
      entry.locator.quote = located.quote;
      entry.locator.quoteBasis = "span";
      continue;
    }
    if (span) {
      if (!readSourceText) {
        throw new ToolInputError(
          "span_unsupported",
          `entries[${index}].locator.span: this deployment cannot read source text, so a span cannot be resolved into a quote. Record the entry without locator.span.`,
          500
        );
      }
      const text2 = await readText(entry.sourceRef);
      if (text2 === null) {
        throw new ToolInputError(
          "unverifiable_quote",
          `entries[${index}].locator.span: "${entry.sourceRef}" has no readable text, so the span cannot be resolved. Record the entry without locator.span or locator.quote and state the basis in claim.`
        );
      }
      const sliced = sliceSourceSpan(text2, span);
      if (!sliced.ok) {
        throw new ToolInputError(
          "invalid_span",
          `entries[${index}].locator.span [${span.start}, ${span.end}) into "${entry.sourceRef}": ${spanErrorDetail(sliced.failure)}`
        );
      }
      entry.locator.quote = sliced.quote;
      entry.locator.quoteBasis = "span";
      continue;
    }
    if (quote === void 0 || quote.trim().length === 0) continue;
    if (!readSourceText) continue;
    const text = await readText(entry.sourceRef);
    if (text === null) {
      throw new ToolInputError(
        "unverifiable_quote",
        `entries[${index}].locator.quote: "${entry.sourceRef}" has no readable text, so the quote cannot be verified. Record the entry without locator.quote and state the basis in claim.`
      );
    }
    if (!sourceContainsQuote(text, quote)) {
      throw new ToolInputError(
        "quote_not_found",
        `entries[${index}].locator.quote: ${JSON.stringify(quote)} does not occur in "${entry.sourceRef}". Cite locator.find instead \u2014 the value as it appears in the document \u2014 and this platform locates it and writes the quote itself, so the text is right by construction. If the value is COMPUTED rather than read, omit both and state the computation in claim.`
      );
    }
    entry.locator.quoteBasis = "model";
  }
}
function assertClaimsSupported(config, entries) {
  if (config.verifyClaimSupport === false) return;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const quote = entry.locator.quote;
    if (quote === void 0) continue;
    const support = verifyClaimSupport(quote, entry.claim);
    if (support.status !== "unsupported") continue;
    throw new ToolInputError(
      "claim_not_supported",
      `entries[${index}].claim ${JSON.stringify(entry.claim)} is not supported by the text it cites in "${entry.sourceRef}": ${claimSupportErrorDetail(support, quote)}`
    );
  }
}
function assertTargetsNotCrossed(config, entries) {
  const groups = config.confusableTargets;
  if (!groups || groups.length === 0) return;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const quote = entry.locator.quote;
    if (quote === void 0) continue;
    const verdict = verifyTargetLabel(quote, entry.target, groups);
    if (verdict.status !== "crossed") continue;
    throw new ToolInputError(
      "target_crossed",
      `entries[${index}] is attached to ${entry.target} but ${targetLabelErrorDetail(verdict, entry.target, quote)}`
    );
  }
}
async function summarizeQuoteVerification(config, evidence, ctx) {
  const readSourceText = config.readSourceText;
  if (!readSourceText) return void 0;
  const texts = /* @__PURE__ */ new Map();
  let verified = 0;
  let spanAnchored = 0;
  let withoutQuote = 0;
  const failed = [];
  for (const entry of evidence) {
    const quote = entry.locator.quote;
    if (quote === void 0 || quote.trim().length === 0) {
      withoutQuote += 1;
      continue;
    }
    if (!texts.has(entry.sourceRef)) texts.set(entry.sourceRef, await readSourceText(entry.sourceRef, ctx));
    const text = texts.get(entry.sourceRef);
    if (typeof text !== "string") {
      failed.push(entry.id);
      continue;
    }
    const span = entry.locator.span;
    if (span) {
      const sliced = sliceSourceSpan(text, span);
      if (sliced.ok && sliced.quote === quote) {
        verified += 1;
        spanAnchored += 1;
      } else failed.push(entry.id);
      continue;
    }
    if (sourceContainsQuote(text, quote)) verified += 1;
    else failed.push(entry.id);
  }
  return { verified, spanAnchored, withoutQuote, failed };
}
function summarizeClaimSupport(evidence) {
  let supported = 0;
  let checkable = 0;
  const unsupported = [];
  for (const entry of evidence) {
    const quote = entry.locator.quote;
    if (quote === void 0) continue;
    const support = verifyClaimSupport(quote, entry.claim);
    if (support.status === "not_applicable") continue;
    checkable += 1;
    if (support.status === "supported") supported += 1;
    else unsupported.push(entry.id);
  }
  return { supported, checkable, unsupported };
}
function summarizeTargetCorrectness(evidence, groups, targetOf) {
  let correct = 0;
  let checkable = 0;
  const crossed = [];
  for (const entry of evidence) {
    const quote = entry.locator.quote;
    if (quote === void 0) continue;
    const target = targetOf(entry);
    const verdict = verifyTargetLabel(quote, target, groups);
    if (verdict.status === "not_applicable") continue;
    checkable += 1;
    if (verdict.status === "identified") correct += 1;
    else crossed.push({ id: entry.id, detail: `${entry.id} (${target} cites the ${verdict.rival} line)` });
  }
  return { correct, checkable, crossed };
}
function summarizeArtifactAgreement(evidence, fieldValues, targetOf) {
  let agreeing = 0;
  let checkable = 0;
  const contradicting = [];
  for (const entry of evidence) {
    const target = targetOf(entry);
    const agreement = verifyArtifactAgreement(target, entry.claim, fieldValues);
    if (agreement.status === "not_applicable") continue;
    checkable += 1;
    if (agreement.status === "agrees") agreeing += 1;
    else {
      contradicting.push({ id: entry.id, detail: `${entry.id}: ${artifactAgreementErrorDetail(agreement, target)}` });
    }
  }
  return { agreeing, checkable, contradicting };
}
function buildWorkProductTools(config) {
  const service = createWorkProductService({
    store: config.store,
    ...config.now ? { now: config.now } : {},
    ...config.generateId ? { generateId: config.generateId } : {}
  });
  const canResolveTextLocators = config.readSourceText !== void 0;
  const locatorProperties = {
    page: { type: "number" },
    range: { type: "string", description: "Free-form location: 'L120-L134' | 'B7' | '\xB64'." },
    ...canResolveTextLocators ? {
      find: {
        type: "string",
        description: 'PREFERRED \u2014 use this whenever the value was READ from a document. The value exactly as it appears in the source (for example "128,450.00"), or a short distinctive phrase from the supporting line. The platform LOCATES it, cites the whole line it sits on, and returns that line to you. You do not retype the quote and you do not compute character offsets \u2014 so the citation can neither be invented nor land on the wrong line. If the value is not in the document, the entry is refused.'
      },
      findOccurrence: {
        type: "integer",
        minimum: 1,
        description: "Which occurrence of `find` to cite when the value appears more than once. Defaults to the first."
      },
      span: {
        type: "object",
        description: "Only when you have exact character offsets from a tool that computed them. Absolute offsets into the whole document: start is the first character, end is one past the last. Prefer `find` \u2014 offsets computed by hand land on the wrong line.",
        properties: {
          start: { type: "integer", minimum: 0 },
          end: { type: "integer", minimum: 1 }
        },
        required: ["start", "end"],
        additionalProperties: false
      }
    } : {},
    quote: {
      type: "string",
      description: canResolveTextLocators ? "Fallback for sources that cannot give you character offsets: the supporting text copied character-for-character. The platform checks it occurs in the document and REFUSES the entry if it does not. Prefer span. For a value you COMPUTED rather than read, omit both and state the computation in claim." : "Supporting text copied character-for-character from the source. This deployment cannot locate values or resolve character spans. For a value you COMPUTED rather than read, omit the locator and state the computation in claim."
    }
  };
  const upsertEvidence = defineAppTool({
    name: "upsert_evidence",
    description: canResolveTextLocators ? "Record source\u2192field lineage for the current work product, incrementally as you find it. Each entry links a source document (sourceRef + locator) to one artifact target and states the claim it supports. Cite by locator.find \u2014 the value exactly as it appears in the document \u2014 and the platform locates it and writes the supporting quote for you. Re-emitting an entry id replaces that entry. Address the work product by scopeKey; the first call creates the draft." : "Record source\u2192field lineage for the current work product, incrementally as you find it. Each entry links a source document (sourceRef + locator) to one artifact target and states the claim it supports. Cite with locator.quote when the source states the claim. This deployment cannot locate values or resolve character spans. Re-emitting an entry id replaces that entry. Address the work product by scopeKey; the first call creates the draft.",
    parameters: {
      type: "object",
      properties: {
        scopeKey: { type: "string", description: "Engagement key for this work product." },
        entries: {
          type: "array",
          minItems: 1,
          maxItems: MAX_WORK_PRODUCT_BATCH,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable entry id \u2014 re-emit to replace." },
              sourceRef: { type: "string", description: "Vault path / attachment id of the SOURCE document." },
              locator: {
                type: "object",
                properties: locatorProperties,
                additionalProperties: false
              },
              target: { type: "string", description: "Artifact field/claim this evidence supports." },
              claim: { type: "string", description: "The value/assertion at the target." },
              confidence: { type: "number", minimum: 0, maximum: 1 }
            },
            required: ["id", "sourceRef", "target", "claim"]
          }
        }
      },
      required: ["scopeKey", "entries"]
    },
    async execute(args, ctx) {
      const scopeKey = requireScopeKey(args);
      const raw = requireBatch(args, "entries");
      const entries = [];
      for (let index = 0; index < raw.length; index += 1) {
        const parsed = parseEvidenceInput(raw[index], `entries[${index}]`);
        if (!parsed.ok) throw new ToolInputError("invalid_evidence", `${parsed.field}: ${parsed.error}`);
        if (config.normalizeTarget) parsed.value.target = config.normalizeTarget(parsed.value.target);
        entries.push(parsed.value);
      }
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (!await config.resolveSourceRef(entry.sourceRef, ctx)) {
          throw new ToolInputError(
            "unknown_source_ref",
            `entries[${index}].sourceRef: "${entry.sourceRef}" does not resolve to an existing source document.`
          );
        }
      }
      await resolveEvidenceQuotes(config, entries, ctx);
      assertClaimsSupported(config, entries);
      assertTargetsNotCrossed(config, entries);
      const draft = await resolveDraft(service, config, scopeKey, ctx);
      const record = await unwrap(() => service.upsertEvidence(draft.id, entries), "evidence_rejected");
      return {
        workProductId: record.id,
        version: record.version,
        evidenceCount: record.evidence.length,
        // Echo what was actually STORED for the entries in this call. A span
        // citation's quote is produced here, not sent here, so the model must
        // be able to see the text its offsets selected — that is how it
        // notices an off-by-a-line span without a second read.
        entries: entries.map((entry) => ({
          id: entry.id,
          target: entry.target,
          ...entry.locator.quote === void 0 ? {} : { quote: entry.locator.quote },
          ...entry.locator.quoteBasis === void 0 ? {} : { quoteBasis: entry.locator.quoteBasis }
        }))
      };
    }
  });
  const flagException = defineAppTool({
    name: "flag_exception",
    description: "Flag problems with the current work product (missing documents, inconsistent sources, \u2026). An unresolved blocking exception parks the work product until it is resolved; re-emit the same id with resolved:true to release it. Address by scopeKey.",
    parameters: {
      type: "object",
      properties: {
        scopeKey: { type: "string", description: "Engagement key for this work product." },
        exceptions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_WORK_PRODUCT_BATCH,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable entry id \u2014 re-emit to replace." },
              severity: { type: "string", enum: ["blocking", "material", "advisory"] },
              kind: { type: "string", description: "Exception kind from the product vocabulary." },
              message: { type: "string" },
              targets: { type: "array", items: { type: "string" } },
              resolved: { type: "boolean" },
              resolutionNote: { type: "string" }
            },
            required: ["id", "severity", "kind", "message"]
          }
        }
      },
      required: ["scopeKey", "exceptions"]
    },
    async execute(args, ctx) {
      const scopeKey = requireScopeKey(args);
      const raw = requireBatch(args, "exceptions");
      const entries = [];
      for (let index = 0; index < raw.length; index += 1) {
        const parsed = parseExceptionInput(raw[index], `exceptions[${index}]`);
        if (!parsed.ok) throw new ToolInputError("invalid_exception", `${parsed.field}: ${parsed.error}`);
        if (!config.exceptionKinds.includes(parsed.value.kind)) {
          throw new ToolInputError(
            "invalid_exception",
            `exceptions[${index}].kind: must be one of: ${config.exceptionKinds.join(", ")}`
          );
        }
        if (parsed.value.resolved && parsed.value.resolvedBy === void 0) parsed.value.resolvedBy = "agent";
        entries.push(parsed.value);
      }
      const draft = await resolveDraft(service, config, scopeKey, ctx);
      const record = await unwrap(() => service.upsertExceptions(draft.id, entries), "exception_rejected");
      return {
        workProductId: record.id,
        version: record.version,
        status: record.status,
        unresolvedBlocking: unresolvedBlockingExceptions(record.exceptions).length
      };
    }
  });
  const submitWorkProduct = defineAppTool({
    name: "submit_work_product",
    description: "Submit the finished work product for professional review \u2014 the terminal call after evidence and exceptions are recorded. Refused while a blocking exception is unresolved, or when a material target lacks evidence. Include your own quality checks in `checks`.",
    parameters: {
      type: "object",
      properties: {
        scopeKey: { type: "string", description: "Engagement key for this work product." },
        artifact: {
          type: "object",
          properties: {
            kind: { type: "string", description: "Artifact kind from the product vocabulary." },
            title: { type: "string" },
            path: { type: "string", description: "Vault/object-store ref of the rendered document." },
            content: { type: "string", description: "Inline body when small (markdown/JSON)." },
            mediaType: { type: "string" },
            baseline: {
              type: "object",
              properties: { path: { type: "string" }, content: { type: "string" } },
              description: "For diff-first artifacts: the source document being redlined."
            },
            fields: { type: "object", description: "Structured field map lineage targets anchor to." }
          },
          required: ["kind", "title"]
        },
        checks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              passed: { type: "boolean" },
              detail: { type: "string" }
            },
            required: ["id", "name", "passed"]
          },
          description: "Your own quality self-checks (recorded as agent-sourced)."
        }
      },
      required: ["scopeKey", "artifact"]
    },
    async execute(args, ctx) {
      const scopeKey = requireScopeKey(args);
      const parsedArtifact = parseArtifactInput(args.artifact);
      if (!parsedArtifact.ok) throw new ToolInputError("invalid_artifact", `${parsedArtifact.field}: ${parsedArtifact.error}`);
      const artifact = parsedArtifact.value;
      if (!config.artifactKinds.includes(artifact.kind)) {
        throw new ToolInputError("invalid_artifact", `artifact.kind: must be one of: ${config.artifactKinds.join(", ")}`);
      }
      const agentChecks = [];
      if (args.checks !== void 0) {
        if (!Array.isArray(args.checks)) throw new ToolInputError("invalid_checks", "checks must be an array when present.");
        for (let index = 0; index < args.checks.length; index += 1) {
          const parsed = parseAgentCheckInput(args.checks[index], `checks[${index}]`);
          if (!parsed.ok) throw new ToolInputError("invalid_checks", `${parsed.field}: ${parsed.error}`);
          agentChecks.push({ ...parsed.value, source: "agent" });
        }
      }
      const draft = await resolveDraft(service, config, scopeKey, ctx);
      const blocking = unresolvedBlockingExceptions(draft.exceptions);
      if (blocking.length > 0) {
        throw new ToolInputError(
          "blocking_exceptions_unresolved",
          `Cannot submit: ${blocking.length} unresolved blocking exception(s) (${blocking.map((entry) => entry.id).join(", ")}). Resolve each via flag_exception with resolved:true, or downgrade its severity with a resolutionNote justifying why it does not block.`,
          409
        );
      }
      const checks = [...agentChecks];
      const quotes = await summarizeQuoteVerification(config, draft.evidence, ctx);
      if (quotes) {
        const quoted = quotes.verified + quotes.failed.length;
        checks.unshift({
          id: QUOTE_VERIFICATION_CHECK,
          name: QUOTE_VERIFICATION_CHECK,
          passed: quotes.failed.length === 0,
          detail: quotes.failed.length === 0 ? `${quotes.verified}/${quoted} quoted evidence entries verified against their source (${quotes.spanAnchored} platform-sliced from a source span, ${quotes.verified - quotes.spanAnchored} model-quoted and proved to occur); ${quotes.withoutQuote} recorded without a quote` : `Unverifiable quotes on: ${quotes.failed.join(", ")}`,
          source: "platform"
        });
        if (quotes.failed.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), "checks_rejected");
          throw new ToolInputError(
            "quote_verification_failed",
            `Cannot submit: ${quotes.failed.length} evidence entr${quotes.failed.length === 1 ? "y quotes" : "ies quote"} text that does not occur in the source named (${quotes.failed.join(", ")}). Re-emit each with a quote copied character-for-character from that document, or without locator.quote if the value is computed.`
          );
        }
      }
      if (config.verifyClaimSupport !== false) {
        const support = summarizeClaimSupport(draft.evidence);
        if (support.checkable > 0) checks.unshift({
          id: CLAIM_SUPPORT_CHECK,
          name: "Cited numeric values",
          passed: support.unsupported.length === 0,
          detail: support.unsupported.length > 0 ? `Cited text does not contain the claimed figure on: ${support.unsupported.join(", ")}` : `${support.supported}/${support.checkable} value-bearing citations anchor to text containing the claimed figure; does not verify prose claims`,
          source: "platform"
        });
        if (support.unsupported.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), "checks_rejected");
          throw new ToolInputError(
            "claim_not_supported",
            `Cannot submit: ${support.unsupported.length} evidence entr${support.unsupported.length === 1 ? "y cites" : "ies cite"} text that does not contain the figure claimed (${support.unsupported.join(", ")}). Re-emit each with locator.find set to the value exactly as it appears in the document, or without a locator if the figure was computed rather than read.`
          );
        }
      }
      const targetOf = (entry) => config.normalizeTarget ? config.normalizeTarget(entry.target) : entry.target;
      if (config.confusableTargets && config.confusableTargets.length > 0) {
        const crossing = summarizeTargetCorrectness(draft.evidence, config.confusableTargets, targetOf);
        checks.unshift({
          id: TARGET_CORRECTNESS_CHECK,
          name: TARGET_CORRECTNESS_CHECK,
          passed: crossing.crossed.length === 0,
          detail: crossing.crossed.length > 0 ? `Citations attached to the wrong target: ${crossing.crossed.map((item) => item.detail).join("; ")}` : crossing.checkable === 0 ? "No citation lands on a line this product can tell apart from a sibling target \u2014 nothing to check" : `${crossing.correct}/${crossing.checkable} citations land on a line belonging to their own target`,
          source: "platform"
        });
        if (crossing.crossed.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), "checks_rejected");
          throw new ToolInputError(
            "target_crossed",
            `Cannot submit: ${crossing.crossed.length} evidence entr${crossing.crossed.length === 1 ? "y cites" : "ies cite"} a line belonging to a different target \u2014 ${crossing.crossed.map((item) => item.detail).join("; ")}. Re-emit each against the target whose line it actually cites, or cite the line that belongs to the target it is attached to.`
          );
        }
      }
      const artifactValues = indexArtifactValues(artifact.fields, config.normalizeTarget);
      if (config.verifyArtifactAgreement !== false && artifactValues.size > 0) {
        const agreement = summarizeArtifactAgreement(draft.evidence, artifactValues, targetOf);
        checks.unshift({
          id: ARTIFACT_AGREEMENT_CHECK,
          name: ARTIFACT_AGREEMENT_CHECK,
          passed: agreement.contradicting.length === 0,
          detail: agreement.contradicting.length > 0 ? `Evidence contradicts the artifact on: ${agreement.contradicting.map((item) => item.detail).join("; ")}` : agreement.checkable === 0 ? "No evidence claim states a figure the artifact also states \u2014 nothing to check" : `${agreement.agreeing}/${agreement.checkable} evidence claims agree with the artifact field they support`,
          source: "platform"
        });
        if (agreement.contradicting.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), "checks_rejected");
          throw new ToolInputError(
            "contradicts_artifact",
            `Cannot submit: ${agreement.contradicting.length} evidence entr${agreement.contradicting.length === 1 ? "y contradicts" : "ies contradict"} the artifact they support \u2014 ${agreement.contradicting.map((item) => item.detail).join("; ")}. Move each citation to the target it actually supports, or correct the artifact. The package cannot state both.`
          );
        }
      }
      if (config.materialTargets) {
        const targets = [
          ...new Set(
            config.materialTargets(artifact).map((target) => config.normalizeTarget ? config.normalizeTarget(target) : target)
          )
        ];
        const covered = new Set(draft.evidence.map(targetOf));
        const missing = targets.filter((target) => !covered.has(target));
        const anchoredTargets = new Set(
          draft.evidence.filter((entry) => entry.locator.quoteBasis !== void 0).map(targetOf)
        );
        const spanTargets = new Set(
          draft.evidence.filter((entry) => entry.locator.quoteBasis === "span").map(targetOf)
        );
        const present = targets.filter((target) => covered.has(target));
        const unanchored = present.filter((target) => !anchoredTargets.has(target));
        const spanCount = present.filter((target) => spanTargets.has(target)).length;
        const breakdown = `${spanCount} span-anchored, ${present.length - spanCount - unanchored.length} quote-verified, ${unanchored.length} claim-only`;
        const coverage = {
          id: EVIDENCE_COVERAGE_CHECK,
          name: EVIDENCE_COVERAGE_CHECK,
          passed: missing.length === 0 && !(config.requireAnchoredEvidence && unanchored.length > 0),
          detail: missing.length > 0 ? `Missing evidence for: ${missing.join(", ")}` : config.requireAnchoredEvidence && unanchored.length > 0 ? `No source anchor for: ${unanchored.join(", ")}` : `${targets.length}/${targets.length} material targets evidenced (${breakdown}); checks declared evidence links, does not verify prose claims or artifact completeness`,
          source: "platform"
        };
        checks.unshift(coverage);
        if (missing.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), "checks_rejected");
          throw new ToolInputError(
            "evidence_coverage_failed",
            `Cannot submit: material targets lack evidence: ${missing.join(", ")}. Add upsert_evidence entries targeting each, then resubmit.`
          );
        }
        if (config.requireAnchoredEvidence && unanchored.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), "checks_rejected");
          throw new ToolInputError(
            "evidence_not_anchored",
            `Cannot submit: these material targets have an evidence row but no source anchor: ${unanchored.join(", ")}. Re-emit each with locator.find \u2014 the value exactly as it appears in the document. The platform locates it and writes the quote itself, so you never retype source text or count characters.`
          );
        }
      }
      const provenance = stampProvenance(config.provenance(ctx), config.now);
      const record = await unwrap(
        () => service.submit(draft.id, { artifact, checks, provenance }),
        "submit_rejected"
      );
      await config.onReady?.(record, ctx);
      return {
        workProductId: record.id,
        version: record.version,
        status: record.status,
        checks: record.checks.map((check) => ({ name: check.name, passed: check.passed, source: check.source, detail: check.detail }))
      };
    }
  });
  return [upsertEvidence, flagException, submitWorkProduct];
}

// src/work-product/route.ts
function validateWorkProductVerdictBody(body) {
  const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : null;
  if (!id) return { ok: false, error: "Missing work product id" };
  const verdict = body.verdict;
  if (verdict !== "approve" && verdict !== "request_changes") {
    return { ok: false, error: "Invalid verdict: expected approve or request_changes" };
  }
  const note = body.note === void 0 ? void 0 : typeof body.note === "string" ? body.note.trim() : null;
  if (note === null) return { ok: false, error: "Invalid note: expected a string" };
  if (verdict === "request_changes") {
    if (!note) return { ok: false, error: "request_changes requires a note \u2014 it becomes the correction instruction in chat" };
    return { ok: true, id, verdict, note };
  }
  return note ? { ok: true, id, verdict, note } : { ok: true, id, verdict };
}
function createWorkProductRoutes(options) {
  const logger = options.logger ?? console;
  const service = createWorkProductService({
    store: options.store,
    ...options.now ? { now: options.now } : {}
  });
  async function list(request) {
    const auth = await options.authorize({ request, intent: "list" });
    if (!auth.ok) return auth.response;
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const statuses = statusParam ? statusParam.split(",").map((value) => value.trim()).filter(Boolean) : null;
    const workProducts = await options.store.listByWorkspace(
      auth.workspaceId,
      statuses ? { status: statuses } : void 0
    );
    return Response.json({ workProducts });
  }
  async function detail(request, id) {
    const auth = await options.authorize({ request, intent: "detail" });
    if (!auth.ok) return auth.response;
    const record = await options.store.load(id);
    if (!record || record.workspaceId !== auth.workspaceId) {
      return Response.json({ error: "Work product not found" }, { status: 404 });
    }
    return Response.json({ workProduct: record });
  }
  async function verdict(request) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const validation = validateWorkProductVerdictBody(body);
    if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 });
    const auth = await options.authorize({ request, intent: "verdict", body });
    if (!auth.ok) return auth.response;
    const existing = await options.store.load(validation.id);
    if (!existing || existing.workspaceId !== auth.workspaceId) {
      return Response.json({ error: "Work product not found" }, { status: 404 });
    }
    const outcome = await service.applyVerdict(validation.id, {
      verdict: validation.verdict,
      reviewedBy: auth.reviewedBy,
      ...validation.note === void 0 ? {} : { note: validation.note }
    });
    if (!outcome.succeeded) {
      return Response.json({ code: "VERDICT_CONFLICT", error: outcome.error }, { status: 409 });
    }
    const record = outcome.value;
    try {
      await options.persistAnchorPart?.(workProductToPersistedPart(record), record);
    } catch (error) {
      logger.error("[work-product] persistAnchorPart failed:", error);
    }
    try {
      await options.onVerdict?.({
        record,
        verdict: validation.verdict,
        ...validation.note === void 0 ? {} : { note: validation.note },
        reviewedBy: auth.reviewedBy
      });
    } catch (error) {
      logger.error("[work-product] onVerdict failed:", error);
    }
    if (validation.verdict === "approve") {
      try {
        await options.onExport?.(record);
      } catch (error) {
        logger.error("[work-product] onExport failed:", error);
      }
    }
    return Response.json({ ok: true, workProduct: record });
  }
  return { list, detail, verdict };
}
export {
  ARTIFACT_AGREEMENT_CHECK,
  CLAIM_SUPPORT_CHECK,
  EVIDENCE_COVERAGE_CHECK,
  MAX_WORK_PRODUCT_BATCH,
  QUOTE_VERIFICATION_CHECK,
  TARGET_CORRECTNESS_CHECK,
  artifactAgreementErrorDetail,
  buildWorkProductTools,
  canTransitionWorkProduct,
  canonicalizeValue,
  claimSupportErrorDetail,
  claimValues,
  createInMemoryWorkProductStore,
  createWorkProductRoutes,
  createWorkProductService,
  finalizeWorkProductProvenance,
  findSourceLine,
  indexArtifactValues,
  isWorkProductStatus,
  isWorkProductTerminal,
  normalizeQuoteText,
  parseAgentCheckInput,
  parseArtifactInput,
  parseEvidenceInput,
  parseExceptionInput,
  parseReviewQueueItem,
  persistedPartToWorkProduct,
  projectReviewQueue,
  sliceSourceSpan,
  sourceContainsQuote,
  stampProvenance,
  targetLabelErrorDetail,
  unresolvedBlockingExceptions,
  validateWorkProductVerdictBody,
  valuesInText,
  verifyArtifactAgreement,
  verifyClaimSupport,
  verifyTargetLabel,
  workProductToPersistedPart,
  workProductTrustInputs
};
//# sourceMappingURL=index.js.map