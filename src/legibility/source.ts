/**
 * A purpose-built TS/TSX scanner: the one place this subpath decides what part
 * of a file is CODE and what part is COPY A HUMAN READS.
 *
 * Every legibility check needs the same distinction, and getting it from
 * per-check regexes is what makes a lint gate imprecise enough to be turned off.
 * `grep -i artifact` over one product's `apps/web/src` returns 11 hits and every
 * single one is an import specifier, a prop name, or a doc comment — zero are on
 * screen. A checker that reports those 11 is deleted within a week, and then it
 * guards nothing.
 *
 * So this module lexes instead: one pass produces (a) classified SEGMENTS —
 * comments, string literals, template chunks, JSX text, JSX attribute values —
 * and (b) a JSX ELEMENT TREE with spans, attributes, and the enclosing
 * expression container. Checks read those, never the raw bytes.
 *
 * It is a lexer, not a type-aware parser, and that boundary is deliberate: this
 * package ships one runtime dependency and adding `typescript` to every
 * consumer's install to lint copy is the wrong trade. What a lexer cannot do —
 * resolve a string through a variable, follow a component's props to its render
 * — is out of scope by construction and documented per check.
 *
 * Node-agnostic: pure string in, data out. The `fs` walking lives in `scan.ts`.
 */

/** What a stretch of source is, once the lexer has decided. */
export type SegmentKind =
  /** `//…` or `/*…*​/` — never user-visible; every check skips these. */
  | 'comment'
  /** A `'…'` / `"…"` literal in code position. Visible only in some contexts. */
  | 'string'
  /** One literal chunk of a template literal (the `${…}` holes are code). */
  | 'template'
  /** Text between JSX tags. The highest-confidence user-visible signal there is. */
  | 'jsx-text'
  /** A `name="…"` attribute value on a JSX element. */
  | 'jsx-attribute'

/** One classified stretch of source. */
export interface SourceSegment {
  readonly kind: SegmentKind
  /** Offset of the first character of the segment's VALUE (inside the quotes). */
  readonly start: number
  /** Offset just past the segment's value. */
  readonly end: number
  /** The value text, quotes stripped, escapes left as written. */
  readonly value: string
  /** For `jsx-attribute`: the attribute name. For `jsx-text`: absent. */
  readonly attribute?: string
  /** For `jsx-attribute` / `jsx-text`: the owning element's tag name. */
  readonly tag?: string
}

/** One attribute on a JSX element. */
export interface JsxAttribute {
  readonly name: string
  readonly start: number
  /** The literal value when written `name="…"`; null when `name={…}` or bare. */
  readonly value: string | null
  /** True when written `name={…}` — the value is code, not copy. */
  readonly expression: boolean
}

/** One JSX element, with the span every subtree question needs. */
export interface JsxElement {
  /** Tag as written (`div`, `Button`, `Card.Header`); `''` for a fragment. */
  readonly tag: string
  readonly attributes: JsxAttribute[]
  readonly children: JsxElement[]
  parent: JsxElement | null
  /** Offset of the opening `<`. */
  readonly start: number
  /** Offset just past the opening tag's `>`. */
  openEnd: number
  /** Offset just past the element's end (`/>` or `</tag>`). */
  end: number
  /**
   * Offset of the `{` of the nearest enclosing JSX expression container, or
   * null at the top of a return/assignment. This is what scopes an empty state
   * to its own conditional branch instead of to the whole page.
   */
  readonly containerStart: number | null
}

/** Everything one pass over a file produces. */
export interface ScannedSource {
  readonly text: string
  readonly segments: readonly SourceSegment[]
  /** Every element, in document (open-tag) order. */
  readonly elements: readonly JsxElement[]
  /**
   * `text` with every comment, string body and template body replaced by
   * spaces, offsets preserved. Structural regexes (catch bodies, fetch calls)
   * run over this so a `catch` inside a string can never be a finding.
   */
  readonly masked: string
}

/** 1-based line/column for a byte offset. */
export interface SourcePosition {
  readonly line: number
  readonly column: number
}

