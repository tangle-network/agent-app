// src/record/model.ts
function recordOk(value) {
  return { succeeded: true, value };
}
function recordFail(code, error) {
  return { succeeded: false, error, code };
}
var RECORD_KEY_SENTINEL = "";
var RECORD_PERIOD_SENTINEL = 0;
var RECORD_REVIEW_STATES = ["proposed", "accepted", "rejected"];
var KEY_SEPARATOR = "\0";
function recordKeyString(key) {
  return [key.dimension, key.path, key.itemKey, String(key.period)].join(KEY_SEPARATOR);
}
function canonicalRecordJson(value) {
  const encoded = JSON.stringify(sortKeysDeep(value));
  return encoded === void 0 ? "null" : encoded;
}
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const source = value;
    const out = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeysDeep(source[key]);
    return out;
  }
  return value;
}
function validateRecordValue(validator, value) {
  if (typeof validator === "function") return validator(value);
  const parsed = validator.safeParse(value);
  if (parsed.success) return recordOk(parsed.data);
  return recordFail("invalid-value", describeParseError(parsed.error));
}
function describeParseError(error) {
  if (error !== null && typeof error === "object") {
    const issues = error.issues;
    if (Array.isArray(issues)) {
      const messages = issues.map((issue) => issue !== null && typeof issue === "object" ? String(issue.message ?? "") : "").filter((message2) => message2.length > 0);
      if (messages.length > 0) return messages.join("; ");
    }
    const message = error.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}
var defaultRecordMaterialDifference = (head, incoming) => head.sourceKind !== incoming.sourceKind && (head.valueJson !== incoming.valueJson || head.affirmedEmpty !== incoming.affirmedEmpty);
function resolveWriteReviewState(policy, sourceKind) {
  const state = policy.reviewStateOnWrite[sourceKind];
  if (state === void 0) {
    const known = Object.keys(policy.reviewStateOnWrite).sort().join(", ");
    return recordFail(
      "unknown-source-kind",
      `source kind '${sourceKind}' is not declared in reviewStateOnWrite (declared: ${known || "none"})`
    );
  }
  return recordOk(state);
}
function detectRecordConflict(policy, head, incoming) {
  if (head === void 0) return false;
  return (policy.isMateriallyDifferent ?? defaultRecordMaterialDifference)(head, incoming);
}

// src/record/fold.ts
var defaultRecordPeriodScope = () => "exact";
function recordEntryVisibleInPeriod(scope, entryPeriod, requestedPeriod) {
  return scope === "carry-forward" ? entryPeriod <= requestedPeriod : entryPeriod === requestedPeriod;
}
function foldRecordEntries(entries, options) {
  const { rules } = options;
  const periodScope = rules.periodScope ?? defaultRecordPeriodScope;
  const period = options.period ?? RECORD_PERIOD_SENTINEL;
  if (!Number.isInteger(period)) {
    return recordFail("invalid-input", `foldRecordEntries: period must be an integer, got ${String(period)}`);
  }
  const carryHeads = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const scope = periodScope(entry.path);
    if (!recordEntryVisibleInPeriod(scope, entry.period, period)) continue;
    if (scope !== "carry-forward") continue;
    const key = carryKey(entry);
    const best = carryHeads.get(key);
    if (best === void 0 || entry.period > best) carryHeads.set(key, entry.period);
  }
  const resolved = entries.filter((entry) => {
    const scope = periodScope(entry.path);
    if (!recordEntryVisibleInPeriod(scope, entry.period, period)) return false;
    if (scope !== "carry-forward") return true;
    return carryHeads.get(carryKey(entry)) === entry.period;
  }).sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const draft = rules.init();
  for (const entry of resolved) {
    let value = null;
    if (!entry.affirmedEmpty) {
      try {
        value = JSON.parse(entry.valueJson);
      } catch {
        return recordFail("fold-failed", `foldRecordEntries: entry '${entry.id}' has unparseable valueJson`);
      }
    }
    const decoded = { ...entry, value };
    if (entry.affirmedEmpty) {
      if (!rules.retract) {
        return recordFail(
          "fold-failed",
          `foldRecordEntries: entry '${entry.id}' ('${entry.path}') is affirmedEmpty but the rules define no retract`
        );
      }
      const retracted = rules.retract(draft, decoded);
      if (!retracted.succeeded) {
        return recordFail("fold-failed", `foldRecordEntries: entry '${entry.id}' ('${entry.path}') \u2014 ${retracted.error}`);
      }
      continue;
    }
    const applied = rules.apply(draft, decoded);
    if (!applied.succeeded) {
      return recordFail("fold-failed", `foldRecordEntries: entry '${entry.id}' ('${entry.path}') \u2014 ${applied.error}`);
    }
  }
  if (rules.finalize) {
    const finalized = rules.finalize(draft);
    if (!finalized.succeeded) {
      return recordFail("fold-failed", `foldRecordEntries: finalize \u2014 ${finalized.error}`);
    }
  }
  return recordOk({ value: draft, entryCount: resolved.length });
}
function carryKey(entry) {
  return recordKeyString({
    dimension: entry.dimension,
    path: entry.path,
    itemKey: entry.itemKey,
    period: RECORD_PERIOD_SENTINEL
  });
}

// src/record/ulid.ts
var ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
var MAX_TIMESTAMP = 2 ** 48 - 1;
function recordUlid(now = Date.now()) {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIMESTAMP) {
    throw new Error(`recordUlid: timestamp out of range: ${now}`);
  }
  let time = now;
  const chars = new Array(26);
  for (let i = 9; i >= 0; i--) {
    chars[i] = ENCODING[time % 32];
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let buffer = 0;
  let bits = 0;
  let out = 10;
  for (const byte of bytes) {
    buffer = buffer << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      chars[out++] = ENCODING[buffer >>> bits - 5 & 31];
      bits -= 5;
    }
  }
  return chars.join("");
}

export {
  recordOk,
  recordFail,
  RECORD_KEY_SENTINEL,
  RECORD_PERIOD_SENTINEL,
  RECORD_REVIEW_STATES,
  recordKeyString,
  canonicalRecordJson,
  validateRecordValue,
  defaultRecordMaterialDifference,
  resolveWriteReviewState,
  detectRecordConflict,
  defaultRecordPeriodScope,
  recordEntryVisibleInPeriod,
  foldRecordEntries,
  recordUlid
};
//# sourceMappingURL=chunk-I24YIKHO.js.map