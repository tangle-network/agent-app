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