const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[A-Za-z0-9_$.:-]/

/**
 * Characters that can legally precede a JSX element in an expression position.
 * `a < b` and `Array<Foo>` both fail this test (they follow an identifier or a
 * closing paren), which is the whole reason it exists.
 */
const JSX_PRECEDERS = new Set(['(', '{', '}', '=', ',', ';', ':', '?', '&', '|', '!', '+', '>', '[', '\n'])

/** Keywords after which a `<` starts JSX rather than a comparison. */
const JSX_PRECEDING_WORDS = new Set(['return', 'yield', 'case', 'default', 'in', 'of', 'typeof', 'await'])

interface Frame {
  kind: 'code' | 'template' | 'jsx-tag' | 'jsx-children'
  /** `{` depth inside a code frame; the frame pops when it would go negative. */
  depth: number
  element: JsxElement | null
  /** For a code frame opened by a JSX `{`: the offset of that brace. */
  containerStart: number | null
  /**
   * For a template frame: the attribute or key the whole literal fills, resolved
   * ONCE at the opening backtick and carried by every chunk.
   *
   * Resolving per chunk instead was a measured defect: in
   * ``to={`${base}/contracts/redline`}`` only the first chunk sits next to
   * `to=`, so the segment naming the destination arrived attribute-less and the
   * reachability check reported a route that a link on screen plainly reaches.
   * Four such false positives in one product — the kind that gets a gate turned
   * off in a week.
   */
  templateAttribute?: string | null
}

/**
 * Lex one TS/TSX source.
 *
 * The loop keeps a frame stack. A code frame pops back to its JSX parent when
 * an unmatched `}` closes the expression container that opened it; a JSX tag
 * frame becomes a children frame at `>` and pops at `/>`.
 */
