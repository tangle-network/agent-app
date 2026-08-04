/**
 * Check 2 — dead-end empty states.
 *
 * The defect, measured on one vertical: 21 empty states, 11 of them offering no
 * next action. A screen that says "No deadlines tracked yet" and nothing else
 * has told the reader they are in the right place and stranded them there. It
 * is the cheapest, most repeated legibility failure in the fleet, and it is
 * mechanically detectable: the empty branch renders no button, no link, no form
 * control.
 *
 * ── How the empty branch is scoped ───────────────────────────────────────────
 *
 * The interesting part is not finding the words, it is deciding what subtree
 * "the empty state" means. Walking up to the page root would find some button
 * somewhere and never report anything; stopping at the `<p>` would report every
 * empty state, action or not.
 *
 * The lexer records, for each element, the `{` of its enclosing JSX expression
 * container. Elements sharing a container are one conditional branch — exactly
 * how empty states are written:
 *
 *     {rows.length === 0 && (            ← container
 *       <div className="empty">          ← branch root, same container
 *         <p>No deadlines tracked yet</p>
 *       </div>
 *     )}
 *
 * So the branch root is the outermost ancestor sharing the text's container,
 * and the subtree searched for an action is exactly that branch. A component
 * that takes its empty copy as props (`emptyTitle="No sessions yet"`) is its own
 * root, and its action props are read the same way.
 *
 * Recall limit: copy held in a variable or returned from a helper is invisible
 * to a lexer, and an "action" reached only through a child component's internals
 * is assumed present when that component takes an action-shaped prop.
 *
 * ── A titled section's zero-state is not a dead end ──────────────────────────
 *
 * The one measured false-positive class, and the one that decides whether this
 * check survives contact with a team. A contract detail screen carries four
 * zero-states — "No parties recorded.", "No open findings.", "No resolved
 * findings yet.", "No renewal alerts configured." — one under each `<h2>`. None
 * of them strands anybody: the screen is full, the reader is oriented, and the
 * line is the honest label for a section that is empty. Reporting all four (and
 * a table's "No findings." beside its own Run button, and a kanban column's "No
 * filings") buries the defect this check exists for — the screen whose ENTIRE
 * body is "No deadlines tracked yet".
 *
 * So a branch whose nearest preceding SIBLING is a heading is a section label
 * and is not reported. Measured over two production verticals: 21 findings → 12,
 * removing 8 section labels and 1 success state, and keeping every page-level
 * dead end. The recall cost is a real one — a screen whose whole body is one
 * titled, actionless section reads as a section here — and `emptyState:
 * { reportSectionZeroStates: true }` turns it back on.
 */

import { elementAt, type JsxElement } from '../source'
import type { ScannedFile } from '../scan'
import type { EmptyStateOptions, RawFinding } from '../types'

/**
 * Copy that means "there is nothing here". Anchored at the start of the text
 * for the "No …" family so a sentence merely containing "no" is not a match.
 */
const EMPTY_PATTERNS: readonly RegExp[] = [
  /^no\b/i,
  /^none\b/i,
  /^nothing\b/i,
  /^0\s+\w+\s+(found|yet)/i,
  /\bnothing (here|yet|to show|to do|to review)\b/i,
  /\bnot(hing)? found\b/i,
  /\bis empty\b/i,
  /\bno (results|items|data|matches|records|files|entries)\b/i,
  /\byou (have|haven't|don't have) (no|any)\b/i,
]

/** Tags that are an action on their own. */
const ACTION_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'form', 'link', 'navlink'])

/** Props that make any element an action. */
const ACTION_PROPS = new Set([
  'onclick',
  'onsubmit',
  'onchange',
  'onselect',
  'onpress',
  'ontoggle',
  'href',
  'to',
  'action',
  'onaction',
  'oncta',
  'emptyaction',
  'emptycta',
  'onemptyaction',
  'primaryaction',
])

/**
 * A prop is also an action when its NAME ends like one. A component that takes
 * its empty copy as props takes its next action the same way, and the names are
 * the product's: `newSessionHref`, `onCreateClick`, `uploadAction`, `primaryCta`.
 * Measured: the exact-name list alone reported a history panel that ships a
 * "New chat" button, because the button arrives as `newSessionHref`.
 */
const ACTION_PROP_SUFFIX = /(href|action|cta|click|submit|press|link)$/i

/** Props whose value is empty-state copy on a component that renders it. */
const EMPTY_COPY_PROPS = /^empty[A-Z]/

/** `h1`–`h6`, and the component libraries' spelling of the same thing. */
const HEADING_TAG = /^h[1-6]$/i
const HEADING_SUFFIX = /(heading|title)$/i

