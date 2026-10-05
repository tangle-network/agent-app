/** Exercise the real theme builder without mutating the installed Brand package. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import postcss from 'postcss'
import { afterEach, describe, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const brand = readFileSync(require.resolve('@tangle-network/brand/styles/legacy-light.css'), 'utf8')
const outputs = ['compat.generated.css', 'brand.generated.ts']
const scratch: string[] = []

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(source = brand) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-app-primary-contrast-'))
  scratch.push(directory)
  const theme = join(directory, 'src/theme')
  const styles = join(directory, 'node_modules/@tangle-network/brand/styles')
  mkdirSync(theme, { recursive: true })
  mkdirSync(styles, { recursive: true })
  for (const name of ['build.mjs', 'tokens.css', 'tailwind.css', ...outputs]) {
    copyFileSync(join(root, 'src/theme', name), join(theme, name))
  }
  writeFileSync(join(styles, 'legacy-light.css'), source)
  // Resolve the real parser and its own dependencies through its installed path.
  symlinkSync(dirname(require.resolve('postcss/package.json')), join(directory, 'node_modules/postcss'), 'junction')
  return { directory, theme }
}

function build(directory: string, mode: string) {
  const result = spawnSync(process.execPath, ['src/theme/build.mjs', mode], {
    cwd: directory, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  return result
}

function recolor(mode: 'light' | 'dark', ink: string) {
  const css = postcss.parse(brand)
  const rule = css.nodes.find((node) => node.type === 'rule'
    && node.selectors.includes(`.${mode}`)
    && (mode === 'dark' || !node.selectors.includes('.dark'))
    && node.nodes.some((child) => child.type === 'decl' && child.prop === '--hsl-background'))
  assert.ok(rule && rule.type === 'rule', `Missing Brand ${mode} base scope`)
  let changed = 0
  rule.walkDecls('--accent-text', (declaration) => { declaration.value = ink; changed++ })
  assert.equal(changed, 1)
  return css.toString()
}

// Independent HSL conversion for assertions on the builder's emitted channels.
function rgb(hsl: string) {
  const match = /^([\d.]+) ([\d.]+)% ([\d.]+)%$/.exec(hsl)
  assert.ok(match, `Expected HSL channels: ${hsl}`)
  const h = (Number(match[1]) / 60) % 6, s = Number(match[2]) / 100, l = Number(match[3]) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2
  const sectors = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]]
  return sectors[Math.floor(h)]!.map((channel) => channel + m)
}
const hex = (hsl: string) => '#' + rgb(hsl).map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')
const luminance = (hsl: string) => rgb(hsl)
  .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0)
const contrast = (ink: string, background: string) => {
  const a = luminance(ink), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

describe('primary text build contract (ops-board #1824)', () => {
  it('keeps light #5047eb and dark #a5b4fc with AA contrast on #161616', () => {
    const { directory, theme } = fixture()
    const result = build(directory, '--write')
    assert.equal(result.status, 0, result.stderr)
    const generated = readFileSync(join(theme, 'brand.generated.ts'), 'utf8')
    const match = /export const brandThemes = ([\s\S]+) as const/.exec(generated)
    assert.ok(match)
    const themes = JSON.parse(match[1]!) as Record<'light' | 'dark', { primary: string; background: string }>
    assert.equal(hex(themes.light.primary), '#5047eb')
    assert.equal(hex(themes.dark.primary), '#a5b4fc')
    assert.equal(hex(themes.dark.background), '#161616')
    assert.ok(contrast(themes.dark.primary, themes.dark.background) >= 4.5)
    assert.ok(contrast(themes.light.primary, themes.light.background) >= 4.5)

    const css = postcss.parse(readFileSync(join(theme, 'compat.generated.css'), 'utf8'))
    for (const mode of ['light', 'dark'] as const) {
      const scope = css.nodes.find((node) => node.type === 'rule' && node.selectors.includes(`.${mode}`))
      assert.ok(scope && scope.type === 'rule')
      const ink = scope.nodes.find((node) => node.type === 'decl' && node.prop === '--agent-app-accent-hsl')
      assert.ok(ink && ink.type === 'decl')
      assert.equal(ink.value, themes[mode].primary)
    }
    // Current Brand bytes must remain byte-for-byte compatible with the checked projections.
    for (const name of outputs) {
      assert.equal(readFileSync(join(theme, name), 'utf8'), readFileSync(join(root, 'src/theme', name), 'utf8'))
    }
  })

  for (const mode of ['--write', '--check', '--dist', '--stdout']) {
    it(`rejects the reported dark fill indigo before emitting output (${mode})`, () => {
      const { directory, theme } = fixture(recolor('dark', 'hsl(246 54% 51%)'))
      const before = outputs.map((name) => readFileSync(join(theme, name), 'utf8'))
      const result = build(directory, mode)
      assert.notEqual(result.status, 0, 'Low-contrast primary ink must fail the build')
      assert.match(result.stderr, /Brand dark primary text must reach 4\.5:1 against --background/)
      assert.equal(result.stdout, '')
      assert.deepEqual(outputs.map((name) => readFileSync(join(theme, name), 'utf8')), before)
    })
  }

  it('also rejects low-contrast light primary ink', () => {
    const { directory } = fixture(recolor('light', '#a5b4fc'))
    const result = build(directory, '--write')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Brand light primary text must reach 4\.5:1 against --background/)
  })
})
