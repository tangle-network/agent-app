from pathlib import Path
p=Path('create-agent-app/index.mjs');s=p.read_text()
s=s.replace("// tree verbatim (`template/` by default, `template-chat/` with `--chat`),", "// tree verbatim (`template-chat/` by default, `template/` with `--headless`),")
s=s.replace("// Template variants: the default tool-loop skeleton, and `--chat` — the", "// Template variants: the explicit headless tool-loop skeleton, and the default")
s=s.replace("  default: join(HERE, 'template'),", "  headless: join(HERE, 'template'),")
s=s.replace("import { existsSync } from 'node:fs'", "import { existsSync } from 'node:fs'\nimport { randomBytes } from 'node:crypto'")
s=s.replace("    else if (a === '--chat') args.template = 'chat'", """    else if (a === '--chat' || a === '--headless') {
      const template = a === '--headless' ? 'headless' : 'chat'
      if (args.template && args.template !== template) throw new Error('--chat and --headless cannot be combined')
      args.template = template
    }""")
old="""    '  --chat                       Scaffold the multimodal chat variant instead: the',
    '                               assembled chat vertical (auth, thread/message store,',
    '                               streaming turns + replay, uploads, agent asks) with',
    '                               its own end-to-end test. Default: the tool-loop skeleton.',""";assert old in s
s=s.replace(old,"""    '  --chat                       Full shared chat workspace (the default).',
    '  --headless                   Tool-loop skeleton without the browser workspace.',""")
s=s.replace("  const templateDir = TEMPLATES[args.template ?? 'default']", "  const variant = args.template ?? 'chat'\n  const templateDir = TEMPLATES[variant]")
needle='async function main() {';assert s.count(needle)==1
s=s.replace(needle,"""// Initialize only this new app's local session secret. Never copy account
// credentials, print the value, or rotate an existing development session.
async function initializeLocalAuth(targetDir) {
  const example = await readFile(join(targetDir, '.dev.vars.example'), 'utf8')
  const placeholder = 'BETTER_AUTH_SECRET=REPLACE_WITH_RANDOM_SECRET'
  if (!example.includes(placeholder)) throw new Error('Chat template is missing its local auth-secret placeholder')
  const local = example.replace(placeholder, `BETTER_AUTH_SECRET=${randomBytes(32).toString('base64url')}`)
  try {
    await writeFile(join(targetDir, '.dev.vars'), local, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}

"""+needle)
s=s.replace("  await materializeTemplate(templateDir, targetDir, tokens)\n", "  await materializeTemplate(templateDir, targetDir, tokens)\n  if (variant === 'chat') await initializeLocalAuth(targetDir)\n")
s=s.replace("      '  pnpm typecheck && pnpm test',", """      ...(variant === 'chat' ? [
        '  # Fill scoped Router/Sandbox access in .dev.vars and choose a model in agent.config.ts.',
        '  pnpm db:migrate:local',
        '  pnpm dev',
      ] : ['  pnpm typecheck && pnpm test']),""")
p.write_text(s)
p=Path('.github/scripts/test-generated-projects.mjs');s=p.read_text().replace("  if (variant === 'chat') cliArgs.push('--chat')", "  // Exercise the public no-flag workspace default; headless is explicit.\n  if (variant === 'headless') cliArgs.push('--headless')")
s=s.replace("for (const variant of ['default', 'chat'])", "for (const variant of ['headless', 'chat'])")
p.write_text(s)
p=Path('tests/scaffold-cohort.test.ts');s=p.read_text().replace("describe.each([{ flags: [] }, { flags: ['--chat'] }])", "describe.each([{ flags: [] }, { flags: ['--chat'] }, { flags: ['--headless'] }])");p.write_text(s)
Path('tests/scaffold-defaults.test.ts').write_text('''import { describe, expect, it } from 'vitest'
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
  const line = readFileSync(join(target, '.dev.vars'), 'utf8').split('\\n')
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
    expect(readFileSync(join(first, '.gitignore'), 'utf8').split('\\n')).toContain('.dev.vars')
    const existing = '# Existing local configuration\\nBETTER_AUTH_SECRET=preserved-test-value\\n'
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
''')
p=Path('create-agent-app/template-chat/.dev.vars.example');s=p.read_text().replace('# Copy to .dev.vars for local development (never commit .dev.vars).', '# The scaffolder creates private .dev.vars with a fresh local session secret.\n# This example remains a recovery template; never commit .dev.vars.').replace('# better-auth HMAC secret — generate one: openssl rand -base64 32', '# The scaffolder replaces this placeholder only in the new local .dev.vars.');p.write_text(s)
p=Path('create-agent-app/template-chat/README.md');s=p.read_text().replace('scaffolded with `create-agent-app --chat`', 'scaffolded with `create-agent-app`')
s=s.replace('Read `AGENTS.md` and follow `CUSTOMIZE.md`. Set up the development D1 binding\nand `.dev.vars`, then:', 'The scaffolder creates ignored `.dev.vars` with a fresh local session secret;\nit never prints the value or overwrites an existing file. Fill the scoped\nRouter/Sandbox credentials, choose an authorized model in `agent.config.ts`,\nand configure the development D1 binding described in `CUSTOMIZE.md`. Then:')
p.write_text(s)
p=Path('create-agent-app/README.md');s=p.read_text().replace('Use **`--chat` for the browser sign-in and chat walkthrough below**. Without it,\nthe CLI generates the unchanged tool-loop skeleton, not the assembled chat variant.', 'The default is the full shared browser workspace: sign-in, chat, History, uploads\nand replay. Use `--headless` for the unchanged tool-loop skeleton; `--chat` remains\nan explicit alias for the default.')
s=s.replace('my-agent -- --chat','my-agent').replace('cp .dev.vars.example .dev.vars\n','')
s=s.replace('Keep `.dev.vars` out of version control. Replace its auth-secret placeholder with\na fresh secret (for example, `openssl rand -base64 32`) and fill the development\n`TANGLE_API_KEY`, `SANDBOX_API_KEY`, and `SANDBOX_GATEWAY_URL` credentials.', 'The scaffolder creates ignored `.dev.vars` with a fresh random local auth secret\n(mode 0600 on POSIX). It does not print the secret or rotate an existing file,\neven with `--force`. Fill the development `TANGLE_API_KEY`, `SANDBOX_API_KEY`,\nand `SANDBOX_GATEWAY_URL` credentials.')
p.write_text(s)
