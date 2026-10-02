/** Resolve public theme exports from a packed archive, then paint its CSS. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const proofDir = process.argv[2] ? resolve(process.argv[2]) : undefined
const scratch = mkdtempSync(join(tmpdir(), 'agent-app-theme-pack-'))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const channels = (color) => {
  const values = [...color.matchAll(/[\d.]+/g)].map((match) => Number(match[0]))
  assert.equal(values.length, 3, `Expected RGB or color(srgb): ${color}`)
  return color.startsWith('rgb(') ? values.map((value) => value / 255) : values
}
const luminance = (color) => channels(color)
  .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
const contrast = (a, b) => {
  const first = luminance(a), second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}
let browser
try {
  const packOutput = execFileSync('npm', ['pack', '--ignore-scripts', '--json',
    '--pack-destination', scratch], { cwd: root, encoding: 'utf8' })
  const packResult = JSON.parse(packOutput)
  // pnpm's lifecycle environment asks npm for its keyed JSON shape; direct
  // npm returns an array. Both describe the same single archive.
  const packed = Array.isArray(packResult) ? packResult[0] : packResult['@tangle-network/agent-app']
  assert.ok(packed?.filename, `npm pack must produce one archive; got ${packOutput.slice(0, 200)}`)
  const archive = join(scratch, packed.filename)
  const consumer = join(scratch, 'consumer')
  const installation = join(consumer, 'node_modules/@tangle-network/agent-app')
  mkdirSync(installation, { recursive: true })
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', installation])
  writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n')
  mkdirSync(join(consumer, 'src'), { recursive: true })
  writeFileSync(join(consumer, 'src/Good.tsx'), "export const good = 'bg-surface-container-high var(--card)'\n")

  const probe = `
    import { readFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    const css = readFileSync(fileURLToPath(import.meta.resolve('@tangle-network/agent-app/styles')), 'utf8');
    const { lightTheme, darkTheme, themeToCssVars } = await import('@tangle-network/agent-app/theme');
    const { default: preset } = await import('@tangle-network/agent-app/tailwind-preset');
    const { checkThemeContract } = await import('@tangle-network/agent-app/theme-contract');
    const contract = checkThemeContract({ srcDirs: [process.cwd() + '/src'] });
    if (!contract.ok) throw Error('Packed default stylesheet failed its contract: ' + JSON.stringify(contract.missing));
    const old = themeToCssVars({ ...lightTheme, inputFill: undefined, warningStrong: undefined, borderSoft: undefined, cardEdge: undefined });
    if (old['--bg-input'] !== 'hsl(' + lightTheme.card + ')' || old['--warning-strong'] !== lightTheme.warningForeground) throw Error('Custom theme fallback changed');
    console.log(JSON.stringify({ css, lightTheme, darkTheme, preset, fallback: true, sourceContract: contract.ok }));
  `
  const exported = JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '-e', probe], { cwd: consumer, encoding: 'utf8' }))
  assert.equal(existsSync(join(consumer, 'node_modules/@tangle-network/brand')), false)
  assert.equal(exported.css, readFileSync(join(root, 'dist/theme/tokens.css'), 'utf8'))
  assert.equal(exported.preset.theme.extend.colors['surface-container-high'], 'var(--md3-surface-container-high)')
  assert.equal(exported.preset.theme.extend.backgroundColor.input.includes('--bg-input'), true)
  assert.doesNotMatch(exported.css, /@import\s|url\(\s*['"]?https?:/)

  browser = await chromium.launch()
  const results = []
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const page = await browser.newPage({ viewport, reducedMotion })
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      const html = `<style>${exported.css}</style>
        <main style="margin:0;font-family:var(--font-sans)">
          <section id="default" style="background:hsl(var(--background));color:hsl(var(--foreground));padding:1rem">
            <button id="action" style="background:hsl(var(--primary));color:hsl(var(--primary-foreground));padding:8px">Action</button>
            <input id="field" aria-label="Field" style="background:var(--bg-input);border:1px solid hsl(var(--input));padding:8px">
            <div id="warning" style="background:color-mix(in srgb,hsl(var(--warning)) 6%,hsl(var(--card)));color:hsl(var(--warning-strong));padding:8px">Waiting for approval</div>
            <div class="dark" id="dark" style="background:hsl(var(--background));color:hsl(var(--foreground));padding:1rem">
              Dark surface
              <div id="dark-warning" style="background:color-mix(in srgb,hsl(var(--warning)) 6%,hsl(var(--card)));color:hsl(var(--warning-strong));padding:8px">Dark approval</div>
              <div class="light" id="nested" style="background:hsl(var(--background));color:hsl(var(--foreground));padding:1rem">Nested light</div>
            </div>
            <div data-theme="aubergine" id="named" style="color:hsl(var(--primary))">Named accent</div>
            <span class="agent-shimmer">Working</span>
          </section>
        </main>`
      await page.setContent(html)
      const state = await page.evaluate(() => {
        const style = (id) => getComputedStyle(document.getElementById(id))
        const defaultStyle = style('default')
        return {
          defaultBackground: defaultStyle.backgroundColor,
          darkBackground: style('dark').backgroundColor,
          nestedBackground: style('nested').backgroundColor,
          fieldBackground: style('field').backgroundColor,
          fieldBorder: style('field').borderColor,
          namedPrimary: style('named').color,
          defaultPrimary: style('action').backgroundColor,
          primaryForeground: style('action').color,
          warningText: style('warning').color,
          warningBackground: style('warning').backgroundColor,
          darkWarningText: style('dark-warning').color,
          darkWarningBackground: style('dark-warning').backgroundColor,
          duration: defaultStyle.getPropertyValue('--duration-fast').trim(),
          shimmerAnimation: getComputedStyle(document.querySelector('.agent-shimmer')).animationName,
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: innerWidth,
        }
      })
      assert.notEqual(state.defaultBackground, state.darkBackground)
      assert.equal(state.defaultBackground, state.nestedBackground)
      assert.notEqual(state.fieldBackground, state.fieldBorder)
      assert.notEqual(state.namedPrimary, state.defaultPrimary)
      assert.ok(contrast(state.primaryForeground, state.defaultPrimary) >= 4.5)
      assert.ok(contrast(state.warningText, state.warningBackground) >= 4.5)
      assert.ok(contrast(state.darkWarningText, state.darkWarningBackground) >= 4.5)
      assert.equal(state.scrollWidth, state.viewportWidth)
      if (reducedMotion === 'reduce') {
        assert.equal(state.duration, '1ms')
        assert.equal(state.shimmerAnimation, 'none')
      }
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'action')
      assert.notEqual(await page.locator('#action').evaluate((element) => getComputedStyle(element).outlineStyle), 'none')
      assert.deepEqual(errors, [])
      if (proofDir && reducedMotion === 'no-preference') {
        mkdirSync(proofDir, { recursive: true })
        await page.screenshot({ path: join(proofDir, `packed-${viewport.width}.png`), fullPage: true })
      }
      results.push({ viewport: viewport.width, reducedMotion, ...state, errors })
      await page.close()
    }
  }
  const report = {
    packageVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    archiveSha256: sha256(readFileSync(archive)),
    cssSha256: sha256(exported.css),
    packedFiles: packed.files.length,
    installedWithoutBrand: true,
    sourceContract: exported.sourceContract,
    publicExportsResolved: ['styles', 'theme', 'tailwind-preset', 'theme-contract'],
    browser: results,
  }
  if (proofDir) writeFileSync(join(proofDir, 'packed-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close()
  rmSync(scratch, { recursive: true, force: true })
}