export function scanSource(text: string): ScannedSource {
  const segments: SourceSegment[] = []
  const elements: JsxElement[] = []
  const mask = new Array<string>(text.length)
  for (let i = 0; i < text.length; i++) mask[i] = text[i] as string

  /** Blank a range in the mask, keeping newlines so line numbers survive. */
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < text.length; i++) mask[i] = text[i] === '\n' ? '\n' : ' '
  }

  const stack: Frame[] = [{ kind: 'code', depth: 0, element: null, containerStart: null }]
  const top = (): Frame => stack[stack.length - 1] as Frame

  /** The element whose children (or tag) we are currently inside, if any. */
  const openElement = (): JsxElement | null => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const frame = stack[i] as Frame
      if (frame.kind === 'jsx-children' || frame.kind === 'jsx-tag') return frame.element
    }
    return null
  }

  /**
   * Offset of the `{` opening the innermost JSX expression container, or null
   * at the top of a return/assignment. Elements sharing a container are one
   * conditional branch — which is exactly the scope an empty state occupies.
   */
  const containerOf = (): number | null => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const frame = stack[i] as Frame
      if (frame.kind === 'code') return frame.containerStart
      if (frame.kind === 'jsx-children' || frame.kind === 'jsx-tag') return frame.element?.containerStart ?? null
    }
    return null
  }

  let i = 0
  while (i < text.length) {
    const frame = top()

    if (frame.kind === 'jsx-children') {
      i = readJsxChildren(i, frame)
      continue
    }
    if (frame.kind === 'jsx-tag') {
      i = readJsxTag(i, frame)
      continue
    }
    if (frame.kind === 'template') {
      i = readTemplateChunk(i)
      continue
    }
    i = readCode(i, frame)
  }

  return { text, segments, elements, masked: mask.join('') }

  // ── readers ────────────────────────────────────────────────────────────────

  function readCode(at: number, frame: Frame): number {
    const ch = text[at] as string

    if (ch === '/' && text[at + 1] === '/') {
      const end = indexOrEnd(text, '\n', at)
      segments.push({ kind: 'comment', start: at + 2, end, value: text.slice(at + 2, end) })
      blank(at, end)
      return end
    }
    if (ch === '/' && text[at + 1] === '*') {
      const close = text.indexOf('*/', at + 2)
      const end = close === -1 ? text.length : close + 2
      segments.push({ kind: 'comment', start: at + 2, end: end - 2, value: text.slice(at + 2, end - 2) })
      blank(at, end)
      return end
    }
    if (ch === '"' || ch === "'") {
      const end = readQuoted(text, at, ch)
      segments.push({ kind: 'string', start: at + 1, end: end - 1, value: text.slice(at + 1, end - 1) })
      blank(at + 1, end - 1)
      return end
    }
    if (ch === '`') {
      stack.push({
        kind: 'template',
        depth: 0,
        element: null,
        containerStart: containerOf(),
        templateAttribute: attributeOfTemplate(at + 1),
      })
      return at + 1
    }
    if (ch === '/' && isRegexStart(text, at)) {
      return skipRegex(text, at)
    }
    if (ch === '{') {
      frame.depth++
      return at + 1
    }
    if (ch === '}') {
      // Closing the expression container that opened this frame: pop back to JSX.
      if (frame.depth === 0 && stack.length > 1) {
        stack.pop()
        return at + 1
      }
      frame.depth--
      return at + 1
    }
    if (ch === '<' && startsJsx(text, at)) {
      return openTag(at)
    }
    return at + 1
  }

  function readTemplateChunk(at: number): number {
    let cursor = at
    while (cursor < text.length) {
      const ch = text[cursor] as string
      if (ch === '\\') {
        cursor += 2
        continue
      }
      if (ch === '`') {
        pushTemplate(at, cursor)
        stack.pop()
        return cursor + 1
      }
      if (ch === '$' && text[cursor + 1] === '{') {
        pushTemplate(at, cursor)
        stack.push({ kind: 'code', depth: 0, element: null, containerStart: containerOf() })
        return cursor + 2
      }
      cursor++
    }
    pushTemplate(at, cursor)
    stack.pop()
    return cursor
  }

  function pushTemplate(from: number, to: number): void {
    if (to <= from) return
    const owner = openElement()
    let attribute: string | null = null
    for (let i = stack.length - 1; i >= 0; i--) {
      const entry = stack[i] as Frame
      if (entry.kind === 'template') {
        attribute = entry.templateAttribute ?? null
        break
      }
    }
    segments.push({
      kind: 'template',
      start: from,
      end: to,
      value: text.slice(from, to),
      ...(attribute === null ? {} : { attribute }),
      ...(owner === null ? {} : { tag: owner.tag }),
    })
    blank(from, to)
  }

  /**
   * When a template literal is a JSX attribute value (`title={`…`}` or
   * `title=` + backtick), report the attribute so the vocabulary check can
   * treat it as copy. Resolved by looking back for `name=` immediately before
   * the frame that opened this template.
   */
  function attributeOfTemplate(from: number): string | null {
    let cursor = from - 1
    if (text[cursor] === '`') cursor--
    while (cursor >= 0 && /\s/.test(text[cursor] as string)) cursor--
    if (text[cursor] === '{') cursor--
    while (cursor >= 0 && /\s/.test(text[cursor] as string)) cursor--
    if (text[cursor] !== '=') return null
    cursor--
    const nameEnd = cursor + 1
    while (cursor >= 0 && IDENT_PART.test(text[cursor] as string)) cursor--
    const name = text.slice(cursor + 1, nameEnd)
    return name.length > 0 && IDENT_START.test(name[0] as string) ? name : null
  }

  function openTag(at: number): number {
    let cursor = at + 1
    let tag = ''
    if (text[cursor] === '>') {
      // Fragment `<>`.
      const element = makeElement('', at)
      stack.push({ kind: 'jsx-children', depth: 0, element, containerStart: null })
      element.openEnd = cursor + 1
      return cursor + 1
    }
    while (cursor < text.length && IDENT_PART.test(text[cursor] as string)) {
      tag += text[cursor] as string
      cursor++
    }
    const element = makeElement(tag, at)
    stack.push({ kind: 'jsx-tag', depth: 0, element, containerStart: null })
    return cursor
  }

  function makeElement(tag: string, at: number): JsxElement {
    const parent = openElement()
    const element: JsxElement = {
      tag,
      attributes: [],
      children: [],
      parent,
      start: at,
      openEnd: at,
      end: at,
      containerStart: containerOf(),
    }
    if (parent) parent.children.push(element)
    elements.push(element)
    return element
  }

  function readJsxTag(at: number, frame: Frame): number {
    const ch = text[at] as string
    if (/\s/.test(ch)) return at + 1
    const element = frame.element
    if (element === null) {
      stack.pop()
      return at + 1
    }
    if (ch === '/' && text[at + 1] === '>') {
      element.openEnd = at + 2
      element.end = at + 2
      stack.pop()
      return at + 2
    }
    if (ch === '>') {
      element.openEnd = at + 1
      stack.pop()
      stack.push({ kind: 'jsx-children', depth: 0, element, containerStart: null })
      return at + 1
    }
    if (ch === '{') {
      // Spread attribute `{...props}` or an expression value.
      stack.push({ kind: 'code', depth: 0, element, containerStart: at })
      return at + 1
    }
    if (!IDENT_START.test(ch)) return at + 1

    let cursor = at
    let name = ''
    while (cursor < text.length && IDENT_PART.test(text[cursor] as string)) {
      name += text[cursor] as string
      cursor++
    }
    let probe = cursor
    while (probe < text.length && /\s/.test(text[probe] as string)) probe++
    if (text[probe] !== '=') {
      element.attributes.push({ name, start: at, value: null, expression: false })
      return cursor
    }
    probe++
    while (probe < text.length && /\s/.test(text[probe] as string)) probe++
    const valueChar = text[probe]
    if (valueChar === '"' || valueChar === "'") {
      const end = readQuoted(text, probe, valueChar)
      const value = text.slice(probe + 1, end - 1)
      element.attributes.push({ name, start: at, value, expression: false })
      segments.push({
        kind: 'jsx-attribute',
        start: probe + 1,
        end: end - 1,
        value,
        attribute: name,
        tag: element.tag,
      })
      blank(probe + 1, end - 1)
      return end
    }
    element.attributes.push({ name, start: at, value: null, expression: true })
    return probe
  }

  function readJsxChildren(at: number, frame: Frame): number {
    let cursor = at
    while (cursor < text.length) {
      const ch = text[cursor] as string
      if (ch === '{') {
        pushJsxText(at, cursor, frame.element)
        stack.push({ kind: 'code', depth: 0, element: frame.element, containerStart: cursor })
        return cursor + 1
      }
      if (ch === '<') {
        pushJsxText(at, cursor, frame.element)
        if (text[cursor + 1] === '/') {
          const close = indexOrEnd(text, '>', cursor)
          const element = frame.element
          if (element) element.end = Math.min(close + 1, text.length)
          stack.pop()
          return Math.min(close + 1, text.length)
        }
        return openTag(cursor)
      }
      cursor++
    }
    pushJsxText(at, cursor, frame.element)
    stack.pop()
    return cursor
  }

  function pushJsxText(from: number, to: number, owner: JsxElement | null): void {
    if (to <= from) return
    const value = text.slice(from, to)
    if (value.trim().length === 0) return
    segments.push({
      kind: 'jsx-text',
      start: from,
      end: to,
      value,
      ...(owner === null ? {} : { tag: owner.tag }),
    })
    blank(from, to)
  }
}

