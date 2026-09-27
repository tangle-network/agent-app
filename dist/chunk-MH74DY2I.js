// src/redact/index.ts
var DEFAULT_REDACTION_PATTERNS = [
  { kind: "ssn", pattern: /\d{3}-\d{2}-\d{4}/ },
  { kind: "ein", pattern: /\d{2}-\d{7}/ }
];
var SENSITIVE_KEYS = /* @__PURE__ */ new Set([
  "ssn",
  "ein",
  "password",
  "apikey",
  "token",
  "secret",
  "authorization",
  "email",
  "phone"
]);
function redactString(value, patterns) {
  for (const { kind, pattern, validate } of patterns) {
    if (!validate) {
      const testPattern = /[gy]/.test(pattern.flags) ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")) : pattern;
      if (testPattern.test(value)) return `[REDACTED:${kind}]`;
      continue;
    }
    const g = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const m of value.matchAll(g)) {
      if (m[0].length > 0 && validate(m[0])) return `[REDACTED:${kind}]`;
    }
  }
  return value;
}
function maskSpans(text, patterns = DEFAULT_REDACTION_PATTERNS) {
  const spans = detectSpans(text, patterns);
  if (spans.length === 0) return text;
  let out = "";
  let pos = 0;
  for (const s of spans) {
    if (s.start > pos) out += text.slice(pos, s.start);
    out += `[REDACTED:${s.kind}]`;
    pos = s.end;
  }
  if (pos < text.length) out += text.slice(pos);
  return out;
}
var ERROR_SECRET_KEY = String.raw`(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token|security[_-]?token|x-amz-(?:credential|signature|security-token)|aws[_-]?access[_-]?key[_-]?id|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|api[_-]?key|client[_-]?secret|credential|token|secret|password|signature|sig|authorization)`;
var ERROR_SECRET_PATTERNS = [
  ...DEFAULT_REDACTION_PATTERNS,
  { kind: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { kind: "bearer", pattern: /Bearer\s+[^\s]+/i },
  { kind: "credential", pattern: /\b(?:sk|pk|tc|ghp|xoxb)[_-][A-Za-z0-9_-]{8,}\b/i },
  {
    kind: "credential",
    pattern: /["']?\b(?:cookie|set-cookie)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n}]*)/i
  },
  {
    kind: "credential",
    pattern: new RegExp(
      String.raw`["']?\b${ERROR_SECRET_KEY}\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?:Bearer|Basic)\s+[^\s,;&}"']+|[^\r\n,;&}]+?)(?=\s+(?:["']?\b[A-Za-z][A-Za-z0-9_-]*["']?\s*[:=]|(?:Bearer|Basic)\b)|\s*,\s*["']?\b[A-Za-z][A-Za-z0-9_-]*["']?\s*[:=]|\s*[,;&}]|\s*[\r\n]|$)`,
      "i"
    )
  }
];
function safeString(value) {
  try {
    return typeof value === "string" ? value : String(value);
  } catch {
    return void 0;
  }
}
function safeErrorText(input) {
  if (input !== null && (typeof input === "object" || typeof input === "function")) {
    try {
      const message = Reflect.get(input, "message");
      const messageText = safeString(message);
      if (messageText !== void 0) return messageText;
    } catch {
    }
  }
  return safeString(input) ?? "";
}
function redactErrorMessage(input, fallback = "unknown error") {
  const fallbackText = safeString(fallback)?.trim() || "unknown error";
  const raw = safeErrorText(input);
  const message = raw.trim() || fallbackText;
  try {
    const redacted = maskSpans(message, ERROR_SECRET_PATTERNS).trim();
    return redacted.length > 240 ? `${redacted.slice(0, 240)}\u2026` : redacted || fallbackText;
  } catch {
    return fallbackText;
  }
}
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function redactForIngestion(value, options = {}) {
  const patterns = options.extraPatterns ? [...DEFAULT_REDACTION_PATTERNS, ...options.extraPatterns] : DEFAULT_REDACTION_PATTERNS;
  const sensitiveKeys = options.extraSensitiveKeys ? /* @__PURE__ */ new Set([...SENSITIVE_KEYS, ...options.extraSensitiveKeys.map((k) => k.toLowerCase())]) : SENSITIVE_KEYS;
  const maskString = options.stringMode === "mask-spans" ? (s) => maskSpans(s, patterns) : (s) => redactString(s, patterns);
  const seen = /* @__PURE__ */ new WeakSet();
  const walk = (v) => {
    if (typeof v === "string") return maskString(v);
    if (Array.isArray(v)) {
      if (seen.has(v)) return v;
      seen.add(v);
      return v.map(walk);
    }
    if (isPlainObject(v)) {
      if (seen.has(v)) return v;
      seen.add(v);
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = sensitiveKeys.has(k.toLowerCase()) ? "[REDACTED:field]" : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}
function detectSpans(text, patterns = DEFAULT_REDACTION_PATTERNS) {
  const raw = [];
  for (const { kind, pattern, validate } of patterns) {
    const g = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const m of text.matchAll(g)) {
      if (m.index === void 0 || m[0].length === 0) continue;
      if (validate && !validate(m[0])) continue;
      raw.push({ kind, start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans = [];
  let cursor = -1;
  let i = 0;
  for (const s of raw) {
    if (s.start < cursor) continue;
    spans.push({ id: `span-${i++}`, ...s });
    cursor = s.end;
  }
  return spans;
}
async function buildRedactedDocument(text, options) {
  const spans = detectSpans(text, options.patterns);
  const segments = [];
  let pos = 0;
  for (const span of spans) {
    if (span.start > pos) segments.push({ type: "text", text: text.slice(pos, span.start) });
    segments.push({ type: "redacted", id: span.id, kind: span.kind, cipher: await options.encrypt(span.text) });
    pos = span.end;
  }
  if (pos < text.length) segments.push({ type: "text", text: text.slice(pos) });
  return { segments };
}
async function revealSpan(doc, spanId, options) {
  const seg = doc.segments.find(
    (s) => s.type === "redacted" && s.id === spanId
  );
  if (!seg) return { ok: false, reason: "not_found" };
  const allowed = await options.canReveal({ id: seg.id, kind: seg.kind });
  if (!allowed) return { ok: false, reason: "forbidden" };
  const value = await options.decrypt(seg.cipher);
  if (options.onReveal) await options.onReveal({ id: seg.id, kind: seg.kind });
  return { ok: true, value };
}

export {
  DEFAULT_REDACTION_PATTERNS,
  maskSpans,
  redactErrorMessage,
  redactForIngestion,
  detectSpans,
  buildRedactedDocument,
  revealSpan
};
//# sourceMappingURL=chunk-MH74DY2I.js.map