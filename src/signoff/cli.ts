#!/usr/bin/env node
/**
 * `agent-app-signoff` — run the local sign-off gate and print the proof.
 *
 * Exits 0 only when every declared step passed in a pristine tree. Exit 1 is a
 * real failure; exit 2 is a usage or config error, so a script can tell "your
 * code is broken" from "your gate is misconfigured".
 *
 *   agent-app-signoff                     # this repo, working tree, default config
 *   agent-app-signoff --source head       # exactly the commit that would merge
 *   agent-app-signoff --seed 12345        # reproduce a previous run's orders
 *   agent-app-signoff --keep-going        # run every step, full picture
 *   agent-app-signoff --json proof.json   # machine-readable record
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { invokedAsScript } from './invoked-as-script'
import { formatSignoffLine, formatSignoffReport } from './report'
import { runSignoff, type RunSignoffOptions } from './run'
import type { SignoffEvent, SignoffSource } from './types'

interface ParsedArgs extends RunSignoffOptions {
  readonly jsonPath?: string
  readonly quiet?: boolean
}

function usage(): string {
  return [
    'Usage: agent-app-signoff [repoDir] [options]',
    '',
    '  --source head|working-tree  bytes to verify (default working-tree)',
    '  --config <path>             config module (default signoff.config.mjs)',
    '  --seed <n>                  base seed; reproduces a previous run',
    '  --shuffle-runs <n>          override every shuffled step\'s run count',
    '  --max-parallel <n>          cap concurrent steps',
    '  --cache-dir <path>          clean trees + pristine stores live here',
    '  --keep-going                run every step even after one fails',
    '  --keep-workspace            leave the clean tree on disk to inspect',
    '  --json <path>               write the machine-readable report',
    '  --quiet                     verdict only; no per-step progress',
  ].join('\n')
}

function fail(message: string): never {
  process.stderr.write(`agent-app-signoff: ${message}\n\n${usage()}\n`)
  process.exit(2)
}

function positiveInt(raw: string, flag: string): number {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 0) fail(`${flag} needs a non-negative integer, got "${raw}"`)
  return value
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: {
    repoDir?: string
    configPath?: string
    source?: SignoffSource
    seed?: number
    shuffleRuns?: number
    maxParallel?: number
    cacheDir?: string
    keepGoing?: boolean
    keepWorkspace?: boolean
    jsonPath?: string
    quiet?: boolean
  } = {}

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string
    const take = (): string => {
      const value = argv[index + 1]
      if (value === undefined) fail(`${flag} needs a value`)
      index += 1
      return value
    }
    switch (flag) {
      case '--source': {
        const value = take()
        if (value !== 'head' && value !== 'working-tree') fail(`--source must be head or working-tree, got "${value}"`)
        parsed.source = value
        break
      }
      case '--config': parsed.configPath = take(); break
      case '--seed': parsed.seed = positiveInt(take(), '--seed'); break
      case '--shuffle-runs': parsed.shuffleRuns = positiveInt(take(), '--shuffle-runs'); break
      case '--max-parallel': parsed.maxParallel = positiveInt(take(), '--max-parallel'); break
      case '--cache-dir': parsed.cacheDir = take(); break
      case '--keep-going': parsed.keepGoing = true; break
      case '--keep-workspace': parsed.keepWorkspace = true; break
      case '--json': parsed.jsonPath = take(); break
      case '--quiet': parsed.quiet = true; break
      case '-h':
      case '--help':
        process.stdout.write(`${usage()}\n`)
        process.exit(0)
        break
      default:
        if (flag.startsWith('-')) fail(`unknown option: ${flag}`)
        if (parsed.repoDir !== undefined) fail(`unexpected second directory: ${flag}`)
        parsed.repoDir = flag
    }
  }
  return parsed
}

function progressWriter(): (event: SignoffEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'tree':
        process.stderr.write(`· clean tree at ${event.path} (${event.head.slice(0, 12)}${event.dirty ? ' + working tree' : ''})\n`)
        break
      case 'store':
        process.stderr.write(`· store ${event.cacheHit ? 'warm' : 'COLD'} ${event.cacheKey.slice(0, 16)}\n`)
        break
      case 'install-start':
        process.stderr.write(`· ${event.command}\n`)
        break
      case 'install-end':
        process.stderr.write(`· install exit ${event.exitCode} in ${event.durationMs}ms\n`)
        break
      case 'step-start':
        process.stderr.write(`· start ${event.name}${event.seed === null ? '' : ` (seed ${event.seed})`}\n`)
        break
      case 'step-end':
        process.stderr.write(`· ${event.status === 'passed' ? 'ok' : event.status} ${event.name} ${event.durationMs}ms\n`)
        break
    }
  }
}

export async function runSignoffCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  const report = await runSignoff({ ...args, onEvent: args.quiet ? undefined : progressWriter() })

  if (args.jsonPath !== undefined) {
    const abs = resolve(args.jsonPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`)
  }

  // `--quiet` is documented as "verdict only", and CLAUDE.md names the one-line
  // `signoff PASS <sha> …` summary as an accepted PR proof. Printing the full
  // report here contradicted both, and left the only producer of that summary
  // with no caller.
  process.stdout.write(`${args.quiet ? formatSignoffLine(report) : formatSignoffReport(report)}\n`)
  return report.ok ? 0 : 1
}

/* c8 ignore start — process wiring, exercised by the bin itself */
if (invokedAsScript(import.meta.url, process.argv[1])) {
  runSignoffCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(2)
    })
}
/* c8 ignore stop */