/** Offset just past the closing quote of the literal starting at `at`. */
function readQuoted(text: string, at: number, quote: string): number {
  let cursor = at + 1
  while (cursor < text.length) {
    const ch = text[cursor]
    if (ch === '\\') {
      cursor += 2
      continue
    }
    if (ch === quote || ch === '\n') return cursor + 1
    cursor++
  }
  return text.length
}

function indexOrEnd(text: string, needle: string, from: number): number {
  const idx = text.indexOf(needle, from)
  return idx === -1 ? text.length : idx
}

/**
 * Does the `<` at `at` open JSX rather than a comparison or a type argument?
 *
 * The rule: JSX only appears in expression position, so the previous
 * non-whitespace character must be an operator/opener, or the previous word
 * must be one of a few keywords. `a < b` (identifier before) and
 * `useState<string>(…)` (identifier before) are both rejected by the same test.
 */
function startsJsx(text: string, at: number): boolean {
  const next = text[at + 1]
  if (next === undefined) return false
  if (next !== '>' && !IDENT_START.test(next)) return false

  let cursor = at - 1
  while (cursor >= 0 && /\s/.test(text[cursor] as string)) cursor--
  if (cursor < 0) return true
  const prev = text[cursor] as string
  if (JSX_PRECEDERS.has(prev)) return true
  if (!IDENT_PART.test(prev)) return false

  let wordEnd = cursor + 1
  while (cursor >= 0 && IDENT_PART.test(text[cursor] as string)) cursor--
  return JSX_PRECEDING_WORDS.has(text.slice(cursor + 1, wordEnd))
}

