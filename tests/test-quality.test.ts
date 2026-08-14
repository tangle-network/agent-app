/**
 * The gate on the tests themselves: a test that cannot fail is worse than no
 * test, because it reports safety it does not provide.
 *
 * This repo has shipped that exact failure more than once — a suite that passed
 * over a streaming lane delivering nothing, because the tests encoded the same
 * wrong assumption the code did. The general fix is a habit (prove a new test
 * can fail: break the code, watch it go red, restore) and habits need a floor
 * under them. This is the floor: the mechanically-detectable subclass, where a
 * test asserts nothing at all, or asserts something that is true no matter what
 * the code does.
 *
 * What this CANNOT catch — stated plainly so nobody mistakes a green run here
 * for "my test is meaningful": a test with real assertions against a fixture
 * that shares the code's wrong assumption passes this gate and still proves
 * nothing. That case has no static signal; it is covered by the contributor
 * rule in AGENTS.md ("Prove a new test can fail"), not by this file.
 *
 * Deliberately NOT built: a mutation run over the PR's changed test files.
 * Re-running new tests against the pre-change source sounds like the same
 * check, but a regression test that PINS existing behaviour legitimately passes
 * on the old source, so the signal is mostly false positives — a gate people
 * learn to bypass is worse than the one they read.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const SEARCH_DIRS = ['src', 'tests']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) testFiles(full, out)
    else if (/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const FILES = SEARCH_DIRS.flatMap((d) => testFiles(join(ROOT, d)))

/** Body of every `it(...)` / `test(...)` in a source string, matched by brace
 *  balance from the callback's opening `{`. Regex alone cannot find the end of
 *  a nested block, and an under-matched body is what would make this gate
 *  silently useless. */
function testBodies(src: string): Array<{ title: string; body: string; index: number }> {
  const out: Array<{ title: string; body: string; index: number }> = []
  const opener = /\b(?:it|test)(?:\.(?:only|skip|todo|concurrent|sequential|fails|each|skipIf|runIf))*\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,/g
  for (const m of src.matchAll(opener)) {
    const title = m[2] ?? ''
    // `it.todo('…')` has no body; the opener regex requires a trailing comma so
    // those never reach here.
    let cursor = m.index + m[0].length
    // An options object (`it('…', { timeout: 30_000 }, async () => …)`) sits
    // between title and callback — brace-skip it, or the extractor reads the
    // OPTIONS as the body and reports a real test as assertion-free.
    if (src.slice(cursor).trimStart().startsWith('{')) {
      const optStart = src.indexOf('{', cursor)
      let optDepth = 0
      for (let i = optStart; i < src.length; i += 1) {
        if (src[i] === '{') optDepth += 1
        else if (src[i] === '}') {
          optDepth -= 1
          if (optDepth === 0) {
            cursor = i + 1
            break
          }
        }
      }
    }
    const braceStart = src.indexOf('{', cursor)
    if (braceStart === -1) continue
    let depth = 0
    let end = -1
    let inString: string | null = null
    for (let i = braceStart; i < src.length; i += 1) {
      const ch = src[i]!
      const prev = src[i - 1]
      if (inString) {
        if (ch === inString && prev !== '\\') inString = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inString = ch
        continue
      }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) continue
    out.push({ title, body: src.slice(braceStart, end + 1), index: m.index })
  }
  return out
}

/**
 * Anything that can make a test go red. Broad on purpose: a false ACCUSATION
 * here costs a contributor real time, so the gate only fires when a body has no
 * failure mechanism of any kind.
 *
 * The first run of this gate against `main` flagged five tests, and FOUR were
 * this list's fault, not the tests': `getByText(...)` throws when the node is
 * missing, `assertBillableBalance(...)` is a throwing function under test (the
 * word-boundary `\bassert\b` missed the camelCase name), and `expectTypeOf` is
 * checked by `tsc`, not vitest. Each is a real way for the test to fail, so
 * each is listed here rather than "fixed" in the test.
 */
