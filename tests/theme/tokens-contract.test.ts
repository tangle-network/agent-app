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
const REACT_PKGS = ['design-canvas-react', 'sequences-react', 'web-react']
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