/** Run the dead-end empty-state check over one lexed file. */
export function checkEmptyStates(file: ScannedFile, options: EmptyStateOptions = {}): RawFinding[] {
  const actionTags = new Set([...ACTION_TAGS, ...(options.extraActionTags ?? []).map((tag) => tag.toLowerCase())])
  const actionProps = new Set([...ACTION_PROPS, ...(options.extraActionProps ?? []).map((prop) => prop.toLowerCase())])
  const patterns = [...EMPTY_PATTERNS, ...(options.extraEmptyPatterns ?? []).map((source) => new RegExp(source, 'i'))]

  const findings: RawFinding[] = []
  const reported = new Set<number>()

  const iterations = options.reportSectionZeroStates === true ? [] : listIterations(file.scan.masked)

  const report = (root: JsxElement, offset: number, copy: string, viaProp: string | null): void => {
    if (reported.has(root.start)) return
    reported.add(root.start)
    if (hasAction(file, root, actionTags, actionProps)) return
    if (options.reportSectionZeroStates !== true && labelsATitledSection(file, root)) return
    if (iterations.some((span) => root.start > span.start && root.start < span.end)) return
    findings.push({
      check: 'dead-end-empty-state',
      offset,
      message: `Empty state "${clip(copy)}" offers no next action${viaProp === null ? '' : ` (${viaProp})`}.`,
      remedy:
        'Put the one thing the reader should do next inside this branch — a button, a link, or the control that creates the first item. If nothing can be done here, say why in the copy.',
      evidence: clip(copy),
    })
  }

  // Empty copy rendered as JSX text.
  for (const segment of file.scan.segments) {
    if (segment.kind !== 'jsx-text') continue
    const text = segment.value.trim()
    if (!patterns.some((pattern) => pattern.test(text))) continue
    const element = elementAt(file.scan.elements, segment.start)
    if (element === null) continue
    report(branchRoot(element), segment.start, text, null)
  }

  // Empty copy handed to a component as props.
  for (const element of file.scan.elements) {
    const copyProp = element.attributes.find(
      (attribute) => EMPTY_COPY_PROPS.test(attribute.name) && attribute.value !== null,
    )
    if (!copyProp?.value) continue
    report(element, copyProp.start, copyProp.value, `via ${copyProp.name}`)
  }

  return findings.sort((left, right) => left.offset - right.offset)
}

/**
 * The outermost ancestor that shares this element's expression container — the
 * whole conditional branch, and nothing outside it.
 */
function branchRoot(element: JsxElement): JsxElement {
  let root = element
  while (root.parent !== null && root.parent.containerStart === element.containerStart) root = root.parent
  return root
}

/**
 * The spans of every `.map(…)` callback in the file. A zero-state rendered
 * INSIDE one is a per-item placeholder — an empty kanban column, a deal with no
 * documents yet, a compliance row reading "No findings." beside its own Run
 * button — and the screen around it is full. The screen-level empty state this
 * check exists for is never rendered once per row.
 */
function listIterations(masked: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  for (const match of masked.matchAll(/\.\s*map\s*\(/g)) {
    const open = (match.index ?? 0) + (match[0]?.length ?? 1) - 1
    const end = matchingParen(masked, open)
    if (end !== -1) spans.push({ start: open, end })
  }
  return spans
}

function matchingParen(masked: string, open: number): number {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * Is this branch the zero-state of a titled section — a heading, then the
 * conditional that renders either the section's rows or the line saying there
 * are none? The heading is what makes it a section of a screen rather than the
 * screen, and a reader looking at a headed, empty section is oriented.
 */
function labelsATitledSection(file: ScannedFile, root: JsxElement): boolean {
  let previous: JsxElement | null = null
  for (const element of file.scan.elements) {
    if (element.start >= root.start) break
    if (element.parent !== root.parent) continue
    previous = element
  }
  if (previous === null) return false
  const tag = previous.tag.split('.').pop() ?? previous.tag
  return HEADING_TAG.test(tag) || HEADING_SUFFIX.test(tag)
}

/** Does anything in this subtree let the reader act? */
function hasAction(
  file: ScannedFile,
  root: JsxElement,
  actionTags: ReadonlySet<string>,
  actionProps: ReadonlySet<string>,
): boolean {
  const end = root.end > root.start ? root.end : root.openEnd
  for (const element of file.scan.elements) {
    if (element.start < root.start) continue
    if (element.start >= end) break
    if (isActionTag(element.tag, actionTags)) return true
    if (
      element.attributes.some(
        (attribute) =>
          actionProps.has(attribute.name.toLowerCase()) || ACTION_PROP_SUFFIX.test(attribute.name),
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * `button`/`a`/`Link`, anything named `…Button` / `…Link` / `…Cta`, and any
 * member expression ending in one (`Card.Button`). Component libraries rename
 * constantly; the suffix rule keeps the check from needing their catalogue.
 */
function isActionTag(tag: string, actionTags: ReadonlySet<string>): boolean {
  const base = (tag.split('.').pop() ?? tag).toLowerCase()
  if (actionTags.has(base)) return true
  return /(button|link|cta|anchor|action)$/.test(base)
}

function clip(value: string, max = 72): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
