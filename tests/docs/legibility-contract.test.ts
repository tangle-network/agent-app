/**
 * The legibility docs are a CONTRACT, not prose.
 *
 * `docs/product-surfaces.md` Part II states six patterns and
 * `docs/legibility-rubric.md` states the six questions a reviewer answers for
 * any UI diff. Both were written because a well-argued document did not change
 * behaviour: the verticals shipped 11-of-21 actionless empty states, an
 * engineering word in error copy, "Saved" over a 404, and two correct
 * deterministic engines with no way to reach them.
 *
 * The failure mode a doc has, and code does not, is silent decay: a pattern
 * loses its rejected example and becomes advice, a rubric question loses its
 * fail condition and becomes a prompt, a cited file is renamed and the evidence
 * points at nothing. None of that breaks a build. This test makes each of them
 * break one.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const surfacesPath = join(repoRoot, 'docs', 'product-surfaces.md')
const rubricPath = join(repoRoot, 'docs', 'legibility-rubric.md')

const surfaces = readFileSync(surfacesPath, 'utf8')
const rubric = readFileSync(rubricPath, 'utf8')

interface Section {
  /** The heading line without its `#` markers. */
  readonly heading: string
  /** Everything from the heading to the next heading at the same level. */
  readonly body: string
}

/**
 * Splits a document into the sections a heading pattern opens. `depth` is the
 * `#` count that pattern matches; a heading at that depth or shallower closes
 * the open section, so a pattern's own sub-headings stay inside its body.
 */
