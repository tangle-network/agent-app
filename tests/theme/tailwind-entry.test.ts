/**
 * `@tangle-network/agent-app/tailwind.css` is the one stylesheet an agent app
 * imports. It must compile every utility the shared packages write — Agent App,
 * Sandbox UI and ui — with no node_modules path in the app, and it must leave
 * the Agent App preset in charge of the names it maps.
 *
 * Compiles the BUILT entry (dist/theme/tailwind.css), so the `@source` lines are
 * resolved from the same place they are in an installed package.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const entry = join(root, 'dist/theme/tailwind.css')
const preset = join(root, 'dist/theme/tailwind-preset.js')

const shippedJs = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n')

let css = ''
let scratch = ''

beforeAll(async () => {
  if (!existsSync(entry)) throw new Error('dist/theme/tailwind.css is missing; run pnpm build first')
  // `source(none)` turns automatic detection off, so every shared class below
  // has to arrive through the entry's own `@source` lines. The stylesheet sits
  // under node_modules only so `tailwindcss` resolves from it.
  scratch = mkdtempSync(join(root, 'node_modules', '.agent-app-tailwind-entry-'))
  writeFileSync(join(scratch, 'tailwind.config.mjs'), `import preset from ${JSON.stringify(preset)}\nexport default { presets: [preset] }\n`)
  const from = join(scratch, 'app.css')
  const source = `@import 'tailwindcss' source(none);\n@import ${JSON.stringify(entry)};\n@config './tailwind.config.mjs';\n`
  writeFileSync(from, source)
  css = (await postcss([tailwindcss()]).process(source, { from })).css
}, 120_000)

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

describe('agent-app Tailwind source entry', () => {
  // Each marker is written by exactly one package's shipped JS. Provenance is
  // checked first so a marker that stops being unique fails instead of passing
  // for the wrong reason.
  const packages = {
    '@tangle-network/agent-app': () => shippedJs(join(root, 'dist')),
    '@tangle-network/sandbox-ui': () => shippedJs(join(root, 'node_modules/@tangle-network/sandbox-ui/dist')),
    '@tangle-network/ui': () => shippedJs(join(root, 'node_modules/@tangle-network/ui/dist')),
  }
  const markers = [
    { owner: '@tangle-network/agent-app', candidate: 'text-[12.5px]', selector: '.text-\\[12\\.5px\\]' },
    { owner: '@tangle-network/sandbox-ui', candidate: 'w-[17px]', selector: '.w-\\[17px\\]' },
    // ui's Dialog panel: the class apps lost when they scanned only sandbox-ui.
    { owner: '@tangle-network/ui', candidate: 'translate-x-[-50%]', selector: '.translate-x-\\[-50\\%\\]' },
  ] as const

  it.each(markers)('compiles $candidate from $owner', ({ owner, candidate, selector }) => {
    for (const [pkg, read] of Object.entries(packages)) {
      expect(read().includes(candidate), `${candidate} in ${pkg}'s shipped JS`).toBe(pkg === owner)
    }
    expect(css).toContain(selector)
  })

  it('carries the Brand, Sandbox UI and Agent App runtime CSS', () => {
    expect(css).toContain('--md3-surface-container-low')
    expect(css).toContain('--agent-app-accent-hsl')
    expect(css).toContain('.tangle-prose')
    expect(css).toContain('.text-\\[var\\(--text-dim\\)\\]')
  })

  it('emits each utility once', () => {
    const rules = css.match(/^\s*\.flex \{/gm) ?? []
    expect(rules).toHaveLength(1)
  })

  it('lets the Agent App preset decide a name Brand also registers', () => {
    // Brand maps border-border to hsl(var(--border)); the preset maps it to the
    // softer --border-soft tier. Sandbox UI imports Brand as theme(default) so
    // the preset still wins, as it did when the app compiled after a
    // precompiled bundle.
    const start = css.indexOf('.border-border ')
    expect(start).toBeGreaterThan(-1)
    expect(css.slice(start, css.indexOf('}', start))).toContain('--border-soft')
  })
})
