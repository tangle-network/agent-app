#!/usr/bin/env node
/**
 * agent-app-theme-check — CI guard against the invisible-surface incident class.
 *
 * A consumer app runs this over its own source; it fails (exit 1) when a
 * component references a theme token — `var(--popover)` or a preset-mapped
 * utility like `bg-surface-container-high` — that the app's shipped CSS never
 * defines, which would paint that surface transparent with no error at runtime.
 *
 *   agent-app-theme-check --src src --src packages/ui/src \
 *     --extra-css src/app-tokens.css
 *
 * Flags (all repeatable except --tokens):
 *   --src <dir>         source dir to scan for token references (required, 1+)
 *   --extra-css <file>  extra CSS whose --name: definitions also count as defined
 *   --tokens <file>     override the base tokens.css (defaults to the one
 *                       agent-app ships as `@tangle-network/agent-app/styles`)
 *   --allow <--var>     suppress a token name from the missing report
 *
 * Wire it as a CI step: `"theme-check": "agent-app-theme-check --src src"`.
 */

import { checkThemeContract } from './index'

interface ParsedArgs {
  srcDirs: string[]
  extraCss: string[]
  allow: string[]
  tokens?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { srcDirs: [], extraCss: [], allow: [] }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const take = () => {
      const v = argv[++i]
      if (v === undefined) fail(`${flag} needs a value`)
      return v!
    }
    switch (flag) {
      case '--src':
        out.srcDirs.push(take())
        break
      case '--extra-css':
        out.extraCss.push(take())
        break
      case '--allow':
        out.allow.push(take())
        break
      case '--tokens':
        out.tokens = take()
        break
      case '-h':
      case '--help':
        printUsage()
        process.exit(0)
        break
      default:
        fail(`unknown argument: ${flag}`)
    }
  }
  return out
}

function printUsage(): void {
  process.stdout.write(
    'Usage: agent-app-theme-check --src <dir> [--src <dir>…] ' +
      '[--extra-css <file>…] [--tokens <file>] [--allow <--var>…]\n',
  )
}

function fail(msg: string): never {
  process.stderr.write(`agent-app-theme-check: ${msg}\n`)
  printUsage()
  process.exit(2)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.srcDirs.length === 0) fail('at least one --src <dir> is required')

  const { ok, missing } = checkThemeContract({
    srcDirs: args.srcDirs,
    tokensCss: args.tokens,
    extraTokensCss: args.extraCss,
    allowlist: args.allow,
  })

  if (ok) {
    process.stdout.write(`theme contract OK — every referenced token is defined (${args.srcDirs.join(', ')})\n`)
    process.exit(0)
  }

  process.stderr.write(
    `theme contract FAILED — ${missing.length} token reference(s) resolve to nothing (surface ships transparent):\n\n`,
  )
  for (const m of missing) process.stderr.write(`  ${m.varName}\n    referenced in ${m.referencedIn}\n`)
  process.stderr.write(
    '\nDefine these in your tokens.css (or `import \'@tangle-network/agent-app/styles\'`),\n' +
      'pass the defining CSS via --extra-css, or suppress a deliberately-external one with --allow.\n',
  )
  process.exit(1)
}

main()
