import {
  walkSources
} from "./chunk-EMLGWEHV.js";

// src/legibility/source.ts
var IDENT_START = /[A-Za-z_$]/;
var IDENT_PART = /[A-Za-z0-9_$.:-]/;
var JSX_PRECEDERS = /* @__PURE__ */ new Set(["(", "{", "}", "=", ",", ";", ":", "?", "&", "|", "!", "+", ">", "[", "\n"]);
var JSX_PRECEDING_WORDS = /* @__PURE__ */ new Set(["return", "yield", "case", "default", "in", "of", "typeof", "await"]);
function scanSource(text) {
  const segments = [];
  const elements = [];
  const mask = new Array(text.length);
  for (let i2 = 0; i2 < text.length; i2++) mask[i2] = text[i2];
  const blank = (from, to) => {
    for (let i2 = from; i2 < to && i2 < text.length; i2++) mask[i2] = text[i2] === "\n" ? "\n" : " ";
  };
  const stack = [{ kind: "code", depth: 0, element: null, containerStart: null }];
  const top = () => stack[stack.length - 1];
  const openElement = () => {
    for (let i2 = stack.length - 1; i2 >= 0; i2--) {
      const frame = stack[i2];
      if (frame.kind === "jsx-children" || frame.kind === "jsx-tag") return frame.element;
    }
    return null;
  };
  const containerOf = () => {
    for (let i2 = stack.length - 1; i2 >= 0; i2--) {
      const frame = stack[i2];
      if (frame.kind === "code") return frame.containerStart;
      if (frame.kind === "jsx-children" || frame.kind === "jsx-tag") return frame.element?.containerStart ?? null;
    }
    return null;
  };
  let i = 0;
  while (i < text.length) {
    const frame = top();
    if (frame.kind === "jsx-children") {
      i = readJsxChildren(i, frame);
      continue;
    }
    if (frame.kind === "jsx-tag") {
      i = readJsxTag(i, frame);
      continue;
    }
    if (frame.kind === "template") {
      i = readTemplateChunk(i);
      continue;
    }
    i = readCode(i, frame);
  }
  return { text, segments, elements, masked: mask.join("") };
  function readCode(at, frame) {
    const ch = text[at];
    if (ch === "/" && text[at + 1] === "/") {
      const end = indexOrEnd(text, "\n", at);
      segments.push({ kind: "comment", start: at + 2, end, value: text.slice(at + 2, end) });
      blank(at, end);
      return end;
    }
    if (ch === "/" && text[at + 1] === "*") {
      const close = text.indexOf("*/", at + 2);
      const end = close === -1 ? text.length : close + 2;
      segments.push({ kind: "comment", start: at + 2, end: end - 2, value: text.slice(at + 2, end - 2) });
      blank(at, end);
      return end;
    }
    if (ch === '"' || ch === "'") {
      const end = readQuoted(text, at, ch);
      segments.push({ kind: "string", start: at + 1, end: end - 1, value: text.slice(at + 1, end - 1) });
      blank(at + 1, end - 1);
      return end;
    }
    if (ch === "`") {
      stack.push({
        kind: "template",
        depth: 0,
        element: null,
        containerStart: containerOf(),
        templateAttribute: attributeOfTemplate(at + 1)
      });
      return at + 1;
    }
    if (ch === "/" && isRegexStart(text, at)) {
      return skipRegex(text, at);
    }
    if (ch === "{") {
      frame.depth++;
      return at + 1;
    }
    if (ch === "}") {
      if (frame.depth === 0 && stack.length > 1) {
        stack.pop();
        return at + 1;
      }
      frame.depth--;
      return at + 1;
    }
    if (ch === "<" && startsJsx(text, at)) {
      return openTag(at);
    }
    return at + 1;
  }
  function readTemplateChunk(at) {
    let cursor = at;
    while (cursor < text.length) {
      const ch = text[cursor];
      if (ch === "\\") {
        cursor += 2;
        continue;
      }
      if (ch === "`") {
        pushTemplate(at, cursor);
        stack.pop();
        return cursor + 1;
      }
      if (ch === "$" && text[cursor + 1] === "{") {
        pushTemplate(at, cursor);
        stack.push({ kind: "code", depth: 0, element: null, containerStart: containerOf() });
        return cursor + 2;
      }
      cursor++;
    }
    pushTemplate(at, cursor);
    stack.pop();
    return cursor;
  }
  function pushTemplate(from, to) {
    if (to <= from) return;
    const owner = openElement();
    let attribute = null;
    for (let i2 = stack.length - 1; i2 >= 0; i2--) {
      const entry = stack[i2];
      if (entry.kind === "template") {
        attribute = entry.templateAttribute ?? null;
        break;
      }
    }
    segments.push({
      kind: "template",
      start: from,
      end: to,
      value: text.slice(from, to),
      ...attribute === null ? {} : { attribute },
      ...owner === null ? {} : { tag: owner.tag }
    });
    blank(from, to);
  }
  function attributeOfTemplate(from) {
    let cursor = from - 1;
    if (text[cursor] === "`") cursor--;
    while (cursor >= 0 && /\s/.test(text[cursor])) cursor--;
    if (text[cursor] === "{") cursor--;
    while (cursor >= 0 && /\s/.test(text[cursor])) cursor--;
    if (text[cursor] !== "=") return null;
    cursor--;
    const nameEnd = cursor + 1;
    while (cursor >= 0 && IDENT_PART.test(text[cursor])) cursor--;
    const name = text.slice(cursor + 1, nameEnd);
    return name.length > 0 && IDENT_START.test(name[0]) ? name : null;
  }
  function openTag(at) {
    let cursor = at + 1;
    let tag = "";
    if (text[cursor] === ">") {
      const element2 = makeElement("", at);
      stack.push({ kind: "jsx-children", depth: 0, element: element2, containerStart: null });
      element2.openEnd = cursor + 1;
      return cursor + 1;
    }
    while (cursor < text.length && IDENT_PART.test(text[cursor])) {
      tag += text[cursor];
      cursor++;
    }
    const element = makeElement(tag, at);
    stack.push({ kind: "jsx-tag", depth: 0, element, containerStart: null });
    return cursor;
  }
  function makeElement(tag, at) {
    const parent = openElement();
    const element = {
      tag,
      attributes: [],
      children: [],
      parent,
      start: at,
      openEnd: at,
      end: at,
      containerStart: containerOf()
    };
    if (parent) parent.children.push(element);
    elements.push(element);
    return element;
  }
  function readJsxTag(at, frame) {
    const ch = text[at];
    if (/\s/.test(ch)) return at + 1;
    const element = frame.element;
    if (element === null) {
      stack.pop();
      return at + 1;
    }
    if (ch === "/" && text[at + 1] === ">") {
      element.openEnd = at + 2;
      element.end = at + 2;
      stack.pop();
      return at + 2;
    }
    if (ch === ">") {
      element.openEnd = at + 1;
      stack.pop();
      stack.push({ kind: "jsx-children", depth: 0, element, containerStart: null });
      return at + 1;
    }
    if (ch === "{") {
      stack.push({ kind: "code", depth: 0, element, containerStart: at });
      return at + 1;
    }
    if (!IDENT_START.test(ch)) return at + 1;
    let cursor = at;
    let name = "";
    while (cursor < text.length && IDENT_PART.test(text[cursor])) {
      name += text[cursor];
      cursor++;
    }
    let probe = cursor;
    while (probe < text.length && /\s/.test(text[probe])) probe++;
    if (text[probe] !== "=") {
      element.attributes.push({ name, start: at, value: null, expression: false });
      return cursor;
    }
    probe++;
    while (probe < text.length && /\s/.test(text[probe])) probe++;
    const valueChar = text[probe];
    if (valueChar === '"' || valueChar === "'") {
      const end = readQuoted(text, probe, valueChar);
      const value = text.slice(probe + 1, end - 1);
      element.attributes.push({ name, start: at, value, expression: false });
      segments.push({
        kind: "jsx-attribute",
        start: probe + 1,
        end: end - 1,
        value,
        attribute: name,
        tag: element.tag
      });
      blank(probe + 1, end - 1);
      return end;
    }
    element.attributes.push({ name, start: at, value: null, expression: true });
    return probe;
  }
  function readJsxChildren(at, frame) {
    let cursor = at;
    while (cursor < text.length) {
      const ch = text[cursor];
      if (ch === "{") {
        pushJsxText(at, cursor, frame.element);
        stack.push({ kind: "code", depth: 0, element: frame.element, containerStart: cursor });
        return cursor + 1;
      }
      if (ch === "<") {
        pushJsxText(at, cursor, frame.element);
        if (text[cursor + 1] === "/") {
          const close = indexOrEnd(text, ">", cursor);
          const element = frame.element;
          if (element) element.end = Math.min(close + 1, text.length);
          stack.pop();
          return Math.min(close + 1, text.length);
        }
        return openTag(cursor);
      }
      cursor++;
    }
    pushJsxText(at, cursor, frame.element);
    stack.pop();
    return cursor;
  }
  function pushJsxText(from, to, owner) {
    if (to <= from) return;
    const value = text.slice(from, to);
    if (value.trim().length === 0) return;
    segments.push({
      kind: "jsx-text",
      start: from,
      end: to,
      value,
      ...owner === null ? {} : { tag: owner.tag }
    });
    blank(from, to);
  }
}
function readQuoted(text, at, quote) {
  let cursor = at + 1;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === "\\") {
      cursor += 2;
      continue;
    }
    if (ch === quote || ch === "\n") return cursor + 1;
    cursor++;
  }
  return text.length;
}
function indexOrEnd(text, needle, from) {
  const idx = text.indexOf(needle, from);
  return idx === -1 ? text.length : idx;
}
function startsJsx(text, at) {
  const next = text[at + 1];
  if (next === void 0) return false;
  if (next !== ">" && !IDENT_START.test(next)) return false;
  let cursor = at - 1;
  while (cursor >= 0 && /\s/.test(text[cursor])) cursor--;
  if (cursor < 0) return true;
  const prev = text[cursor];
  if (JSX_PRECEDERS.has(prev)) return true;
  if (!IDENT_PART.test(prev)) return false;
  let wordEnd = cursor + 1;
  while (cursor >= 0 && IDENT_PART.test(text[cursor])) cursor--;
  return JSX_PRECEDING_WORDS.has(text.slice(cursor + 1, wordEnd));
}
function isRegexStart(text, at) {
  let cursor = at - 1;
  while (cursor >= 0 && /\s/.test(text[cursor])) cursor--;
  if (cursor < 0) return true;
  const prev = text[cursor];
  return "([{=,;:?&|!+*%<>~^".includes(prev);
}
function skipRegex(text, at) {
  let cursor = at + 1;
  let inClass = false;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === "\\") {
      cursor += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      cursor++;
      while (cursor < text.length && /[a-z]/.test(text[cursor])) cursor++;
      return cursor;
    } else if (ch === "\n") return cursor;
    cursor++;
  }
  return cursor;
}
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}
function positionAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}
function elementAt(elements, offset) {
  let best = null;
  for (const element of elements) {
    if (element.start > offset) break;
    const end = element.end > element.start ? element.end : element.openEnd;
    if (offset < end && (best === null || element.start >= best.start)) best = element;
  }
  return best;
}
function enclosingFunctionBlock(masked, offset) {
  let block = enclosingBlock(masked, offset);
  while (block !== null) {
    const head = masked.slice(Math.max(0, block.start - 60), block.start);
    if (/(=>|\)|\bfunction\b|\bdo\b)\s*$/.test(head) && !/\b(if|for|while|switch|catch|try|else)\s*\)?\s*$/.test(head)) {
      return block;
    }
    const outer = enclosingBlock(masked, block.start);
    if (outer === null || outer.start === block.start) return block;
    block = outer;
  }
  return null;
}
function enclosingBlock(masked, offset) {
  let depth = 0;
  let start = -1;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = masked[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;
  depth = 0;
  for (let i = start; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return { start, end: masked.length };
}

// src/legibility/checks/empty-state.ts
var EMPTY_PATTERNS = [
  /^no\b/i,
  /^none\b/i,
  /^nothing\b/i,
  /^0\s+\w+\s+(found|yet)/i,
  /\bnothing (here|yet|to show|to do|to review)\b/i,
  /\bnot(hing)? found\b/i,
  /\bis empty\b/i,
  /\bno (results|items|data|matches|records|files|entries)\b/i,
  /\byou (have|haven't|don't have) (no|any)\b/i
];
var ACTION_TAGS = /* @__PURE__ */ new Set(["button", "a", "input", "select", "textarea", "form", "link", "navlink"]);
var ACTION_PROPS = /* @__PURE__ */ new Set([
  "onclick",
  "onsubmit",
  "onchange",
  "onselect",
  "onpress",
  "ontoggle",
  "href",
  "to",
  "action",
  "onaction",
  "oncta",
  "emptyaction",
  "emptycta",
  "onemptyaction",
  "primaryaction"
]);
var ACTION_PROP_SUFFIX = /(href|action|cta|click|submit|press|link)$/i;
var EMPTY_COPY_PROPS = /^empty[A-Z]/;
var HEADING_TAG = /^h[1-6]$/i;
var HEADING_SUFFIX = /(heading|title)$/i;
function checkEmptyStates(file, options = {}) {
  const actionTags = /* @__PURE__ */ new Set([...ACTION_TAGS, ...(options.extraActionTags ?? []).map((tag) => tag.toLowerCase())]);
  const actionProps = /* @__PURE__ */ new Set([...ACTION_PROPS, ...(options.extraActionProps ?? []).map((prop) => prop.toLowerCase())]);
  const patterns = [...EMPTY_PATTERNS, ...(options.extraEmptyPatterns ?? []).map((source) => new RegExp(source, "i"))];
  const findings = [];
  const reported = /* @__PURE__ */ new Set();
  const iterations = options.reportSectionZeroStates === true ? [] : listIterations(file.scan.masked);
  const report = (root, offset, copy, viaProp) => {
    if (reported.has(root.start)) return;
    reported.add(root.start);
    if (hasAction(file, root, actionTags, actionProps)) return;
    if (options.reportSectionZeroStates !== true && labelsATitledSection(file, root)) return;
    if (iterations.some((span) => root.start > span.start && root.start < span.end)) return;
    findings.push({
      check: "dead-end-empty-state",
      offset,
      message: `Empty state "${clip(copy)}" offers no next action${viaProp === null ? "" : ` (${viaProp})`}.`,
      remedy: "Put the one thing the reader should do next inside this branch \u2014 a button, a link, or the control that creates the first item. If nothing can be done here, say why in the copy.",
      evidence: clip(copy)
    });
  };
  for (const segment of file.scan.segments) {
    if (segment.kind !== "jsx-text") continue;
    const text = segment.value.trim();
    if (!patterns.some((pattern) => pattern.test(text))) continue;
    const element = elementAt(file.scan.elements, segment.start);
    if (element === null) continue;
    report(branchRoot(element), segment.start, text, null);
  }
  for (const element of file.scan.elements) {
    const copyProp = element.attributes.find(
      (attribute) => EMPTY_COPY_PROPS.test(attribute.name) && attribute.value !== null
    );
    if (!copyProp?.value) continue;
    report(element, copyProp.start, copyProp.value, `via ${copyProp.name}`);
  }
  return findings.sort((left, right) => left.offset - right.offset);
}
function branchRoot(element) {
  let root = element;
  while (root.parent !== null && root.parent.containerStart === element.containerStart) root = root.parent;
  return root;
}
function listIterations(masked) {
  const spans = [];
  for (const match of masked.matchAll(/\.\s*map\s*\(/g)) {
    const open = (match.index ?? 0) + (match[0]?.length ?? 1) - 1;
    const end = matchingParen(masked, open);
    if (end !== -1) spans.push({ start: open, end });
  }
  return spans;
}
function matchingParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
function labelsATitledSection(file, root) {
  let previous = null;
  for (const element of file.scan.elements) {
    if (element.start >= root.start) break;
    if (element.parent !== root.parent) continue;
    previous = element;
  }
  if (previous === null) return false;
  const tag = previous.tag.split(".").pop() ?? previous.tag;
  return HEADING_TAG.test(tag) || HEADING_SUFFIX.test(tag);
}
function hasAction(file, root, actionTags, actionProps) {
  const end = root.end > root.start ? root.end : root.openEnd;
  for (const element of file.scan.elements) {
    if (element.start < root.start) continue;
    if (element.start >= end) break;
    if (isActionTag(element.tag, actionTags)) return true;
    if (element.attributes.some(
      (attribute) => actionProps.has(attribute.name.toLowerCase()) || ACTION_PROP_SUFFIX.test(attribute.name)
    )) {
      return true;
    }
  }
  return false;
}
function isActionTag(tag, actionTags) {
  const base = (tag.split(".").pop() ?? tag).toLowerCase();
  if (actionTags.has(base)) return true;
  return /(button|link|cta|anchor|action)$/.test(base);
}
function clip(value, max = 72) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}

// src/legibility/scan.ts
import { readFileSync } from "fs";
import { relative } from "path";
var DEFAULT_IGNORE = [
  ".test.",
  ".spec.",
  "__tests__",
  "__fixtures__",
  "/fixtures/",
  "/tests/",
  "/test/",
  ".d.ts",
  ".stories.",
  "/+types/"
];
function scanFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return buildScannedFile(path, text);
}
function buildScannedFile(path, text) {
  const scan = scanSource(text);
  const lineStarts = lineIndex(text);
  return {
    path,
    display: displayPath(path),
    text,
    scan,
    lineStarts,
    positionAt: (offset) => positionAt(lineStarts, offset)
  };
}
function scanSources(srcDirs, ignore = []) {
  const files = srcDirs.flatMap((dir) => walkSources(dir, [...DEFAULT_IGNORE, ...ignore]));
  const unique = [...new Set(files)].sort();
  return unique.flatMap((path) => {
    const scanned = scanFile(path);
    return scanned ? [scanned] : [];
  });
}
function displayPath(file) {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") ? rel : file;
}
function evidenceOf(text, start, end, max = 100) {
  const raw = text.slice(start, Math.min(end, start + max * 3)).replace(/\s+/g, " ").trim();
  return raw.length > max ? `${raw.slice(0, max - 1)}\u2026` : raw;
}

// src/legibility/checks/reachability.ts
import { readFileSync as readFileSync2 } from "fs";
var ROUTE_CALL_RE = /(?<![\w$.])(route|index|layout|prefix)\s*\(/g;
var MODULE_LITERAL = /\.(tsx?|jsx?)$/;
var LINK_ATTRIBUTES = /* @__PURE__ */ new Set(["to", "href", "action", "redirect"]);
var LINK_ATTRIBUTE_SUFFIX = /(href|url|link|route|path)$/i;
var LINK_CALLS = /* @__PURE__ */ new Set(["navigate", "redirect", "redirectdocument"]);
var LINK_CALL_TAIL = /* @__PURE__ */ new Set(["push", "replace", "assign", "navigate", "redirect"]);
var LOCATION_ASSIGN_RE = /\blocation\s*\.\s*href\s*=\s*/g;
function parseRouteConfig(file) {
  const masked = file.scan.masked;
  const calls = [];
  ROUTE_CALL_RE.lastIndex = 0;
  for (const match of masked.matchAll(ROUTE_CALL_RE)) {
    const parenStart = (match.index ?? 0) + (match[0]?.length ?? 1) - 1;
    const end = matchingParen2(masked, parenStart);
    if (end === -1) continue;
    const args = file.scan.segments.filter((segment) => segment.kind === "string" && segment.start > parenStart && segment.end < end).filter((segment) => topLevelArgument(masked, parenStart, segment.start)).map((segment) => ({ value: segment.value, start: segment.start }));
    calls.push({ kind: match[1] ?? "", start: match.index ?? 0, end, args });
  }
  const ancestorsOf = (call) => calls.filter((other) => other !== call && other.start < call.start && other.end > call.end);
  const entries = [];
  for (const call of calls) {
    if (call.kind !== "route" && call.kind !== "prefix") continue;
    const own = call.args[0];
    if (own === void 0) continue;
    if (MODULE_LITERAL.test(own.value)) continue;
    const prefixParts = ancestorsOf(call).filter((ancestor) => ancestor.kind === "route" || ancestor.kind === "prefix").sort((left, right) => left.start - right.start).map((ancestor) => ancestor.args[0]?.value ?? "");
    if (call.kind === "prefix") continue;
    entries.push({
      path: joinPath([...prefixParts, own.value]),
      module: call.args[1]?.value ?? null,
      offset: own.start,
      isLayout: calls.some((other) => other !== call && other.start > call.start && other.end < call.end)
    });
  }
  return entries;
}
function topLevelArgument(masked, parenStart, at) {
  let depth = 0;
  for (let i = parenStart; i < at; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
  }
  return depth === 1;
}
function endOfStatement(masked, from) {
  for (let i = from; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === ";" || ch === "\n") return i;
  }
  return masked.length;
}
function matchingParen2(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
function joinPath(parts) {
  return parts.flatMap((part) => part.split("/")).map((part) => part.trim()).filter((part) => part.length > 0).join("/");
}
function staticSegments(path) {
  return path.replace(/\$\{[^}]*\}/g, "/*/").split(/[/?#]/).map((segment) => segment.trim()).filter((segment) => segment.length > 0 && !segment.startsWith(":") && segment !== "*" && !segment.startsWith("$"));
}
function pathLike(value) {
  const trimmed = value.trim();
  return trimmed.length > 1 && trimmed.startsWith("/") && /^\/[\w:$@.{}\-/[\]]+$/.test(trimmed);
}
function linkTargets(file) {
  const targets = [];
  const push = (raw) => {
    const segments = staticSegments(raw);
    if (segments.length > 0) targets.push({ raw, segments });
  };
  for (const segment of file.scan.segments) {
    if (segment.kind !== "jsx-attribute" && segment.kind !== "template") continue;
    const attribute = segment.attribute;
    if (attribute === void 0) continue;
    if (LINK_ATTRIBUTES.has(attribute.toLowerCase()) || LINK_ATTRIBUTE_SUFFIX.test(attribute)) push(segment.value);
  }
  const masked = file.scan.masked;
  const callRe = /(?<![\w$.])([A-Za-z_$][\w$.]*)\s*\(/g;
  for (const match of masked.matchAll(callRe)) {
    const name = (match[1] ?? "").toLowerCase();
    const tail = name.split(".").pop() ?? name;
    if (!LINK_CALLS.has(name) && !LINK_CALL_TAIL.has(tail)) continue;
    const parenStart = (match.index ?? 0) + (match[0]?.length ?? 1) - 1;
    const end = matchingParen2(masked, parenStart);
    for (const segment of file.scan.segments) {
      if (segment.kind !== "string" && segment.kind !== "template") continue;
      if (segment.start < parenStart || end !== -1 && segment.end > end) continue;
      push(segment.value);
    }
  }
  LOCATION_ASSIGN_RE.lastIndex = 0;
  for (const match of masked.matchAll(LOCATION_ASSIGN_RE)) {
    const after = (match.index ?? 0) + (match[0]?.length ?? 0);
    const statementEnd = endOfStatement(masked, after);
    for (const segment of file.scan.segments) {
      if (segment.kind !== "string" && segment.kind !== "template") continue;
      if (segment.start < after || segment.start >= statementEnd) continue;
      push(segment.value);
    }
  }
  for (const segment of file.scan.segments) {
    if (segment.kind === "comment") continue;
    if (pathLike(segment.value)) push(segment.value);
  }
  return targets;
}
function navTargets(file) {
  const targets = [...linkTargets(file)];
  for (const segment of file.scan.segments) {
    if (segment.kind !== "string" && segment.kind !== "template") continue;
    const value = segment.value.trim();
    if (value.length === 0 || /\s/.test(value)) continue;
    if (!/^[/$]/.test(value) && !value.includes("/")) continue;
    const segments = staticSegments(value);
    if (segments.length > 0) targets.push({ raw: value, segments });
  }
  return targets;
}
function checkReachability({ files, options }) {
  const routeFile = options.routeConfigFile ? readScanned(options.routeConfigFile) : null;
  const declared = routeFile ? parseRouteConfig(routeFile) : (options.routePaths ?? []).map((path) => ({ path, module: null, offset: 0, isLayout: false }));
  if (declared.length === 0) return { findings: [], routeFile, routeCount: 0 };
  const navFiles = (options.navFiles ?? []).map((path) => readScanned(path)).filter(isScanned);
  const navPaths = navFiles.flatMap((file) => navTargets(file));
  const navSet = new Set(navFiles.map((file) => file.path));
  const product = files.filter((file) => !navSet.has(file.path) && file.path !== routeFile?.path);
  const routeModules = indexRouteModules(declared, product);
  const freeDoors = product.filter((file) => !routeModules.has(file.path)).flatMap((file) => linkTargets(file));
  const doors = reachableDoors({ files: product, navPaths, freeDoors, routeModules });
  const ignore = options.ignore ?? ["api/*"];
  const ignoreNonTsx = options.ignoreNonTsxRoutes ?? true;
  const findings = [];
  for (const entry of declared) {
    if (entry.path.length === 0) continue;
    if (entry.isLayout) continue;
    if (ignore.some((pattern) => matchesIgnore(entry.path, pattern))) continue;
    if (ignoreNonTsx && entry.module !== null && !entry.module.endsWith(".tsx")) continue;
    const target = staticSegments(entry.path);
    if (target.length === 0) continue;
    if (doors.some((door) => isSuffix(target, door.segments))) continue;
    findings.push({
      check: "unreachable-capability",
      offset: entry.offset,
      message: `Route "${entry.path}" is reachable by neither the navigation nor any link in the source \u2014 only by typing the URL.`,
      remedy: "Add it to the navigation, or link it from the screen a reader would look for it on. If it is deliberately unlisted (an internal tool, a deep link sent by email), suppress it with that reason.",
      evidence: routeFile ? evidenceOf(routeFile.text, entry.offset - 1, entry.offset + entry.path.length + 60, 90) : entry.path
    });
  }
  return { findings, routeFile, routeCount: declared.length };
}
function isScanned(file) {
  return file !== null;
}
function indexRouteModules(declared, files) {
  const byFile = /* @__PURE__ */ new Map();
  for (const entry of declared) {
    const module = entry.module;
    if (module === null) continue;
    const owner = files.find((file) => file.path === module || file.path.endsWith(`/${module}`));
    if (owner === void 0) continue;
    const existing = byFile.get(owner.path);
    if (existing) existing.push(entry);
    else byFile.set(owner.path, [entry]);
  }
  return byFile;
}
function reachableDoors({ files, navPaths, freeDoors, routeModules }) {
  const doors = [...navPaths, ...freeDoors];
  const pending = files.filter((file) => routeModules.has(file.path)).map((file) => ({
    file,
    // A layout adds no path of its own and renders around every child, so it
    // opens as soon as anything is open at all.
    targets: (routeModules.get(file.path) ?? []).filter((entry) => !entry.isLayout).map((entry) => staticSegments(entry.path)).filter((parts) => parts.length > 0)
  }));
  let open = true;
  while (open) {
    open = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const candidate = pending[i];
      if (candidate === void 0) continue;
      const reached = candidate.targets.length === 0 || candidate.targets.some((target) => doors.some((door) => isSuffix(target, door.segments)));
      if (!reached) continue;
      pending.splice(i, 1);
      doors.push(...linkTargets(candidate.file));
      open = true;
    }
  }
  return doors;
}
function readScanned(path) {
  try {
    return buildScannedFile(path, readFileSync2(path, "utf8"));
  } catch {
    return null;
  }
}
function isSuffix(route, door) {
  if (door.length === 0 || door.length > route.length) return false;
  const offset = route.length - door.length;
  return door.every((segment, index) => segment.toLowerCase() === (route[offset + index] ?? "").toLowerCase());
}
function matchesIgnore(path, pattern) {
  if (pattern.endsWith("/*")) return path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

// src/legibility/checks/silent-failure.ts
var ERROR_SINK = /\bthrow\b|\breject\s*\(|\btoast\b|\bfail[A-Za-z]*\s*\(|\b(set|show|render|display|report|surface|push|add|emit|on)[A-Za-z]*(error|failure|failed|problem|issue|notice|warning|message|banner|alert|toast)\s*\(|\b(error|failure|message|notice)\s*[:=][^=]/i;
var CONSOLE_CALL = /\bconsole\s*\.\s*[a-z]+\s*\([^()]*(\([^()]*\)[^()]*)*\)/g;
var RESTORES_STATE = /\b(set|restore|revert|roll)[A-Za-z]*\s*\(\s*(prev|previous|original|before|last|old)[A-Za-z]*\s*[,)]/i;
function returnsWords(bodyWithoutConsole) {
  const at = bodyWithoutConsole.search(/\breturn\b/);
  return at !== -1 && /['"`]/.test(bodyWithoutConsole.slice(at));
}
var IO_IN_TRY = /\bawait\b|\.\s*then\s*\(|\bfetch\s*\(|\bXMLHttpRequest\b/;
var BODY_READ_AFTER_AWAIT = /^[\s(]*[\w$.\s()]*?\.\s*(json|text|formData|arrayBuffer|blob)\s*\(\s*\)/;
function parseOnlyTry(tryBody) {
  if (/\bfetch\s*\(|\.\s*then\s*\(|\bXMLHttpRequest\b/.test(tryBody)) return false;
  const awaits = [...tryBody.matchAll(/\bawait\b/g)];
  if (awaits.length === 0) return false;
  return awaits.every((match) => BODY_READ_AFTER_AWAIT.test(tryBody.slice((match.index ?? 0) + "await".length)));
}
var READERLESS_PATHS = ["/.server/", "/routes/api."];
var CATCH_RE = /\bcatch\s*(?:\(([^)]*)\)\s*)?\{/g;
var PROMISE_CATCH_RE = /\.\s*catch\s*\(/g;
function checkSilentFailure(file, options = {}) {
  const extraSinks = (options.extraErrorSinks ?? []).map((sink) => sink.toLowerCase());
  const readerless = options.readerlessPaths ?? READERLESS_PATHS;
  if (readerless.some((marker) => file.path.includes(marker))) return [];
  const masked = file.scan.masked;
  const findings = [];
  const surfaced = (body) => {
    if (ERROR_SINK.test(body) || RESTORES_STATE.test(body)) return true;
    if (returnsWords(body.replace(CONSOLE_CALL, " "))) return true;
    return extraSinks.some((sink) => body.toLowerCase().includes(sink));
  };
  CATCH_RE.lastIndex = 0;
  for (const match of masked.matchAll(CATCH_RE)) {
    const braceAt = (match.index ?? 0) + (match[0]?.length ?? 1) - 1;
    const block = blockFrom(masked, braceAt);
    if (block === null) continue;
    const body = masked.slice(block.start + 1, block.end - 1);
    if (surfaced(body)) continue;
    if (carriesError(body, match[1])) continue;
    const guarded = tryBlockBefore(masked, match.index ?? 0);
    if (guarded === null || !IO_IN_TRY.test(guarded)) continue;
    if (parseOnlyTry(guarded)) continue;
    findings.push({
      check: "silent-failure",
      offset: match.index ?? 0,
      message: body.trim().length === 0 ? "This catch swallows the failure entirely \u2014 the request failed and the screen will render as if it returned nothing." : "This catch never surfaces the failure \u2014 the reader sees an empty result, not a problem they can act on.",
      remedy: "Set an error state this screen renders (with a retry), or rethrow so a boundary above can. A console line is not a sink \u2014 the reader has no console.",
      evidence: evidenceOf(file.text, match.index ?? 0, block.end, 80)
    });
  }
  PROMISE_CATCH_RE.lastIndex = 0;
  for (const match of masked.matchAll(PROMISE_CATCH_RE)) {
    const parenAt = (match.index ?? 0) + (match[0]?.length ?? 1) - 1;
    const end = matchingParen3(masked, parenAt);
    if (end === -1) continue;
    const body = masked.slice(parenAt + 1, end - 1);
    if (body.trim().length === 0) continue;
    if (surfaced(body)) continue;
    if (!isRequestChain(masked, match.index ?? 0)) continue;
    if (!/=>|\bfunction\b/.test(body)) continue;
    findings.push({
      check: "silent-failure",
      offset: match.index ?? 0,
      message: "This .catch() handler discards the failure \u2014 the promise rejects and nothing on screen changes.",
      remedy: "Surface it: set the error state this view renders, or rethrow. If the failure is genuinely ignorable, suppress with a reason saying why.",
      evidence: evidenceOf(file.text, match.index ?? 0, end, 80)
    });
  }
  return findings.sort((left, right) => left.offset - right.offset);
}
function isRequestChain(masked, catchAt) {
  const chain = masked.slice(chainStart(masked, catchAt), catchAt);
  if (!/\bfetch\s*\(/.test(chain)) return false;
  return !/\.\s*(json|text|blob|arrayBuffer|formData)\s*\(\s*\)\s*$/.test(chain);
}
function chainStart(masked, from) {
  let at = from;
  for (; ; ) {
    at = trimmedEnd(masked, at);
    if (at <= 0) return 0;
    const ch = masked[at - 1];
    if (ch === ")" || ch === "]") {
      const open = matchingOpenBefore(masked, at - 1);
      if (open === -1) return at;
      at = trimmedEnd(masked, open);
      continue;
    }
    if (ch !== void 0 && /[\w$]/.test(ch)) {
      let start = at - 1;
      while (start > 0 && /[\w$]/.test(masked[start - 1] ?? "")) start--;
      const beforeIdent = trimmedEnd(masked, start);
      if (beforeIdent > 0 && masked[beforeIdent - 1] === ".") {
        at = beforeIdent - 1;
        continue;
      }
      return start;
    }
    return at;
  }
}
function trimmedEnd(masked, from) {
  let at = from;
  while (at > 0 && /\s/.test(masked[at - 1] ?? "")) at--;
  return at;
}
function matchingOpenBefore(masked, close) {
  const closer = masked[close];
  const opener = closer === ")" ? "(" : "[";
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const ch = masked[i];
    if (ch === closer) depth++;
    else if (ch === opener) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function carriesError(body, binding) {
  const name = /^[A-Za-z_$][\w$]*/.exec((binding ?? "").trim())?.[0];
  if (name === void 0) return false;
  const withoutConsole = body.replace(CONSOLE_CALL, " ");
  return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(withoutConsole);
}
function blockFrom(masked, braceAt) {
  let depth = 0;
  for (let i = braceAt; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start: braceAt, end: i + 1 };
    }
  }
  return null;
}
function matchingParen3(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
function tryBlockBefore(masked, catchAt) {
  const before = masked.slice(0, catchAt).trimEnd();
  if (!before.endsWith("}")) return null;
  const block = enclosingBlock(masked, before.length - 1);
  if (block === null) return null;
  const head = masked.slice(Math.max(0, block.start - 8), block.start);
  if (!/\btry\s*$/.test(head)) return null;
  return masked.slice(block.start, block.end);
}

// src/legibility/checks/success.ts
var DEFAULT_HTTP_CALLS = ["fetch"];
var SUCCESS_CALLS = /* @__PURE__ */ new Set(["toast.success", "toast.ok", "notifySuccess"]);
var SUCCESS_SETTER = /^set[A-Za-z]*(saved|success|succeeded|done|complete|completed|sent|submitted|confirmed)$/i;
var STATUS_SETTER = /^set[A-Za-z]*(status|state|phase|stage|message|notice)$/i;
var SUCCESS_WORD = /^(saved|success|succeeded|done|sent|complete|completed|updated|created|ok)\b/i;
var INSPECTS_RESPONSE = /\.\s*(ok|status|statusText)\b|\{[^}\n]*\b(ok|status)\b[^}\n]*\}\s*=/;
var CALL_RE = /(?<![\w$.])((?:new\s+)?[A-Za-z_$][\w$.]*)\s*\(/g;
function callSites(masked) {
  const sites = [];
  CALL_RE.lastIndex = 0;
  for (const match of masked.matchAll(CALL_RE)) {
    const name = (match[1] ?? "").replace(/^new\s+/, "");
    const start = match.index ?? 0;
    const parenStart = start + (match[0]?.length ?? 1) - 1;
    sites.push({ name, start, parenStart, parenEnd: matchingParen4(masked, parenStart) });
  }
  return sites;
}
function matchingParen4(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
function checkUncheckedSuccess(file, options = {}) {
  const httpCalls = new Set([...DEFAULT_HTTP_CALLS, ...options.httpCalls ?? []].map((call) => call.toLowerCase()));
  const okGuards = new Set((options.okGuards ?? []).map((guard) => guard.toLowerCase()));
  const extraSignals = new Set((options.extraSuccessSignals ?? []).map((signal) => signal.toLowerCase()));
  const masked = file.scan.masked;
  const sites = callSites(masked);
  const requests = sites.filter((site) => httpCalls.has(site.name.toLowerCase()));
  if (requests.length === 0) return [];
  const findings = [];
  const reported = /* @__PURE__ */ new Set();
  for (const request of requests) {
    const scope = enclosingFunctionBlock(masked, request.start) ?? { start: 0, end: masked.length };
    if (reported.has(scope.start)) continue;
    const body = masked.slice(scope.start, scope.end);
    if (INSPECTS_RESPONSE.test(body)) continue;
    if (sites.some((site) => okGuards.has(site.name.toLowerCase()) && within(site.start, scope))) continue;
    const signal = sites.find((site) => within(site.start, scope) && isSuccessSignal(file, site, extraSignals));
    if (!signal) continue;
    reported.add(scope.start);
    const awaited = isAwaited(masked, request.start) || isChained(masked, request.parenEnd);
    findings.push({
      check: "unchecked-success",
      offset: signal.start,
      message: awaited ? `"${signal.name}(\u2026)" reports success, but nothing in this function reads the response's ok/status \u2014 ${request.name} resolves on a 404 as happily as on a 200.` : `"${signal.name}(\u2026)" reports success before ${request.name}(\u2026) has settled \u2014 the request is not awaited, so the outcome cannot be known yet.`,
      remedy: awaited ? `Check the response first: const res = await ${request.name}(\u2026); if (!res.ok) { show the failure } else { ${signal.name}(\u2026) }.` : `Await the request, then branch on res.ok. If it is deliberately fire-and-forget, say "sending" rather than "sent".`,
      evidence: evidenceOf(file.text, lineStart(file, signal.start), signal.parenEnd > 0 ? signal.parenEnd : signal.start)
    });
  }
  return findings;
}
function within(offset, scope) {
  return offset >= scope.start && offset < scope.end;
}
function lineStart(file, offset) {
  const { line } = file.positionAt(offset);
  return file.lineStarts[line - 1] ?? offset;
}
function isSuccessSignal(file, site, extraSignals) {
  const name = site.name;
  if (SUCCESS_CALLS.has(name) || extraSignals.has(name.toLowerCase())) return true;
  const argument = firstArgument(file, site);
  if (SUCCESS_SETTER.test(name)) return argument.literal === null ? argument.code === "true" : true;
  if (STATUS_SETTER.test(name)) return argument.literal !== null && SUCCESS_WORD.test(argument.literal.trim());
  return false;
}
function firstArgument(file, site) {
  const literal = file.scan.segments.find(
    (segment) => (segment.kind === "string" || segment.kind === "template") && segment.start > site.parenStart && (site.parenEnd === -1 || segment.end <= site.parenEnd)
  );
  const code = file.scan.masked.slice(site.parenStart + 1, site.parenEnd > 0 ? site.parenEnd - 1 : site.parenStart + 40).trim();
  const literalIsFirst = literal !== void 0 && file.scan.masked.slice(site.parenStart + 1, literal.start).replace(/['"`]/g, "").trim() === "";
  return { literal: literalIsFirst && literal ? literal.value : null, code };
}
function isAwaited(masked, callStart) {
  return /\bawait\s*$/.test(masked.slice(Math.max(0, callStart - 12), callStart));
}
function isChained(masked, parenEnd) {
  if (parenEnd <= 0) return false;
  return /^\s*\.\s*(then|catch|finally)\b/.test(masked.slice(parenEnd, parenEnd + 24));
}

// src/legibility/checks/vocabulary.ts
var DEFAULT_BANNED_TERMS = [
  { term: "materialize", instead: 'say what the reader gets: "your documents are ready"' },
  { term: "materialized", instead: 'say what the reader gets: "your documents are ready"' },
  { term: "materializing", instead: 'say what is happening: "getting your documents ready"' },
  { term: "materialization", instead: 'say what is happening: "getting your documents ready"' },
  { term: "fact", instead: 'name the thing: "the figure we found", "the wage entry"' },
  { term: "facts", instead: 'name the things: "the figures we found", "wage entries"' },
  { term: "conflict", instead: 'say what disagrees: "two documents report different wages"' },
  { term: "conflicts", instead: 'say what disagrees: "two documents report different wages"' },
  { term: "proposed", instead: 'say who acts next: "needs your approval"' },
  { term: "workspace", instead: 'name the container the reader recognises: "account", "client", "matter"' },
  { term: "record", instead: 'name the domain object: "return", "matter", "contact"' },
  { term: "records", instead: 'name the domain objects: "returns", "matters", "contacts"' },
  { term: "artifact", instead: 'name the deliverable: "return", "redline", "brief"' },
  { term: "artifacts", instead: 'name the deliverables: "returns", "redlines", "briefs"' },
  { term: "work product", instead: "name the deliverable the reader asked for" },
  { term: "OCR", instead: 'say what happened: "we read your scan"' },
  { term: "extraction", instead: 'say what happened: "what we found in your documents"' },
  { term: "superseded", instead: '"replaced by a newer version"' },
  { term: "sourceKind", instead: "an internal field name \u2014 write the label the reader reads" },
  { term: "itemKey", instead: "an internal field name \u2014 write the label the reader reads" },
  { term: "payload", instead: 'name what was sent: "your answers", "the document"' },
  { term: "null", instead: "a value the code failed to fill \u2014 render the real value or written fallback copy" },
  { term: "undefined", instead: "a value the code failed to fill \u2014 render the real value or written fallback copy" }
];
var COPY_KEYS = [
  "title",
  "label",
  "placeholder",
  "alt",
  "description",
  "heading",
  "subheading",
  "subtitle",
  "message",
  "tooltip",
  "caption",
  "summary",
  "hint",
  "helper",
  "helperText",
  "error",
  "errorMessage",
  "emptyTitle",
  "emptyDescription",
  "emptyLabel",
  "emptyMessage",
  "emptyText",
  "cta",
  "ctaLabel",
  "confirmLabel",
  "cancelLabel",
  "submitLabel",
  "actionLabel",
  "buttonLabel",
  "headline",
  "copy",
  "note",
  "notice",
  "warning",
  "question"
];
var COPY_CALLS = [
  "toast",
  "toast.success",
  "toast.error",
  "toast.info",
  "toast.warning",
  "toast.message",
  "alert",
  "confirm",
  "notify",
  "Error",
  "setError",
  "setErrorMessage",
  "setMessage",
  "setNotice",
  "setWarning"
];
function compile(terms) {
  return terms.map((term) => ({
    term,
    // Whitespace in a term matches any run of whitespace, so "work product"
    // still matches across a wrapped line of JSX text.
    re: new RegExp(`(?<![\\w-])${escape(term.term).replace(/\\?\s+/g, "\\s+")}(?![\\w-])`, "gi")
  }));
}
function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function checkVocabulary(file, options = {}) {
  const allow = new Set((options.allowTerms ?? []).map((term) => term.toLowerCase()));
  const base = options.terms ?? DEFAULT_BANNED_TERMS;
  const terms = compile(
    [...base, ...options.extraTerms ?? []].filter((entry) => !allow.has(entry.term.toLowerCase()))
  );
  const copyKeys = new Set([...COPY_KEYS, ...options.extraCopyKeys ?? []].map((key) => key.toLowerCase()));
  const copyCalls = new Set([...COPY_CALLS, ...options.extraCopyCalls ?? []].map((call) => call.toLowerCase()));
  const findings = [];
  for (const segment of file.scan.segments) {
    const visible = visibleCopy(file, segment, {
      copyKeys,
      copyCalls,
      includeObjectCopy: options.includeObjectCopy === true
    });
    if (visible === null) continue;
    for (const { term, re } of terms) {
      re.lastIndex = 0;
      for (const match of segment.value.matchAll(re)) {
        const offset = segment.start + (match.index ?? 0);
        findings.push({
          check: "engineering-vocabulary",
          offset,
          message: `"${match[0]}" is a word from the codebase, on screen in ${visible}.`,
          remedy: `Write what the reader needs: ${term.instead}.`,
          evidence: segment.value.replace(/\s+/g, " ").trim().slice(0, 100)
        });
      }
    }
  }
  return findings;
}
function visibleCopy(file, segment, context) {
  const { kind, attribute, start } = segment;
  if (kind === "comment") return null;
  if (kind === "jsx-text") return "rendered text";
  const named = attribute !== void 0 && context.copyKeys.has(attribute.toLowerCase());
  if (kind === "jsx-attribute") return named ? `the ${attribute} attribute` : null;
  if (named && segment.tag !== void 0) return `the ${attribute} attribute`;
  return codeContext(file, start, context);
}
function codeContext(file, start, context) {
  const from = Math.max(0, start - 90);
  const before = file.scan.masked.slice(from, Math.max(from, start - 1));
  const call = /(?:new\s+)?([A-Za-z_$][\w$.]*)\s*\(\s*$/.exec(before);
  if (call?.[1] && context.copyCalls.has(call[1].toLowerCase())) return `${call[1]}(\u2026)`;
  if (!context.includeObjectCopy) return null;
  const key = /([A-Za-z_$][\w$]*)\s*[:=]\s*$/.exec(before);
  if (key?.[1] && context.copyKeys.has(key[1].toLowerCase())) return `the ${key[1]} value`;
  return null;
}

// src/legibility/types.ts
var LEGIBILITY_CHECKS = [
  "engineering-vocabulary",
  "dead-end-empty-state",
  "unchecked-success",
  "silent-failure",
  "unreachable-capability",
  "suppression-without-reason"
];

// src/legibility/suppress.ts
var MIN_REASON = 12;
var DIRECTIVE_RE = /legibility-ignore(-file)?\s+([^\n]*)/;
var KNOWN = new Set(LEGIBILITY_CHECKS);
function buildSuppressionIndex(file) {
  const directives = [];
  const selfFindings = [];
  for (const segment of file.scan.segments) {
    if (segment.kind !== "comment") continue;
    const match = DIRECTIVE_RE.exec(segment.value);
    if (!match) continue;
    const wholeFile = match[1] === "-file";
    const rest = (match[2] ?? "").trim();
    const { names, reason } = splitDirective(rest);
    const known = names.filter((name) => KNOWN.has(name));
    const unknownChecks = names.filter((name) => !KNOWN.has(name));
    const directiveLine = file.positionAt(segment.start + match.index).line;
    const hasReason = reason.length >= MIN_REASON;
    const offset = segment.start + match.index;
    if (names.length === 0) {
      selfFindings.push({
        check: "suppression-without-reason",
        offset,
        message: "legibility-ignore names no check, so it is unclear what it excuses.",
        remedy: `Name the check and give a reason: legibility-ignore <${LEGIBILITY_CHECKS.slice(0, 2).join("|")}|\u2026> \u2014 why this one is right.`,
        evidence: `legibility-ignore ${rest}`.trim()
      });
      continue;
    }
    for (const unknown of unknownChecks) {
      selfFindings.push({
        check: "suppression-without-reason",
        offset,
        message: `legibility-ignore names "${unknown}", which is not a check \u2014 it suppresses nothing.`,
        remedy: `Use one of: ${LEGIBILITY_CHECKS.join(", ")}.`,
        evidence: `legibility-ignore ${rest}`.trim()
      });
    }
    if (!hasReason && known.length > 0) {
      selfFindings.push({
        check: "suppression-without-reason",
        offset,
        message: `legibility-ignore ${known.join(", ")} gives no reason, so it does not suppress anything.`,
        remedy: `Write why this instance is right after a dash: legibility-ignore ${known[0]} \u2014 <reason, ${MIN_REASON}+ characters>.`,
        evidence: `legibility-ignore ${rest}`.trim()
      });
    }
    if (known.length === 0) continue;
    directives.push({
      checks: known,
      reason,
      hasReason,
      unknownChecks,
      line: directiveLine,
      appliesToLine: wholeFile ? null : targetLine(file, segment.start, directiveLine)
    });
  }
  const honoured = directives.filter((directive) => directive.hasReason);
  return {
    selfFindings,
    reasonFor(check, line) {
      for (const directive of honoured) {
        if (!directive.checks.includes(check)) continue;
        if (directive.appliesToLine === null || directive.appliesToLine === line) return directive.reason;
      }
      return null;
    }
  };
}
function splitDirective(rest) {
  const separator = /(?:^|\s)(?:—|–|--|-|:)\s|:\s/.exec(rest);
  const head = separator ? rest.slice(0, separator.index) : rest;
  const reason = separator ? rest.slice(separator.index + separator[0].length).trim() : "";
  const names = head.split(/[,\s]+/).map((name) => name.trim()).filter((name) => name.length > 0);
  return { names, reason };
}
function targetLine(file, commentStart, commentLine) {
  const lineStart2 = file.lineStarts[commentLine - 1] ?? 0;
  const before = file.text.slice(lineStart2, commentStart).replace(/[{/*]/g, "").trim();
  if (before.length > 0) return commentLine;
  for (let line = commentLine + 1; line <= file.lineStarts.length; line++) {
    const start = file.lineStarts[line - 1];
    if (start === void 0) break;
    const end = file.lineStarts[line] ?? file.text.length;
    const content = file.text.slice(start, end).trim();
    if (content.length === 0) continue;
    if (/^(\/\/|\*|\{?\/\*)/.test(content) && !/legibility-ignore/.test(content)) continue;
    if (/legibility-ignore/.test(content)) continue;
    return line;
  }
  return commentLine + 1;
}

// src/legibility/report.ts
var CHECK_TITLES = {
  "engineering-vocabulary": "Engineering vocabulary on screen",
  "dead-end-empty-state": "Empty states with no next action",
  "unchecked-success": "Success reported without reading the response",
  "silent-failure": "Failures the reader never learns about",
  "unreachable-capability": "Capabilities with no door",
  "suppression-without-reason": "Suppressions that suppress nothing"
};
function formatLegibilityReport(report, options = {}) {
  const lines = [];
  const bold = (text) => options.colour ? `\x1B[1m${text}\x1B[0m` : text;
  if (report.ok) {
    lines.push(
      `legibility OK \u2014 ${report.filesScanned} file(s), ${report.checksRun.length} check(s), no findings` + (report.suppressed.length > 0 ? ` (${report.suppressed.length} suppressed with a reason)` : "")
    );
    if (options.listSuppressions) lines.push("", ...suppressionLines(report));
    return lines.join("\n");
  }
  lines.push(
    `legibility FAILED \u2014 ${report.findings.length} finding(s) across ${report.filesScanned} file(s).`,
    "Each one is a place a reader is left guessing. Fix it, or suppress that line with a written reason.",
    ""
  );
  for (const check of LEGIBILITY_CHECKS) {
    const findings = report.findings.filter((finding) => finding.check === check);
    if (findings.length === 0) continue;
    lines.push(`${bold(CHECK_TITLES[check])}  [${check}]  ${findings.length}`);
    for (const finding of findings) lines.push(...findingLines(finding));
    lines.push("");
  }
  if (report.suppressed.length > 0) {
    lines.push(
      `${report.suppressed.length} finding(s) suppressed with a written reason` + (options.listSuppressions ? ":" : " \u2014 run with --list-suppressions to read them.")
    );
    if (options.listSuppressions) lines.push(...suppressionLines(report));
    lines.push("");
  }
  lines.push("Suppress one deliberate instance with a reason on the line above it:");
  lines.push("  // legibility-ignore <check> \u2014 why this instance is right");
  return lines.join("\n");
}
function findingLines(finding) {
  return [
    `  ${finding.file}:${finding.line}:${finding.column}`,
    `    ${finding.message}`,
    `    \u2192 ${finding.remedy}`,
    ...finding.evidence ? [`    ${finding.evidence}`] : []
  ];
}
function suppressionLines(report) {
  return report.suppressed.map(
    (suppression) => `  ${suppression.file}:${suppression.line}  ${suppression.check} \u2014 ${suppression.reason}`
  );
}
function legibilityReportToJson(report) {
  return JSON.stringify(report, null, 2);
}

// src/legibility/index.ts
function enabled(config, check) {
  return config.checks?.[check] !== false;
}
function checkLegibility(config) {
  if (config.srcDirs.length === 0) throw new Error("checkLegibility: srcDirs must name at least one directory");
  const files = scanSources(config.srcDirs, config.ignorePaths ?? []);
  const findings = [];
  const suppressed = [];
  const collect = (file, raw) => {
    const index = buildSuppressionIndex(file);
    for (const finding of [...raw, ...index.selfFindings]) {
      if (!enabled(config, finding.check)) continue;
      const { line, column } = file.positionAt(finding.offset);
      const reason = finding.check === "suppression-without-reason" ? null : index.reasonFor(finding.check, line);
      if (reason !== null) {
        suppressed.push({ check: finding.check, reason, file: file.display, line });
        continue;
      }
      findings.push({
        check: finding.check,
        file: file.display,
        line,
        column,
        message: finding.message,
        remedy: finding.remedy,
        evidence: finding.evidence
      });
    }
  };
  for (const file of files) {
    const raw = [];
    if (enabled(config, "engineering-vocabulary")) raw.push(...checkVocabulary(file, config.vocabulary));
    if (enabled(config, "dead-end-empty-state")) raw.push(...checkEmptyStates(file, config.emptyState));
    if (enabled(config, "unchecked-success")) raw.push(...checkUncheckedSuccess(file, config.success));
    if (enabled(config, "silent-failure")) raw.push(...checkSilentFailure(file, config.silentFailure));
    collect(file, raw);
  }
  if (enabled(config, "unreachable-capability") && config.reachability) {
    const result = checkReachability({ files, options: config.reachability });
    if (result.routeFile) collect(result.routeFile, result.findings);
    else for (const finding of result.findings) findings.push(withoutFile(finding));
  }
  findings.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column
  );
  return {
    ok: findings.length === 0,
    findings,
    suppressed,
    filesScanned: files.length,
    checksRun: LEGIBILITY_CHECKS.filter((check) => enabled(config, check))
  };
}
function withoutFile(finding) {
  return {
    check: finding.check,
    file: "(routePaths)",
    line: 0,
    column: 0,
    message: finding.message,
    remedy: finding.remedy,
    evidence: finding.evidence
  };
}

export {
  scanSource,
  scanFile,
  buildScannedFile,
  scanSources,
  parseRouteConfig,
  staticSegments,
  READERLESS_PATHS,
  DEFAULT_BANNED_TERMS,
  COPY_KEYS,
  COPY_CALLS,
  LEGIBILITY_CHECKS,
  formatLegibilityReport,
  legibilityReportToJson,
  checkLegibility
};
//# sourceMappingURL=chunk-EPZYYWCT.js.map