const ASSERTION_SIGNALS = [
  /\bexpect\s*\(/,
  /\bexpect\./, // expect.assertions / expect.hasAssertions / expect.poll
  /\bassert[A-Za-z]*\s*\(/, // assert(...) and assertSomething(...) — throwing helpers
  /\bexpectTypeOf\b/, // compile-time assertion; `pnpm typecheck` is its runner
  /\bassertType\b/,
  /\b(?:get|find)(?:By|All)[A-Za-z]*\s*\(/, // testing-library queries throw on miss
  /\bthrow\b/,
  /\.rejects\b/,
  /\.resolves\b/,
  /toThrow/,
  /\btoMatchSnapshot\b/,
  /\btoMatchFileSnapshot\b/,
  /\bvi\.waitFor\b/,
  /\bvi\.waitUntil\b/,
]

/** A test may declare itself a print-only probe — output for a human to read,
 *  with nothing to assert. `model-probe.live.test.ts` is the real case: it
 *  exists to capture verbatim platform payloads so the failover tests assert
 *  against measured shapes instead of invented ones. The marker is required to
 *  be written down so "this asserts nothing" is a decision on the record, not
 *  an oversight nobody noticed. */
const PROBE_MARKER = 'test-quality:probe-only'

/** Assertions whose truth is independent of the code under test. Written as
 *  whole-expression patterns so a legitimate `expect(flag).toBe(true)` is not
 *  swept up — only a LITERAL compared to itself. */
const TAUTOLOGIES: Array<{ re: RegExp; why: string }> = [
  {
    re: /expect\s*\(\s*(true|false)\s*\)\s*\.\s*toBe\s*\(\s*(?:true|false)\s*\)/,
    why: 'compares a boolean literal to a boolean literal',
  },
  {
    re: /expect\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)\s*\.\s*(?:toBe|toEqual)\s*\(\s*\1\s*\)/,
    why: 'compares a number literal to itself',
  },
  {
    re: /expect\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)\s*\.\s*(?:toBe|toEqual)\s*\(\s*\1\2\1\s*\)/,
    why: 'compares a string literal to itself',
  },
  {
    re: /expect\s*\(\s*(?:true|false|-?\d+(?:\.\d+)?|\{\s*\}|\[\s*\])\s*\)\s*\.\s*(?:toBeDefined|toBeTruthy|toBeFalsy)\s*\(\s*\)/,
    why: 'asserts a literal is defined/truthy — true regardless of the code',
  },
]

describe('test-quality gate: every test can fail', () => {
  it('finds the repo test corpus (a walk that finds nothing would pass vacuously)', () => {
    expect(FILES.length).toBeGreaterThan(100)
  })

  it('the body extractor actually reaches the closing brace of a nested test', () => {
    const sample = `it('x', () => { if (a) { b() } expect(1).toBe(2) })`
    const [found] = testBodies(sample)
    expect(found?.title).toBe('x')
    expect(found?.body).toContain('expect(1).toBe(2)')
    // A brace-counting bug that stopped at the first `}` would miss the tail.
    expect(found?.body.endsWith('}')).toBe(true)
    // And the vitest options object is not mistaken for the body.
    const withTimeout = `it('slow', { timeout: 30_000 }, async () => { expect(1).toBe(1) })`
    const [slow] = testBodies(withTimeout)
    expect(slow?.title).toBe('slow')
    expect(slow?.body).toContain('expect(1).toBe(1)')
  })

  it('no test body is assertion-free', () => {
    const offenders: string[] = []
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8')
      const fileIsProbe = src.includes(PROBE_MARKER)
      for (const { title, body } of testBodies(src)) {
        if (fileIsProbe || body.includes(PROBE_MARKER)) continue
        if (!ASSERTION_SIGNALS.some((re) => re.test(body))) {
          offenders.push(`${relative(ROOT, file)} → "${title}"`)
        }
      }
    }
    expect(
      offenders,
      `these tests assert nothing, so they cannot fail — add a real assertion, ` +
        `or write "${PROBE_MARKER}" in the file if it is deliberately a print-only probe:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  it('no assertion is true regardless of the code', () => {
    const offenders: string[] = []
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8')
      for (const { title, body } of testBodies(src)) {
        for (const { re, why } of TAUTOLOGIES) {
          const hit = body.match(re)
          if (hit) offenders.push(`${relative(ROOT, file)} → "${title}": ${hit[0]} ${why}`)
        }
      }
    }
    expect(
      offenders,
      `these assertions pass no matter what the code does:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })
})
