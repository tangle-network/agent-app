import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsup'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'agent-app-theme-check-'))
const cli = join(root, 'bin/cli.mjs')
const extraCss = 'apps/web/src/globals.css'
let cwd: string

// Build the actual CLI, not a mock of argument parsing or CSS traversal. Each
// invocation runs in a consumer workspace outside the agent-app checkout.
beforeAll(async () => {
  await build({
    entry: { cli: fileURLToPath(new URL('./cli.ts', import.meta.url)) },
    outDir: join(root, 'bin'),
    outExtension: () => ({ js: '.mjs' }),
    format: ['esm'],
    platform: 'node',
    splitting: false,
    dts: false,
    config: false,
    silent: true,
  })
}, 20_000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

function write(path: string, contents: string): void {
  const file = join(cwd, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

beforeEach(() => {
  cwd = mkdtempSync(join(root, 'consumer-'))
  write('tokens.css', ':root {\n  --base-token: black;\n}\n')
  write('apps/web/src/App.tsx', "export const color = 'var(--app-accent) var(--local-accent)'\n")
  write(extraCss, "@import 'tailwindcss';\n@import './nested/tokens.css';\n:root {\n  --app-accent: purple;\n}\n")
  write('apps/web/src/nested/tokens.css', "@import '../globals.css';\n:root {\n  --local-accent: blue;\n}\n")
})

function run(css = extraCss) {
  return spawnSync(process.execPath, [
    cli, '--src', 'apps/web/src', '--tokens', 'tokens.css', '--extra-css', css,
  ], { cwd, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, timeout: 10_000 })
}

function assertCompleted(result: ReturnType<typeof run>, status = 0): void {
  const output = result.stdout + result.stderr
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(output).not.toMatch(/ERR_INVALID_ARG_VALUE|MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/)
  expect(result.status, output).toBe(status)
  if (status === 0) expect(result.stdout).toContain('theme contract OK')
}

describe('agent-app-theme-check CSS imports', () => {
  it('resolves relative --extra-css against cwd and skips an unavailable tailwindcss import', () => {
    // The local import also cycles back to globals.css; definitions from both
    // sheets must survive, and traversal must terminate.
    assertCompleted(run())
  })

  it('does not crash on an unavailable bare import with an absolute --extra-css path', () => {
    assertCompleted(run(join(cwd, extraCss)))
  })

  it('resolves installed package CSS from the importing file, not cwd or the checker', () => {
    write(extraCss, "@import '@fixture/theme';\n")
    write('apps/web/node_modules/@fixture/theme/package.json', JSON.stringify({
      name: '@fixture/theme', exports: { '.': './tokens.css' },
    }))
    write('apps/web/node_modules/@fixture/theme/tokens.css', "@import './nested.css';\n:root {\n  --app-accent: purple;\n}\n")
    write('apps/web/node_modules/@fixture/theme/nested.css', ':root {\n  --local-accent: blue;\n}\n')
    assertCompleted(run())
  })

  it('skips CSS-only package exports that Node cannot resolve', () => {
    write('apps/web/node_modules/tailwindcss/package.json', JSON.stringify({
      name: 'tailwindcss', exports: { '.': { style: './index.css' } },
    }))
    write('apps/web/node_modules/tailwindcss/index.css', ':root {\n  --external-token: red;\n}\n')
    assertCompleted(run(join(cwd, extraCss)))
  })

  it('still fails for undefined tokens after skipping an unavailable package import', () => {
    write('apps/web/src/App.tsx', "export const color = 'var(--missing-token)'\n")
    const result = run()
    assertCompleted(result, 1)
    expect(result.stderr).toContain('theme contract FAILED')
    expect(result.stderr).toContain('--missing-token')
  })

  it('does not hide unrelated package configuration errors', () => {
    write('apps/web/node_modules/tailwindcss/package.json', '{ invalid json')
    const result = run(join(cwd, extraCss))
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ERR_INVALID_PACKAGE_CONFIG')
    expect(result.stdout).not.toContain('theme contract OK')
  })
})
