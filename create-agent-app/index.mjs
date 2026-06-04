#!/usr/bin/env node
// create-agent-app — scaffold a new Tangle agent product on @tangle-network/agent-app.
//
// Dependency-light by design: Node built-ins only. The CLI copies the `template/`
// tree verbatim, substitutes a small set of `__TOKEN__` placeholders, and renames
// files whose template name would otherwise interfere with tooling (a template's
// own `package.json` must not be read by the scaffolder's package manager; a
// template `gitignore` must not be applied to the scaffolder repo). The generated
// project's DATA surface is `agent.config.ts` + `knowledge/`; its CODE surface is
// `src/` (the chat route + composer). The breadcrumb docs (AGENTS.md / CLAUDE.md /
// CUSTOMIZE.md / KNOWLEDGE.md) ship inside the project so a coding agent that opens
// it walks the trail with zero external context.

import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = join(HERE, 'template')

// The agent-app version range the generated project depends on. Kept as a single
// constant so a release bump touches one line.
const AGENT_APP_RANGE = '^0.1.3'

// Template files renamed on materialization. A template cannot itself be named
// `package.json` / `.gitignore` / `tsconfig.json` without confusing the
// scaffolder repo's own tooling, so we prefix with `_` and restore on copy.
const RENAME = new Map([
  ['_package.json', 'package.json'],
  ['_gitignore', '.gitignore'],
  ['_tsconfig.json', 'tsconfig.json'],
  ['_wrangler.toml', 'wrangler.toml'],
])

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--name') args.name = argv[++i]
    else if (a === '--agent-app-version') args.agentAppVersion = argv[++i]
    else if (a === '--force') args.force = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (!a.startsWith('-')) args._.push(a)
    else throw new Error(`Unknown flag: ${a}`)
  }
  return args
}

function usage() {
  return [
    'Usage: create-agent-app <target-dir> [options]',
    '',
    'Scaffolds a new Tangle agent product on @tangle-network/agent-app.',
    '',
    'Options:',
    '  --name <name>                Project name (default: the target dir basename).',
    '  --agent-app-version <range>  @tangle-network/agent-app version (default: ' + AGENT_APP_RANGE + ').',
    '  --force                      Write into a non-empty directory.',
    '  -h, --help                   Show this help.',
    '',
    'After scaffolding:',
    '  cd <target-dir> && pnpm install',
    '  pnpm typecheck && pnpm test',
    '  # then follow CUSTOMIZE.md: fill agent.config.ts, seed knowledge/, run pnpm knowledge:ingest',
  ].join('\n')
}

// Project name → a safe npm package name (lowercase, dashes, no scope chars).
function toPackageName(name) {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'agent-app-product'
}

function applyTokens(content, tokens) {
  let out = content
  for (const [key, value] of Object.entries(tokens)) {
    out = out.split(`__${key}__`).join(value)
  }
  return out
}

// Files we run token substitution on. Binary/asset files would be copied as-is;
// the template is text-only, but we gate on extension to stay safe.
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|toml|txt|html|css|sql)$/i
const TEXT_BASENAMES = new Set(['_gitignore', '.gitignore', '_package.json', 'package.json'])

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    const rel = abs.slice(base.length + 1)
    if (entry.isDirectory()) await walk(abs, base, out)
    else out.push(rel)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || (args._.length === 0 && !args.name)) {
    process.stdout.write(usage() + '\n')
    process.exit(args.help ? 0 : 1)
  }

  const targetDir = resolve(args._[0] ?? args.name)
  const projectName = args.name ?? targetDir.split(/[\\/]/).pop()
  const packageName = toPackageName(projectName)
  const agentAppVersion = args.agentAppVersion ?? AGENT_APP_RANGE

  if (existsSync(targetDir)) {
    const entries = await readdir(targetDir).catch(() => [])
    const meaningful = entries.filter((e) => e !== '.git' && e !== '.DS_Store')
    if (meaningful.length > 0 && !args.force) {
      throw new Error(
        `Target directory not empty: ${targetDir}\n` +
          `Pass --force to scaffold into it anyway (will not overwrite the .git dir).`,
      )
    }
  }
  await mkdir(targetDir, { recursive: true })

  const tokens = {
    PROJECT_NAME: projectName,
    PACKAGE_NAME: packageName,
    AGENT_APP_VERSION: agentAppVersion,
  }

  const files = await walk(TEMPLATE_DIR)
  for (const rel of files) {
    const src = join(TEMPLATE_DIR, rel)
    // Resolve any renamed path segments (only basenames are renamed).
    const parts = rel.split(/[\\/]/)
    const baseName = parts[parts.length - 1]
    const outName = RENAME.get(baseName) ?? baseName
    parts[parts.length - 1] = outName
    const dest = join(targetDir, parts.join('/'))

    await mkdir(dirname(dest), { recursive: true })

    const isText = TEXT_EXT.test(baseName) || TEXT_BASENAMES.has(baseName)
    if (isText) {
      const raw = await readFile(src, 'utf8')
      await writeFile(dest, applyTokens(raw, tokens))
    } else {
      await cp(src, dest)
    }
  }

  process.stdout.write(
    [
      `Scaffolded ${projectName} → ${targetDir}`,
      '',
      'Next:',
      `  cd ${targetDir}`,
      '  pnpm install',
      '  pnpm typecheck && pnpm test',
      '',
      'Then walk CUSTOMIZE.md (the fill-checklist) and AGENTS.md (the behavior contract).',
      '',
    ].join('\n'),
  )
}

main().catch((err) => {
  process.stderr.write(`create-agent-app: ${err.message}\n`)
  process.exit(1)
})
