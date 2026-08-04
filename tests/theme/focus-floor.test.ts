/**
 * The keyboard-focus floor, guarded from both sides.
 *
 * The floor itself is one rule in tokens.css, and a rule alone is not enough:
 * a `.outline-none` utility carries the SAME specificity as `:focus-visible`,
 * so any component that suppresses the outline without drawing a replacement
 * silently wins and leaves a keyboard user with nothing. CSS cannot tell a
 * deliberate opt-out from a forgotten one. This test can, so the two halves are
 * asserted together:
 *
 *   1. the floor exists and is driven by tokens (not a hard-coded colour), and
 *   2. no component suppresses focus without providing something visible.
 *
 * A suppression is accepted when the SAME class string draws a replacement, or
 * when the element it sits on cannot be reached by Tab at all (`tabIndex={-1}`,
 * a Radix `Dialog.Content`), or when the container around it carries the
 * indicator through `focus-within:`. Those are read from the lines around the
 * declaration rather than from an allowlist keyed on file name, so moving code
 * between files cannot launder an unjustified suppression.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const srcRoot = join(repoRoot, 'src')
const tokensCss = readFileSync(join(srcRoot, 'theme', 'tokens.css'), 'utf8')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walk(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Body of the first brace-balanced block whose header matches `re`. */
function blockBody(css: string, re: RegExp): string {
  const start = css.search(re)
  if (start < 0) throw new Error(`no block matching ${re}`)
  const open = css.indexOf('{', start)
  let depth = 0
  let i = open
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) break
  }
  return css.slice(open + 1, i)
}

// Any spelling of "remove the outline", with or without a variant prefix.
const SUPPRESSION = /(?:^|[\s'"`])(?:[a-z-]+:)?outline-none(?=[\s'"`]|$)/

/**
 * Comments are not styles. A doc comment explaining why a suppression was
 * REMOVED contains the same token as the suppression itself, and scanning it
 * would report the explanation as the defect — which is how a guard teaches
 * people to stop writing the explanation.
 */
function stripComments(line: string): string {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return ''
  return line.replace(/\s\/\/(?!\/).*$/, '')
}

// Something a keyboard user can actually see, drawn by the same class string.
const REPLACEMENT = [
  /focus-visible:ring-\S/,
  /focus:ring-\S/,
  /focus-visible:border-\S/,
  /focus:border-\S/,
  /\[outline-offset:/,
  /ring-inset/,
]

// Reasons a suppression is legitimate, read from the surrounding element.
const CONTEXT_JUSTIFICATION = [
  /tabIndex=\{-1\}/, // never reached by Tab; focus here is programmatic
  /Dialog\.Content/, // same, via the dialog library's own focus management
  /focus-within:/, // the container around it draws the indicator
]
const LOOK_BEHIND = 30
const LOOK_AHEAD = 6

describe('keyboard focus floor', () => {
  it('tokens.css defines a :focus-visible floor driven by the ring tokens', () => {
    const floor = blockBody(tokensCss, /(^|\n)\s*:focus-visible\s*\{/)

    expect(floor).toMatch(/outline:\s*var\(--focus-ring-width\)\s+solid\s+var\(--focus-ring-color\)/)
    expect(floor).toMatch(/outline-offset:\s*var\(--focus-ring-offset\)/)

    const root = blockBody(tokensCss, /(^|\n)\s*:root\s*\{/)
    for (const token of ['--focus-ring-width', '--focus-ring-offset', '--focus-ring-color']) {
      expect(root, `${token} must be defined in :root`).toContain(`${token}:`)
    }
    // The colour resolves THROUGH `--ring`, which is what makes the dark scope
    // re-theme it by the same cascade as every other token in the file. A
    // literal here would be invisible in exactly one theme.
    expect(root).toMatch(/--focus-ring-color:\s*hsl\(var\(--ring\)\)/)
  })

  it('no component suppresses focus without a visible replacement', () => {
    const offenders: string[] = []

    for (const file of walk(srcRoot)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((raw, index) => {
        const line = stripComments(raw)
        if (!SUPPRESSION.test(line)) return
        if (REPLACEMENT.some((re) => re.test(line))) return
        const context = lines.slice(Math.max(0, index - LOOK_BEHIND), index + LOOK_AHEAD + 1).join('\n')
        if (CONTEXT_JUSTIFICATION.some((re) => re.test(context))) return
        offenders.push(`${relative(repoRoot, file)}:${index + 1}`)
      })
    }

    expect(
      offenders,
      'These suppress the focus outline and draw nothing in its place. Either delete the ' +
        '`outline-none` and let the tokens.css floor apply, or draw a replacement on the same element.',
    ).toEqual([])
  })
})
