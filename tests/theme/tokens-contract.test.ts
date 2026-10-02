/** Contracts for the published Brand input and Agent App's public adapters. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

import { checkThemeContract } from '../../src/theme-contract/index'
import preset from '../../src/theme/tailwind-preset'
import { darkTheme, lightTheme, themeToCssVars } from '../../src/theme/theme'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const brandPath = createRequire(import.meta.url).resolve('@tangle-network/brand/styles/legacy-light.css')
const brand = readFileSync(brandPath, 'utf8')
const adapter = readFileSync(join(root, 'src/theme/tokens.css'), 'utf8')
const packed = readFileSync(join(root, 'dist/theme/tokens.css'), 'utf8')
const fields = ['background', 'foreground', 'card', 'popover', 'border', 'input', 'ring'] as const

describe('canonical Brand source', () => {
  it('ships the published source once, without a runtime CSS import', () => {
    expect(packed.split(brand)).toHaveLength(2)
    const imports: string[] = []
    postcss.parse(packed).walkAtRules('import', (rule) => { imports.push(rule.params) })
    expect(imports).toEqual([])
    expect(packed).not.toMatch(/url\(\s*['"]?https?:/)
  })

  it('keeps generated projections current with the installed Brand bytes', () => {
    const hash = createHash('sha256').update(brand).digest('hex')
    for (const file of ['brand.generated.ts', 'compat.generated.css']) {
      expect(readFileSync(join(root, 'src/theme', file), 'utf8')).toContain(hash)
    }
    expect(execFileSync(process.execPath, ['src/theme/build.mjs', '--stdout'], {
      cwd: root, encoding: 'utf8',
    })).toBe(packed)
  })

  it('authors no second color, radius, or motion palette in the adapter', () => {
    postcss.parse(adapter).walkDecls((declaration) => {
      if (!declaration.prop.startsWith('--')) return
      if (['--focus-ring-width', '--focus-ring-offset'].includes(declaration.prop)) {
        expect(declaration.value).toBe('2px')
        return
      }
      if (/^--duration-/.test(declaration.prop) && declaration.parent?.parent?.type === 'atrule') {
        expect(declaration.value).toBe('1ms')
        return
      }
      if (declaration.prop === '--stagger-step' && declaration.value === '0ms') return
      expect(declaration.value, declaration.prop).toContain('var(')
      expect(declaration.prop).not.toMatch(/^--neutral-/)
    })
    const bareRadius: string[] = []
    postcss.parse(packed).walkDecls('--radius', (declaration) => { bareRadius.push(declaration.value) })
    expect(bareRadius).toEqual([])
  })

  it('defines every variable used by the composed stylesheet and owned React surfaces', () => {
    const definitions = new Set<string>()
    const uses = new Set<string>()
    postcss.parse(packed).walkDecls((declaration) => {
      if (declaration.prop.startsWith('--')) definitions.add(declaration.prop)
      for (const match of declaration.value.matchAll(/var\(\s*(--[\w-]+)/g)) uses.add(match[1]!)
    })
    expect([...uses].filter((name) => !definitions.has(name))).toEqual([])
    const result = checkThemeContract({
      srcDirs: ['design-canvas-react', 'sequences-react', 'web-react', 'studio-react'].map((area) =>
        join(root, 'src', area)),
      tokensCss: join(root, 'src/theme/tokens.css'),
    })
    expect(result.missing).toEqual([])
  })
})

describe('legacy compatibility', () => {
  it('keeps HSL channels, distinct field fill, and concrete bitmap colors in each mode', () => {
    for (const theme of [lightTheme, darkTheme]) {
      for (const field of fields) expect(theme[field], field).toMatch(/^[\d.]+ [\d.]+% [\d.]+%$/)
      expect(theme.inputFill).toMatch(/^hsl\(/)
      expect(theme.inputFill).not.toBe(`hsl(${theme.input})`)
      expect(theme.inputFill).not.toBe(`hsl(${theme.card})`)
      for (const color of Object.values(theme.canvasRender)) expect(color).toMatch(/^#[a-f\d]{6}$/)
    }
  })

  it('retains old custom theme fallbacks', () => {
    const vars = themeToCssVars({ ...lightTheme, inputFill: undefined, warningStrong: undefined,
      borderSoft: undefined, cardEdge: undefined })
    expect(vars['--bg-input']).toBe(`hsl(${lightTheme.card})`)
    expect(vars['--warning-strong']).toBe(lightTheme.warningForeground)
    expect(vars['--border-soft']).toBe(`hsl(${lightTheme.border})`)
  })

  it('maps actual MD3 tiers and separates background wells from field edges', () => {
    const extension = preset.theme.extend
    expect(extension.colors['surface-container-high']).toBe('var(--md3-surface-container-high)')
    expect(extension.colors['surface-container-highest']).toBe('var(--md3-surface-container-highest)')
    expect(extension.colors.input).toBe('hsl(var(--input))')
    expect(extension.backgroundColor.input).toContain('var(--bg-input)')
    expect(extension.textColor.warning.DEFAULT).toBe('hsl(var(--warning-strong))')
    expect(extension.colors.warning.foreground).toBe('hsl(var(--warning-foreground))')
  })
})
