/** Build-only projection of the published Brand contract. No runtime imports. */
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const sourcePath = require.resolve('@tangle-network/brand/styles/legacy-light.css')
const source = readFileSync(sourcePath, 'utf8')
const sourceHash = createHash('sha256').update(source).digest('hex')
const canonical = postcss.parse(source, { from: sourcePath })
const values = (rule) => Object.fromEntries((rule.nodes ?? [])
  .filter((n) => n.type === 'decl' && n.prop.startsWith('--')).map((n) => [n.prop, n.value]))
const rules = canonical.nodes.filter((n) => n.type === 'rule')
const baseline = rules.find((r) => r.selectors.includes('.dark') && values(r)['--hsl-background'])
const light = rules.find((r) => r.selectors.includes('.light') && !r.selectors.includes('.dark') && values(r)['--hsl-background'])
if (!baseline || !light) throw new Error('Brand base mode contract changed; reconcile the projection explicitly')
const darkValues = values(baseline)
const lightValues = { ...darkValues, ...values(light) }

function resolve(value, defs, seen = new Set()) {
  if (typeof value !== 'string') throw new Error('Missing canonical Brand role')
  return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name) => {
    if (seen.has(name)) throw new Error(`Cyclic Brand role ${name}`)
    return resolve(defs[name], defs, new Set([...seen, name]))
  })
}
function rgb(value) {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim())
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  }
  const hsl = /^(?:hsl\()?\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)?$/.exec(value.trim())
  if (hsl) {
    const h = Number(hsl[1]) / 360, s = Number(hsl[2]) / 100, l = Number(hsl[3]) / 100
    const a = s * Math.min(l, 1 - l)
    return [0, 8, 4].map((n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) })
  }
  throw new Error(`Brand color needs a lossless compatibility conversion: ${value}`)
}
const round = (n) => String(Number(n.toFixed(4)))
function channels(value) {
  if (/^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(value.trim())) return value.trim()
  const [r, g, b] = rgb(value), max = Math.max(r, g, b), min = Math.min(r, g, b)
  const d = max - min, l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h = (h * 60 + 360) % 360
  return `${round(h)} ${round(s * 100)}% ${round(l * 100)}%`
}
const luminance = (color) => rgb(color).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
// Both endpoints are canonical Brand values, not another authored ink palette.
const labelCandidates = ['--md3-on-primary', '--md3-inverse-on-surface'].map((key) => resolve(darkValues[key], darkValues))
function foreground(fill) {
  const best = [...labelCandidates].sort((a, b) => contrast(fill, b) - contrast(fill, a))[0]
  if (contrast(fill, best) < 4.5) throw new Error(`No canonical solid label clears AA for ${fill}`)
  return channels(best)
}
const COLOR_ROLES = {
  '--accent-text': 'accent',
  '--surface-success-text': 'success',
  '--surface-danger-text': 'danger',
  '--surface-warning-text': 'warning-text',
}
function adapters(own, inherited = darkValues) {
  const defs = { ...inherited, ...own }, result = {}
  for (const [key, name] of Object.entries(COLOR_ROLES)) {
    if (!(key in own)) continue
    const value = resolve(own[key], defs)
    result[`--agent-app-${name}-hsl`] = channels(value)
    if (name !== 'warning-text') result[`--agent-app-${name}-foreground-hsl`] = foreground(value)
  }
  if ('--hsl-warning' in own) result['--agent-app-warning-foreground-hsl'] = foreground(resolve(own['--hsl-warning'], defs))
  if (['sm', 'md', 'lg', 'xl'].some((size) => `--radius-${size}` in own)) {
    const sizes = Object.fromEntries(['sm', 'md', 'lg', 'xl'].map((size) => {
      const value = resolve(defs[`--radius-${size}`], defs)
      if (!/^\d+(?:\.\d+)?px$/.test(value)) throw new Error(`Unsupported canonical radius unit: ${value}`)
      return [size, Number.parseFloat(value)]
    }))
    if (!(sizes.lg > 0)) throw new Error('Canonical radius-lg must be positive')
    result['--agent-app-radius-lg'] = defs['--radius-lg']
    for (const size of ['sm', 'md', 'xl']) result[`--agent-app-radius-${size}-factor`] = round(sizes[size] / sizes.lg)
  }
  return result
}
function project(node) {
  if (node.type === 'rule') {
    const defs = adapters(values(node))
    if (!Object.keys(defs).length) return null
    return postcss.rule({ selector: node.selector, nodes: Object.entries(defs).map(([prop, value]) => postcss.decl({ prop, value })) })
  }
  if (node.type === 'atrule' && node.nodes) {
    const nodes = node.nodes.map(project).filter(Boolean)
    return nodes.length ? postcss.atRule({ name: node.name, params: node.params, nodes }) : null
  }
  return null
}
const provenance = `GENERATED from @tangle-network/brand/styles/legacy-light.css\n * SHA-256: ${sourceHash}\n * Run node src/theme/build.mjs --write; do not edit colors or ratios here.`
const compat = `/* ${provenance} */\n${postcss.root({ nodes: canonical.nodes.map(project).filter(Boolean) }).toString()}\n`
const toHex = (color) => '#' + rgb(color).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')
function snapshot(defs, mode) {
  const projected = adapters(defs), result = {}
  const names = ['background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground',
    'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground',
    'accent', 'accent-foreground', 'destructive', 'destructive-foreground', 'border', 'input', 'ring', 'success', 'warning']
  const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  for (const name of names) result[camel(name)] = resolve(defs[`--${name}`], defs)
  for (const [target, role] of [['primary', 'accent'], ['success', 'success'], ['destructive', 'danger']]) {
    result[target] = projected[`--agent-app-${role}-hsl`]
    result[`${target}Foreground`] = projected[`--agent-app-${role}-foreground-hsl`]
  }
  // Primary paints link text as well as controls. A readable solid label does
  // not prove that the primary ink itself is readable on the canvas.
  const primaryContrast = contrast(result.primary, result.background)
  if (!(primaryContrast >= 4.5)) {
    throw new Error(`Brand ${mode} primary text must reach 4.5:1 against --background (got ${primaryContrast.toFixed(2)}:1)`)
  }
  result.warningForeground = projected['--agent-app-warning-foreground-hsl']
  result.warningStrong = projected['--agent-app-warning-text-hsl']
  result.inputFill = resolve(defs['--bg-input'], defs)
  result.canvasBackdrop = resolve(defs['--md3-surface-dim'], defs)
  result.borderSoft = resolve(defs['--border-subtle'], defs)
  result.cardEdge = resolve(defs['--border-default'], defs)
  const canvas = {
    grid: '--md3-outline-variant', snapGrid: '--md3-outline', snapGuide: '--surface-info-text',
    snapPage: '--surface-warning-text', snapElement: '--surface-danger-text', selectionStroke: '--accent-text',
    selectionAnchorFill: '--md3-surface-bright', placeholderFill: '--md3-surface-container-low',
    placeholderStroke: '--md3-outline-variant', brokenFill: '--md3-surface-variant', brokenStroke: '--md3-outline',
  }
  result.canvasRender = Object.fromEntries(Object.entries(canvas).map(([key, role]) => [key, toHex(resolve(defs[role], defs))]))
  return result
}
const themes = `/** ${provenance} */\nexport const brandThemes = ${JSON.stringify({ light: snapshot(lightValues, 'light'), dark: snapshot(darkValues, 'dark') }, null, 2)} as const\n`
const outputs = [['compat.generated.css', compat], ['brand.generated.ts', themes]]
function check() {
  for (const [file, text] of outputs) {
    if (readFileSync(join(here, file), 'utf8') !== text) throw new Error(`Stale ${file}; run node src/theme/build.mjs --write and review the Brand changes`)
  }
}
function stylesheet() {
  const css = postcss.parse(readFileSync(join(here, 'tokens.css'), 'utf8'))
  const imports = new Map([
    ['@tangle-network/brand/styles/legacy-light.css', source], ['./compat.generated.css', compat],
  ])
  css.walkAtRules('import', (rule) => {
    const match = /^['"]([^'"]+)['"]\s+layer\(theme\)$/.exec(rule.params)
    if (!match || !imports.has(match[1])) throw new Error(`Unreviewed theme import: ${rule.params}`)
    rule.replaceWith(postcss.atRule({ name: 'layer', params: 'theme', nodes: postcss.parse(imports.get(match[1])).nodes }))
  })
  return css.toString()
}
const mode = process.argv[2]
if (mode === '--write') {
  for (const [file, text] of outputs) writeFileSync(join(here, file), text)
} else if (mode === '--check') {
  check()
  console.log(`Brand projection current: ${sourceHash}`)
} else if (mode === '--dist' || mode === '--stdout') {
  check()
  const css = stylesheet()
  if (mode === '--stdout') process.stdout.write(css)
  else {
    const dir = join(here, '../../dist/theme')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tokens.css'), css)
    // The Tailwind source entry imports the sibling tokens.css written above.
    copyFileSync(join(here, 'tailwind.css'), join(dir, 'tailwind.css'))
  }
} else {
  throw new Error('Usage: node src/theme/build.mjs --write|--check|--dist|--stdout')
}
