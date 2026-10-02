// Temporary branch bootstrap. Removed after committing generated files/lockfile.
// Never touches a release version, another dependency, or another branch.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
const edit = (path, fn) => { const old = readFileSync(path, 'utf8'); const next = fn(old); assert.notEqual(next, old, `No edit in ${path}`); writeFileSync(path, next) }
edit('package.json', (text) => {
  const pkg = JSON.parse(text)
  assert.equal(pkg.devDependencies['@tangle-network/brand'], '1.9.1')
  pkg.devDependencies['@tangle-network/brand'] = '1.10.0'
  assert.equal(pkg.scripts.build, 'tsup && tsc -p tsconfig.build.json')
  pkg.scripts.build = 'node src/theme/build.mjs --check && tsup && tsc -p tsconfig.build.json'
  assert.equal(pkg.sideEffects, false)
  pkg.sideEffects = ['./dist/**/*.css']
  return JSON.stringify(pkg, null, 2) + '\n'
})
edit('tsup.config.ts', (s) => s.replace('cp src/theme/tokens.css dist/theme/tokens.css', 'node src/theme/build.mjs --dist'))
edit('src/theme/theme.ts', (s) => {
  const light = s.indexOf('export const lightTheme: AgentAppTheme = {')
  const end = s.indexOf('/**\n * Wrap a channel triple', light)
  assert(light > 0 && end > light)
  s = s.slice(0, light) + 'export const lightTheme: AgentAppTheme = brandThemes.light\n\n/** Canonical Brand dark values projected for legacy JS and bitmap callers. */\nexport const darkTheme: AgentAppTheme = brandThemes.dark\n\n' + s.slice(end)
  s = s.replace(/^\/\*\*[\s\S]*?\*\/\n/, '/** Brand-derived HSL compatibility and bitmap snapshots. Regenerate with src/theme/build.mjs; never author a second palette here. */\nimport { brandThemes } from \'./brand.generated\'\n')
  s = s.replace('  input: string\n', '  input: string\n  /** Full field fill, distinct from the input border. Optional for existing custom themes. */\n  inputFill?: string\n')
  s = s.replace("'--bg-input': `hsl(${theme.card})`", "'--bg-input': theme.inputFill ?? `hsl(${theme.card})`")
  s = s.replace("'--editor-selection-foreground': `hsl(${theme.background})`", "'--editor-selection-foreground': `hsl(${theme.primaryForeground})`")
  s = s.replace("'--text-danger': `hsl(${theme.destructive})`,", "'--text-danger': `hsl(${theme.destructive})`,\n    '--text-warning': `hsl(${theme.warningStrong ?? theme.warningForeground})`,")
  return s
})
edit('src/theme/index.ts', (s) => s.replace('The CSS file is the canonical source; this module is the typed JS mirror.', 'Brand is the canonical source; this module exposes the generated compatibility mirror.'))
edit('src/theme-contract/index.ts', (s) => s
  .replace("{ suffix: 'surface-container-highest', varName: '--secondary' }", "{ suffix: 'surface-container-highest', varName: '--md3-surface-container-highest' }")
  .replace("{ suffix: 'surface-container-high', varName: '--popover' }", "{ suffix: 'surface-container-high', varName: '--md3-surface-container-high' }")
  .replace("{ suffix: 'surface-container', varName: '--card' }", "{ suffix: 'surface-container', varName: '--md3-surface-container' }"))
edit('tests/theme/contract.test.ts', (s) => s.replaceAll("'--popover'", "'--md3-surface-container-high'"))
edit('tests/theme/fixtures/extra-tokens.css', (s) => s + '\n:root {\n  --md3-surface-container-high: hsl(var(--popover));\n}\n')
edit('tests/theme/focus-floor.test.ts', (s) => s
  .replace("import { describe, expect, it } from 'vitest'", "import { describe, expect, it } from 'vitest'\nimport postcss from 'postcss'")
  .replace("    const root = blockBody(tokensCss, /(^|\\n)\\s*:root\\s*\\{/)", "    const roots: string[] = []\n    postcss.parse(tokensCss).walkRules((rule) => {\n      if (rule.selectors.includes(':where(:root)')) roots.push(rule.toString())\n    })\n    const root = roots.join('\\n')"))