function sectionsMatching(markdown: string, headingPattern: RegExp, depth: number): Section[] {
  const sections: Section[] = []
  let current: { heading: string; lines: string[] } | undefined

  const flush = (): void => {
    if (current) sections.push({ heading: current.heading, body: current.lines.join('\n') })
    current = undefined
  }

  for (const line of markdown.split('\n')) {
    if (headingPattern.test(line)) {
      flush()
      current = { heading: line.replace(/^#+/, '').trim(), lines: [] }
      continue
    }
    const heading = /^(#+)\s/.exec(line)
    if (current && heading && (heading[1]?.length ?? 0) <= depth) {
      flush()
      continue
    }
    if (current) current.lines.push(line)
  }
  flush()
  return sections
}

/** The nth (1-indexed) section, or a loud failure naming which one is absent. */
function nth(sections: readonly Section[], n: number, label: string): Section {
  const section = sections[n - 1]
  if (!section) throw new Error(`${label} ${n} is missing from the document (found ${sections.length})`)
  return section
}

/** The `**Rejected…**` block of a pattern: from that marker to the section end. */
function rejectedBlock(body: string): string {
  const at = body.indexOf('**Rejected')
  return at === -1 ? '' : body.slice(at)
}

/** Strips fenced code blocks so a fence's own backticks cannot be read as an
 *  inline span, and sample JSON is not mistaken for a citation. */
function withoutFencedCode(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```/gm, '')
}

/** Every inline `code span` in the document, fenced blocks excluded. */
function inlineSpans(markdown: string): string[] {
  return [...withoutFencedCode(markdown).matchAll(/`([^`\n]+)`/g)].flatMap((m) => (m[1] ? [m[1]] : []))
}

/**
 * Citations that claim to point INSIDE this repo — a bare `src/…`, `tests/…` or
 * `docs/…` path. A cross-repo citation names its repo first
 * (`legal-agent src/routes.ts`) and is deliberately not matched: those files are
 * not on this repo's disk and cannot be checked here.
 */
function inRepoCitations(markdown: string): string[] {
  return inlineSpans(markdown)
    .filter((span) => /^(src|tests|docs)\//.test(span))
    .filter((span) => !span.includes('*')) // a glob (`src/**`) is a scope, not a citation
    .map((span) => span.replace(/:\d+(-\d+)?$/, '').replace(/,.*$/, ''))
}

describe('docs/product-surfaces.md Part II — the patterns are enforceable', () => {
  const patterns = sectionsMatching(surfaces, /^## Pattern (\d) — (.+)$/, 2)

  it('states all six patterns the verticals answered separately', () => {
    expect(patterns.map((p) => p.heading)).toEqual([
      'Pattern 1 — Empty state',
      'Pattern 2 — First run is a declared state',
      'Pattern 3 — Provenance affordance',
      'Pattern 4 — Motion vocabulary',
      'Pattern 5 — Density',
      'Pattern 6 — The capability rule',
    ])
  })

  it.each([1, 2, 3, 4, 5, 6])('pattern %i carries a Rule, an Anatomy and a Rejected example', (n) => {
    const { body } = nth(patterns, n, 'pattern')
    expect(body, `pattern ${n} has no **Rule.**`).toContain('**Rule.**')
    expect(body, `pattern ${n} has no **Anatomy**`).toMatch(/\*\*Anatomy/)
    expect(body, `pattern ${n} has no **Rejected** example`).toMatch(/\*\*Rejected/)
  })

  it.each([1, 2, 3, 4, 5, 6])('pattern %i attributes its rejected example to an audit or a dated measurement', (n) => {
    const block = rejectedBlock(nth(patterns, n, 'pattern').body)
    expect(block.length, `pattern ${n} has no rejected block to attribute`).toBeGreaterThan(0)
    const attributed = /\baudit\b/i.test(block) || /\b20\d\d-\d\d-\d\d\b/.test(block)
    expect(attributed, `pattern ${n}'s rejected example names neither an audit nor a measurement date`).toBe(true)
  })

  it.each([1, 2, 3, 4, 5, 6])('pattern %i cites something concrete in its rejected example', (n) => {
    const spans = inlineSpans(rejectedBlock(nth(patterns, n, 'pattern').body))
    expect(spans.length, `pattern ${n}'s rejected example cites no file, symbol or string`).toBeGreaterThan(0)
  })
})

describe('docs/legibility-rubric.md — the questions stay answerable', () => {
  const questions = sectionsMatching(rubric, /^### (\d)\. (.+)$/, 3)

  it('asks exactly six questions', () => {
    expect(questions.map((q) => q.heading)).toEqual([
      "1. Name this screen's job in one sentence.",
      '2. Name the next action.',
      '3. Trace one number to its source.',
      '4. Find any engineering word.',
      '5. Find any dead end.',
      '6. Describe first run.',
    ])
  })

  it.each([1, 2, 3, 4, 5, 6])('question %i states both a pass condition and a fail condition', (n) => {
    const { body } = nth(questions, n, 'question')
    expect(body, `question ${n} has no **Passes when**`).toMatch(/\*\*Passes when/)
    expect(body, `question ${n} has no **Fails when:**`).toContain('**Fails when:**')
  })

  it('names which failures block a diff', () => {
    expect(rubric).toMatch(/fail on 2, 3, or 5 blocks the diff/i)
  })

  it('ships a reviewer prompt an agent can run verbatim', () => {
    const fenced = [...rubric.matchAll(/^```([\s\S]*?)^```/gm)].map((m) => m[1] ?? '')
    const prompt = fenced.find((block) => block.includes('legibility rubric'))
    expect(prompt, 'no fenced reviewer prompt found').toBeDefined()
    for (const line of ['1 job', '2 next action', '3 number', '4 words', '5 dead ends', '6 first run']) {
      expect(prompt, `the reviewer prompt omits "${line}"`).toContain(line)
    }
  })
})

describe('both docs — in-repo citations point at files that exist', () => {
  it.each([
    ['docs/product-surfaces.md', surfaces],
    ['docs/legibility-rubric.md', rubric],
  ])('%s', (name, markdown) => {
    const citations = inRepoCitations(markdown)
    expect(citations.length, `${name} makes no in-repo citation at all`).toBeGreaterThan(0)
    const missing = citations.filter((path) => !existsSync(join(repoRoot, path)))
    expect(missing, `${name} cites files that do not exist`).toEqual([])
  })
})

/**
 * A citation that points at a file which still exists can still be false: the
 * count it asserts drifts the moment someone adds or deletes a usage, and
 * nothing about that turns a build red. Pattern 4's rejected example is built
 * out of exactly such counts, and the first draft of Pattern 6 shipped a
 * "returns zero hits" that a single grep disproved.
 *
 * So each measured count the document states about THIS package's source is
 * re-measured here from the source itself. Test files are excluded because a
 * rejected example is a claim about what ships, and a fixture asserting the
 * defect is not the defect.
 */
describe('docs/product-surfaces.md — measured counts still match the source', () => {
  const sourceFiles = walkSource(join(repoRoot, 'src'))

  /** Every `.ts`/`.tsx` under `src`, tests and type declarations excluded. */
  function walkSource(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        out.push(...walkSource(full))
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
      if (entry.name.endsWith('.d.ts')) continue
      out.push(full)
    }
    return out
  }

  /** How many shipped source files contain `needle`, and how many times total. */
  function countUsages(needle: string): { files: number; total: number } {
    let files = 0
    let total = 0
    for (const file of sourceFiles) {
      const hits = readFileSync(file, 'utf8').split(needle).length - 1
      if (hits > 0) {
        files += 1
        total += hits
      }
    }
    return { files, total }
  }

  /** The number the document states next to `phrase`, as in "appears **16 times**". */
  function statedCount(phrase: string): number {
    const bold = '\\*\\*(\\d+)[^*]*\\*\\*'
    const pattern = new RegExp(`\`${phrase}\`[^.\\n]*?${bold}|${bold}[^.\\n]*?\`${phrase}\``)
    const match = pattern.exec(surfaces)
    if (!match) throw new Error(`Pattern 4 no longer states a bolded count for \`${phrase}\``)
    return Number(match[1] ?? match[2])
  }

  it('the animate-pulse count in Pattern 4 is the count in src', () => {
    expect(countUsages('animate-pulse').total).toBe(statedCount('animate-pulse'))
  })

  it('every file Pattern 4 blames for animate-pulse still uses it', () => {
    const cited = inlineSpans(surfaces).filter((span) => /^src\/.*\.tsx$/.test(span))
    const blamed = cited.filter((path) => surfaces.includes(`\`${path}\``))
    const pulsing = blamed.filter((path) => {
      const full = join(repoRoot, path)
      return existsSync(full) && readFileSync(full, 'utf8').includes('animate-pulse')
    })
    expect(pulsing.length, 'Pattern 4 names no file that still pulses').toBeGreaterThan(0)
  })

  it('the animate-spin count in Pattern 4 is the count in src', () => {
    const stated = /\b(\w+)\s+`animate-spin` uses/.exec(surfaces)?.[1]
    if (!stated) throw new Error('Pattern 4 no longer states an `animate-spin` count')
    const words: Record<string, number | undefined> = { Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 }
    const expected = words[stated] ?? Number(stated)
    expect(Number.isFinite(expected), `unreadable animate-spin count "${stated}"`).toBe(true)
    expect(countUsages('animate-spin').total).toBe(expected)
  })

  it('the timing Pattern 4 blames the studio composer for is still gone', () => {
    // The blamed file was deleted by the composer rework, so the claim the doc
    // now makes is the one that has to hold: no studio surface writes its own
    // Tailwind duration, where the reduced-motion collapse cannot reach it.
    const studioDir = join(repoRoot, 'src', 'studio-react')
    const offenders = readdirSync(studioDir)
      .filter((name) => /\.(tsx?|css)$/.test(name))
      .filter((name) => /(^|[\s'"`:])duration-\d/.test(readFileSync(join(studioDir, name), 'utf8')))
    expect(offenders, 'these hardcode a Tailwind duration Pattern 4 says the studio no longer carries').toEqual([])
  })
})
