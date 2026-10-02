import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cli = resolve(__dirname, '../create-agent-app/index.mjs')
const run = (target: string, ...args: string[]) => execFileSync(process.execPath,
  [cli, target, '--name', 'starter-proof', ...args], { encoding: 'utf8' })
function files(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = join(prefix, entry.name)
    return entry.isDirectory() ? files(root, path) : [path]
  }).sort()
}
function scratch(check: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'app-starter-'))
  try { check(root) } finally { rmSync(root, { recursive: true, force: true }) }
}
function secret(target: string) {
  const line = readFileSync(join(target, '.dev.vars'), 'utf8').split('\n')
    .find(value => value.startsWith('BETTER_AUTH_SECRET='))
  return line?.slice('BETTER_AUTH_SECRET='.length) ?? ''
}

describe('default developer workspace', () => {
  it('defaults to the maintained workspace and preserves --chat as the same template', () => scratch(root => {
    const standard = join(root, 'standard')
    const explicit = join(root, 'explicit')
    run(standard)
    run(explicit, '--chat')
    expect(readFileSync(join(standard, 'web/App.tsx'), 'utf8')).toContain('AgentWorkspaceLayout')
    expect(readFileSync(join(standard, 'web/Conversation.tsx'), 'utf8')).toContain('ChatComposer')
    const paths = files(standard).filter(path => path !== '.dev.vars')
    expect(files(explicit).filter(path => path !== '.dev.vars')).toEqual(paths)
    for (const path of paths) expect(readFileSync(join(standard, path))).toEqual(readFileSync(join(explicit, path)))
  }))

  it('keeps the existing tool-loop skeleton available through --headless', () => scratch(root => {
    const target = join(root, 'headless')
    run(target, '--headless')
    expect(existsSync(join(target, 'web'))).toBe(false)
    expect(existsSync(join(target, '.dev.vars'))).toBe(false)
    expect(existsSync(join(target, 'src/worker.ts'))).toBe(true)
    expect(existsSync(join(target, 'tests/agent-app.test.ts'))).toBe(true)
  }))

  it('creates private unique local session secrets without printing or rotating them', () => scratch(root => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    const output = run(first)
    run(second)
    const value = secret(first)
    expect(/^[A-Za-z0-9_-]{43}$/.test(value)).toBe(true)
    expect(value === secret(second)).toBe(false)
    expect(output.includes(value)).toBe(false)
    if (process.platform !== 'win32') expect(statSync(join(first, '.dev.vars')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(first, '.gitignore'), 'utf8').split('\n')).toContain('.dev.vars')
    const existing = '# Existing local configuration\nBETTER_AUTH_SECRET=preserved-test-value\n'
    writeFileSync(join(first, '.dev.vars'), existing)
    run(first, '--force')
    expect(readFileSync(join(first, '.dev.vars'), 'utf8') === existing).toBe(true)
  }))

  it('rejects conflicting template choices before creating a target', () => scratch(root => {
    for (const args of [['--chat', '--headless'], ['--headless', '--chat']]) {
      const target = join(root, args[0]!.slice(2))
      const result = spawnSync(process.execPath, [cli, target, ...args], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('cannot be combined')
      expect(existsSync(target)).toBe(false)
    }
  }))

  it('describes the full workspace default and explicit headless option', () => {
    const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
    expect(help).toContain('Full shared chat workspace (the default)')
    expect(help).toContain('--headless')
  })
})
