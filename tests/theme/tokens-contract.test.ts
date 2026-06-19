/**
 * The theme contract guard. Every CSS custom property a React surface consumes
 * via `var(--…)` MUST be defined in tokens.css — otherwise a consuming app that
 * loads `@tangle-network/agent-app/styles` still renders elements transparent
 * (the var resolves to nothing) with no error. This test fails loud the moment a
 * component references an undefined token or tokens.css drops a required one.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cssPath = join(repoRoot, 'src', 'theme', 'tokens.css')
const REACT_PKGS = ['design-canvas-react', 'sequences-react', 'studio-react', 'web-react']
const REQUIRED_ALIASES = [
  '--bg-input', '--text-primary', '--text-secondary', '--text-muted',
  '--text-danger', '--border-default', '--brand-primary',
]

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

function referencedVars(): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const pkg of REACT_PKGS) {
    for (const file of walk(join(repoRoot, 'src', pkg))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
        const name = m[1]
        if (!name) continue
        const list = map.get(name) ?? []
        list.push(file.replace(repoRoot + '/', ''))
        map.set(name, list)
      }
    }
  }
  return map
}

function definedVars(): Set<string> {
  const css = readFileSync(cssPath, 'utf8')
  const defs = new Set<string>()
  // A definition is `--name:` at the start of a (trimmed) line; RHS references
  // like `hsl(var(--card))` are mid-line and never counted as definitions.
  for (const m of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) if (m[1]) defs.add(m[1])
  return defs
}

/** Extract the body of the first brace-balanced block whose header matches `re`. */
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

/** Map of `--name` → trimmed value for every declaration in a block body. */
function blockDefs(body: string): Map<string, string> {
  const defs = new Map<string, string>()
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) if (m[1] && m[2]) defs.set(m[1], m[2].trim())
  return defs
}

const isAlias = (value: string) => /hsl\(\s*var\(/i.test(value)

describe('theme token contract', () => {
  it('every CSS var referenced by a React surface is defined in tokens.css', () => {
    const used = referencedVars()
    const defined = definedVars()
    const missing = [...used.keys()]
      .filter((v) => !defined.has(v))
      .map((v) => `${v} (used in ${used.get(v)?.[0]})`)
    expect(missing, `Undefined CSS vars referenced in components:\n${missing.join('\n')}`).toEqual([])
  })

  it('tokens.css defines every canonical alias the canvas/sequences packages consume', () => {
    const defined = definedVars()
    expect(REQUIRED_ALIASES.filter((v) => !defined.has(v))).toEqual([])
  })

  // Every CONCRETE :root token (a literal value, not an `hsl(var(--…))` alias)
  // must have a dark override, or the dark theme silently inherits the light
  // value. Aliases re-theme automatically through the cascade, so they're exempt
  // and must NOT be redefined in the dark block. THEME_INVARIANT lists tokens
  // intentionally identical across themes (currently none).
  const THEME_INVARIANT: string[] = []

  it('every concrete :root token has a dark override (light/dark parity)', () => {
    const css = readFileSync(cssPath, 'utf8')
    const root = blockDefs(blockBody(css, /:root\s*\{/))
    const dark = blockDefs(blockBody(css, /\[data-theme=['"]dark['"]\]\s*,\s*\.dark\s*\{/))

    const concrete = [...root].filter(([, v]) => !isAlias(v)).map(([k]) => k)
    const missing = concrete.filter((k) => !dark.has(k) && !THEME_INVARIANT.includes(k))
    expect(
      missing,
      `Concrete :root tokens lacking a [data-theme="dark"] override (dark inherits the light value):\n${missing.join('\n')}`,
    ).toEqual([])
  })

  it('aliases are not redefined in the dark block (they re-theme via the cascade)', () => {
    const css = readFileSync(cssPath, 'utf8')
    const root = blockDefs(blockBody(css, /:root\s*\{/))
    const dark = blockDefs(blockBody(css, /\[data-theme=['"]dark['"]\]\s*,\s*\.dark\s*\{/))

    const redundant = [...dark.keys()].filter((k) => root.has(k) && isAlias(root.get(k)!))
    expect(
      redundant,
      `Alias tokens redundantly redefined in the dark block (they already re-theme through the triples):\n${redundant.join('\n')}`,
    ).toEqual([])
  })
})

describe('no status-palette literals outside the allowlist', () => {
  // Tailwind palette literals (bg-green-500, text-rose-300, …) bypass the token
  // system and won't re-theme. The var()-completeness guard above can't see them.
  // This enforces ADOPTION: status colors must use the semantic tokens
  // (success/warning/destructive, or the --text-danger/--text-warning aliases).
  // Allowlist = deliberate NON-status palettes (clip kind-coding, print bleed).
  const ALLOW = [
    'sequences-react/components/TimelineClipChip.tsx', // video/audio/agent kind-coding
    'design-canvas-react/components/BleedTrimOverlay.tsx', // print bleed (red convention)
    'studio-react/type-config.ts', // media-type kind-coding (image/video/avatar/speech/transcription)
  ]
  const PALETTE = /(text|bg|border|ring|fill|stroke)-(rose|amber|emerald|green|red|yellow|lime|orange)-[0-9]/

  it('every status color uses a semantic token, not a raw palette literal', () => {
    const offenders: string[] = []
    for (const pkg of REACT_PKGS) {
      for (const file of walk(join(repoRoot, 'src', pkg))) {
        const rel = file.replace(repoRoot + '/src/', '')
        if (ALLOW.some((a) => rel.endsWith(a))) continue
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (PALETTE.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`)
        })
      }
    }
    expect(
      offenders,
      `Status colors must use tokens (success/warning/destructive). Offenders:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