/** Is the `/` at `at` the start of a regex literal rather than a division? */
function isRegexStart(text: string, at: number): boolean {
  let cursor = at - 1
  while (cursor >= 0 && /\s/.test(text[cursor] as string)) cursor--
  if (cursor < 0) return true
  const prev = text[cursor] as string
  return '([{=,;:?&|!+*%<>~^'.includes(prev)
}

/** Offset just past a regex literal (body plus flags). */
function skipRegex(text: string, at: number): number {
  let cursor = at + 1
  let inClass = false
  while (cursor < text.length) {
    const ch = text[cursor]
    if (ch === '\\') {
      cursor += 2
      continue
    }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      cursor++
      while (cursor < text.length && /[a-z]/.test(text[cursor] as string)) cursor++
      return cursor
    } else if (ch === '\n') return cursor
    cursor++
  }
  return cursor
}

/** Line-start offsets, for `positionAt`. */
export function lineIndex(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

/** 1-based line/column of `offset`, given a `lineIndex` result. */
export function positionAt(starts: readonly number[], offset: number): SourcePosition {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] as number) <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: offset - (starts[lo] as number) + 1 }
}

/** The innermost element whose span contains `offset`. */
export function elementAt(elements: readonly JsxElement[], offset: number): JsxElement | null {
  let best: JsxElement | null = null
  for (const element of elements) {
    if (element.start > offset) break
    const end = element.end > element.start ? element.end : element.openEnd
    if (offset < end && (best === null || element.start >= best.start)) best = element
  }
  return best
}

/**
 * The nearest enclosing FUNCTION body containing `offset`, over MASKED text.
 *
 * Walks outward from the innermost block until one is introduced by `)` +
 * optional `=>`, `function …`, or a method head — the scope a handler occupies.
 * This is what keeps a check from joining a request in one handler to a success
 * message in another, which is the difference between a report worth reading
 * and one that gets the gate switched off.
 */
export function enclosingFunctionBlock(masked: string, offset: number): { start: number; end: number } | null {
  let block = enclosingBlock(masked, offset)
  while (block !== null) {
    const head = masked.slice(Math.max(0, block.start - 60), block.start)
    if (/(=>|\)|\bfunction\b|\bdo\b)\s*$/.test(head) && !/\b(if|for|while|switch|catch|try|else)\s*\)?\s*$/.test(head)) {
      return block
    }
    const outer = enclosingBlock(masked, block.start)
    if (outer === null || outer.start === block.start) return block
    block = outer
  }
  return null
}

/**
 * The innermost `{ … }` block containing `offset`, over MASKED text.
 * Returns null when `offset` sits at top level.
 */
export function enclosingBlock(masked: string, offset: number): { start: number; end: number } | null {
  let depth = 0
  let start = -1
  for (let i = offset - 1; i >= 0; i--) {
    const ch = masked[i]
    if (ch === '}') depth++
    else if (ch === '{') {
      if (depth === 0) {
        start = i
        break
      }
      depth--
    }
  }
  if (start === -1) return null

  depth = 0
  for (let i = start; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { start, end: i + 1 }
    }
  }
  return { start, end: masked.length }
}
