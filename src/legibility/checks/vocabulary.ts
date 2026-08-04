/**
 * Check 1 — engineering vocabulary on screen.
 *
 * The defect: a word from the codebase reaches the reader. Shipped instances
 * include "materialized" inside a user-facing error, a column of `sourceKind`,
 * and a chip reading `undefined`. Nobody decided to say those words; they leaked
 * because the label and the field name were the same string.
 *
 * ── Precision over recall, deliberately ──────────────────────────────────────
 *
 * A vocabulary gate lives or dies on false positives: one bad report and the
 * check is disabled, after which it guards nothing. `grep -i artifact` over one
 * product's `apps/web/src` returns 11 hits, all of them imports, prop names or
 * doc comments — a checker that reports those is deleted in a week.
 *
 * So this check only reads positions the lexer PROVES are copy, in two tiers
 * that are ON by default:
 *
 *  1. JSX text — `<p>No artifact yet</p>`. Unambiguous.
 *  2. A JSX attribute value, when the attribute is in {@link COPY_KEYS}. An
 *     allowlist, so `className`, `data-*`, `aria-*`, `id`, `href` and every
 *     other internal attribute are excluded by construction rather than by a
 *     denylist that goes stale.
 *  3. The first argument of a call in {@link COPY_CALLS} — `toast.error('…')`,
 *     `new Error('…')`, `setError('…')`. This is the tier that catches the
 *     flagship defect: "materialization" reached a reader from a `new Error`
 *     in a server module, not from a component.
 *
 * And ONE tier that is off by default, `includeObjectCopy`:
 *
 *  4. A string or template filling an object key named in {@link COPY_KEYS}
 *     (`emptyTitle: '…'`, `description: '…'`).
 *
 * Tier 4 is off because it was MEASURED as the false-positive tier. Over two
 * production verticals it produced findings on a system prompt (`prompt:` in an
 * agent profile), an MCP tool description the model reads, and the body of a
 * legal document template where "Records" is a term of the drafted document —
 * none of them on any screen. A key named `description` is model-facing about
 * as often as it is reader-facing, and a checker that cannot tell them apart
 * must not be the one that fails the build. Products whose data modules really
 * do hold UI copy turn it on.
 *
 * Everything else — a bare string in code, an import specifier, a comment, an
 * identifier, a test file — is not read at all. The cost is real recall: copy
 * assembled through a variable (`const msg = base + suffix`) is invisible here,
 * and no lexer can see it. That is the trade this check makes on purpose.
 */

import type { ScannedFile } from '../scan'
import type { SourceSegment } from '../source'
import type { BannedTerm, RawFinding, VocabularyOptions } from '../types'

/**
 * The default list. Every entry has shipped to a real screen in this fleet or
 * its verticals, and every one carries the sentence that replaces it — a gate
 * that only says "don't" leaves the author to guess.
 */
export const DEFAULT_BANNED_TERMS: readonly BannedTerm[] = [
  { term: 'materialize', instead: 'say what the reader gets: "your documents are ready"' },
  { term: 'materialized', instead: 'say what the reader gets: "your documents are ready"' },
  { term: 'materializing', instead: 'say what is happening: "getting your documents ready"' },
  { term: 'materialization', instead: 'say what is happening: "getting your documents ready"' },
  { term: 'fact', instead: 'name the thing: "the figure we found", "the wage entry"' },
  { term: 'facts', instead: 'name the things: "the figures we found", "wage entries"' },
  { term: 'conflict', instead: 'say what disagrees: "two documents report different wages"' },
  { term: 'conflicts', instead: 'say what disagrees: "two documents report different wages"' },
  { term: 'proposed', instead: 'say who acts next: "needs your approval"' },
  { term: 'workspace', instead: 'name the container the reader recognises: "account", "client", "matter"' },
  { term: 'record', instead: 'name the domain object: "return", "matter", "contact"' },
  { term: 'records', instead: 'name the domain objects: "returns", "matters", "contacts"' },
  { term: 'artifact', instead: 'name the deliverable: "return", "redline", "brief"' },
  { term: 'artifacts', instead: 'name the deliverables: "returns", "redlines", "briefs"' },
  { term: 'work product', instead: 'name the deliverable the reader asked for' },
  { term: 'OCR', instead: 'say what happened: "we read your scan"' },
  { term: 'extraction', instead: 'say what happened: "what we found in your documents"' },
  { term: 'superseded', instead: '"replaced by a newer version"' },
  { term: 'sourceKind', instead: 'an internal field name — write the label the reader reads' },
  { term: 'itemKey', instead: 'an internal field name — write the label the reader reads' },
  { term: 'payload', instead: 'name what was sent: "your answers", "the document"' },
  { term: 'null', instead: 'a value the code failed to fill — render the real value or written fallback copy' },
  { term: 'undefined', instead: 'a value the code failed to fill — render the real value or written fallback copy' },
]

/**
 * Attributes and object keys whose string value is copy. An allowlist: an
 * attribute that is not here is never read, which is how `aria-label`,
 * `className`, `data-testid` and `href` stay out without being enumerated.
 */
