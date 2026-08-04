/**
 * Suppression: how a product says "this one is deliberate" without switching
 * the gate off.
 *
 * The design constraint is the whole reason this gate exists at all. A checker
 * that cannot be silenced per-line gets silenced per-repo — the config flag is
 * flipped once, in a rush, and nobody ever flips it back. So every finding is
 * individually suppressible; and because a silent suppression is
 * indistinguishable from a disabled check six months later, a suppression
 * without a written reason is ITSELF a finding, and does not suppress.
 *
 *   // legibility-ignore engineering-vocabulary — "conflict" is the term of art
 *   // a litigator uses; renaming it would make the screen less clear, not more
 *   <p>Conflict check cleared</p>
 *
 * Forms:
 *   - a comment on its own line suppresses the NEXT line that has content
 *   - a trailing comment suppresses ITS OWN line
 *   - `legibility-ignore-file <check>` suppresses the check for the whole file
 *   - several checks may be named, comma-separated
 *   - JSX comments (`{​/* … *​/}`) work, since they lex as comments too
 *
 * Honoured suppressions are returned, not swallowed: the report prints the
 * count and `--list-suppressions` prints every one with its reason, so the
 * exemptions stay as visible as the failures.
 */

import type { ScannedFile } from './scan'
import { LEGIBILITY_CHECKS, type LegibilityCheckId, type RawFinding } from './types'

/** Minimum characters of prose after the separator for a reason to count. */
const MIN_REASON = 12

const DIRECTIVE_RE = /legibility-ignore(-file)?\s+([^\n]*)/

/** One parsed directive. */
interface Directive {
  readonly checks: readonly LegibilityCheckId[]
  readonly reason: string
  /** Line the directive applies to; null for a whole-file directive. */
  readonly appliesToLine: number | null
  /** Line the directive itself is written on. */
  readonly line: number
  /** Named a check id that does not exist. */
  readonly unknownChecks: readonly string[]
  readonly hasReason: boolean
}

export interface SuppressionIndex {
  /** Decide a finding: honoured suppression, or not. */
  reasonFor(check: LegibilityCheckId, line: number): string | null
  /** Findings the suppression syntax itself produced (missing reason, unknown check). */
  readonly selfFindings: readonly RawFinding[]
}

const KNOWN = new Set<string>(LEGIBILITY_CHECKS)

/** Parse every `legibility-ignore` directive in one lexed file. */
export function buildSuppressionIndex(file: ScannedFile): SuppressionIndex {
  const directives: Directive[] = []
  const selfFindings: RawFinding[] = []

  for (const segment of file.scan.segments) {
    if (segment.kind !== 'comment') continue
    const match = DIRECTIVE_RE.exec(segment.value)
    if (!match) continue

    const wholeFile = match[1] === '-file'
    const rest = (match[2] ?? '').trim()
    const { names, reason } = splitDirective(rest)
    const known = names.filter((name): name is LegibilityCheckId => KNOWN.has(name))
    const unknownChecks = names.filter((name) => !KNOWN.has(name))
    const directiveLine = file.positionAt(segment.start + match.index).line
    const hasReason = reason.length >= MIN_REASON

    const offset = segment.start + match.index
    if (names.length === 0) {
      selfFindings.push({
        check: 'suppression-without-reason',
        offset,
        message: 'legibility-ignore names no check, so it is unclear what it excuses.',
        remedy: `Name the check and give a reason: legibility-ignore <${LEGIBILITY_CHECKS.slice(0, 2).join('|')}|…> — why this one is right.`,
        evidence: `legibility-ignore ${rest}`.trim(),
      })
      continue
    }
    for (const unknown of unknownChecks) {
      selfFindings.push({
        check: 'suppression-without-reason',
        offset,
        message: `legibility-ignore names "${unknown}", which is not a check — it suppresses nothing.`,
        remedy: `Use one of: ${LEGIBILITY_CHECKS.join(', ')}.`,
        evidence: `legibility-ignore ${rest}`.trim(),
      })
    }
    if (!hasReason && known.length > 0) {
      selfFindings.push({
        check: 'suppression-without-reason',
        offset,
        message: `legibility-ignore ${known.join(', ')} gives no reason, so it does not suppress anything.`,
        remedy: `Write why this instance is right after a dash: legibility-ignore ${known[0]} — <reason, ${MIN_REASON}+ characters>.`,
        evidence: `legibility-ignore ${rest}`.trim(),
      })
    }
    if (known.length === 0) continue

    directives.push({
      checks: known,
      reason,
      hasReason,
      unknownChecks,
      line: directiveLine,
      appliesToLine: wholeFile ? null : targetLine(file, segment.start, directiveLine),
    })
  }

  const honoured = directives.filter((directive) => directive.hasReason)

  return {
    selfFindings,
    reasonFor(check: LegibilityCheckId, line: number): string | null {
      for (const directive of honoured) {
        if (!directive.checks.includes(check)) continue
        if (directive.appliesToLine === null || directive.appliesToLine === line) return directive.reason
      }
      return null
    },
  }
}

/**
 * Split `engineering-vocabulary, silent-failure — because …` into names and
 * reason. The separator is an em dash, `--`, `-` or `:`; anything before the
 * first separator is the (comma- or space-separated) check list.
 */
function splitDirective(rest: string): { names: string[]; reason: string } {
  // The separator may open the directive (`legibility-ignore — because …`),
  // which names no check at all and must be reported as such rather than read
  // as a check called "—".
  const separator = /(?:^|\s)(?:—|–|--|-|:)\s|:\s/.exec(rest)
  const head = separator ? rest.slice(0, separator.index) : rest
  const reason = separator ? rest.slice(separator.index + separator[0].length).trim() : ''
  const names = head
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  return { names, reason }
}

/**
 * The line a non-file directive governs: its own line when code precedes it
 * (a trailing comment), otherwise the next line that has content.
 */
function targetLine(file: ScannedFile, commentStart: number, commentLine: number): number {
  const lineStart = file.lineStarts[commentLine - 1] ?? 0
  const before = file.text.slice(lineStart, commentStart).replace(/[{/*]/g, '').trim()
  if (before.length > 0) return commentLine

  for (let line = commentLine + 1; line <= file.lineStarts.length; line++) {
    const start = file.lineStarts[line - 1]
    if (start === undefined) break
    const end = file.lineStarts[line] ?? file.text.length
    const content = file.text.slice(start, end).trim()
    if (content.length === 0) continue
    // Walk past a stacked continuation of the directive itself.
    if (/^(\/\/|\*|\{?\/\*)/.test(content) && !/legibility-ignore/.test(content)) continue
    if (/legibility-ignore/.test(content)) continue
    return line
  }
  return commentLine + 1
}