export const COPY_KEYS: readonly string[] = [
  'title',
  'label',
  'placeholder',
  'alt',
  'description',
  'heading',
  'subheading',
  'subtitle',
  'message',
  'tooltip',
  'caption',
  'summary',
  'hint',
  'helper',
  'helperText',
  'error',
  'errorMessage',
  'emptyTitle',
  'emptyDescription',
  'emptyLabel',
  'emptyMessage',
  'emptyText',
  'cta',
  'ctaLabel',
  'confirmLabel',
  'cancelLabel',
  'submitLabel',
  'actionLabel',
  'buttonLabel',
  'headline',
  'copy',
  'note',
  'notice',
  'warning',
  'question',
]

/** Calls whose first string argument reaches the reader. */
export const COPY_CALLS: readonly string[] = [
  'toast',
  'toast.success',
  'toast.error',
  'toast.info',
  'toast.warning',
  'toast.message',
  'alert',
  'confirm',
  'notify',
  'Error',
  'setError',
  'setErrorMessage',
  'setMessage',
  'setNotice',
  'setWarning',
]

interface CompiledTerm {
  readonly term: BannedTerm
  readonly re: RegExp
}

function compile(terms: readonly BannedTerm[]): CompiledTerm[] {
  return terms.map((term) => ({
    term,
    // Whitespace in a term matches any run of whitespace, so "work product"
    // still matches across a wrapped line of JSX text.
    re: new RegExp(`(?<![\\w-])${escape(term.term).replace(/\\?\s+/g, '\\s+')}(?![\\w-])`, 'gi'),
  }))
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Run the vocabulary check over one lexed file. */
export function checkVocabulary(file: ScannedFile, options: VocabularyOptions = {}): RawFinding[] {
  const allow = new Set((options.allowTerms ?? []).map((term) => term.toLowerCase()))
  const base = options.terms ?? DEFAULT_BANNED_TERMS
  const terms = compile(
    [...base, ...(options.extraTerms ?? [])].filter((entry) => !allow.has(entry.term.toLowerCase())),
  )
  const copyKeys = new Set([...COPY_KEYS, ...(options.extraCopyKeys ?? [])].map((key) => key.toLowerCase()))
  const copyCalls = new Set([...COPY_CALLS, ...(options.extraCopyCalls ?? [])].map((call) => call.toLowerCase()))

  const findings: RawFinding[] = []
  for (const segment of file.scan.segments) {
    const visible = visibleCopy(file, segment, {
      copyKeys,
      copyCalls,
      includeObjectCopy: options.includeObjectCopy === true,
    })
    if (visible === null) continue

    for (const { term, re } of terms) {
      re.lastIndex = 0
      for (const match of segment.value.matchAll(re)) {
        const offset = segment.start + (match.index ?? 0)
        findings.push({
          check: 'engineering-vocabulary',
          offset,
          message: `"${match[0]}" is a word from the codebase, on screen in ${visible}.`,
          remedy: `Write what the reader needs: ${term.instead}.`,
          evidence: segment.value.replace(/\s+/g, ' ').trim().slice(0, 100),
        })
      }
    }
  }
  return findings
}

interface VisibilityContext {
  readonly copyKeys: ReadonlySet<string>
  readonly copyCalls: ReadonlySet<string>
  readonly includeObjectCopy: boolean
}

/**
 * Is this segment copy, and if so what kind? Returns a short description used
 * in the message, or null when the segment is code the reader never sees.
 */
function visibleCopy(file: ScannedFile, segment: SourceSegment, context: VisibilityContext): string | null {
  const { kind, attribute, start } = segment
  if (kind === 'comment') return null
  if (kind === 'jsx-text') return 'rendered text'

  const named = attribute !== undefined && context.copyKeys.has(attribute.toLowerCase())
  // A JSX attribute — including one filled by a template literal — is copy only
  // when the attribute itself is on the allowlist.
  if (kind === 'jsx-attribute') return named ? `the ${attribute} attribute` : null
  if (named && segment.tag !== undefined) return `the ${attribute} attribute`

  return codeContext(file, start, context)
}

/**
 * Classify a string/template literal by the code immediately before it, read
 * off the MASKED source so a lookalike inside another string cannot match.
 */
function codeContext(file: ScannedFile, start: number, context: VisibilityContext): string | null {
  const from = Math.max(0, start - 90)
  const before = file.scan.masked.slice(from, Math.max(from, start - 1))

  const call = /(?:new\s+)?([A-Za-z_$][\w$.]*)\s*\(\s*$/.exec(before)
  if (call?.[1] && context.copyCalls.has(call[1].toLowerCase())) return `${call[1]}(…)`

  if (!context.includeObjectCopy) return null
  const key = /([A-Za-z_$][\w$]*)\s*[:=]\s*$/.exec(before)
  if (key?.[1] && context.copyKeys.has(key[1].toLowerCase())) return `the ${key[1]} value`

  return null
}
