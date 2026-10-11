/**
 * `agent-app-signoff shell-alignment` — measure, in Chromium, that each route's
 * main header divider continues the sidebar rail's first divider.
 *
 *   agent-app-signoff shell-alignment --base-url http://127.0.0.1:8787 \
 *     --route /app/w1/chat --route /app/w1/inbox --storage-state auth.json
 *
 * Exit 0 when every route, width and theme is within tolerance; 1 on any
 * misaligned divider; 2 on a usage error.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { checkShellAlignment, formatShellAlignmentReport, type ShellAlignmentOptions } from './shell-alignment'

export function shellAlignmentUsage(): string {
  return [
    'Usage: agent-app-signoff shell-alignment --base-url <url> --route <path> [--route <path> ...] [options]',
    '',
    '  --widths <w,w>           viewport widths (default 1440,390)',
    '  --themes <t,t>           light,dark (default both)',
    '  --storage-state <file>   Playwright storage state for an authenticated app',
    '  --theme-script <file>    JS run before each page loads with `theme` in scope',
    '  --ready <selector>       wait for this after navigation (default [data-shell-header])',
    '  --tolerance <px>         allowed divider offset (default 0.5)',
    '  --screenshots <dir>      screenshot each failing page here',
    '  --json <path>            write every sample and finding',
  ].join('\n')
}

export class ShellAlignmentUsageError extends Error {}

export function parseShellAlignmentArgs(argv: readonly string[]): ShellAlignmentOptions & { readonly jsonPath?: string } {
  const routes: string[] = []
  let baseUrl: string | undefined
  const out: { -readonly [K in keyof ShellAlignmentOptions]?: ShellAlignmentOptions[K] } & { jsonPath?: string } = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string
    const take = (): string => {
      const value = argv[index + 1]
      if (value === undefined) throw new ShellAlignmentUsageError(`${flag} needs a value`)
      index += 1
      return value
    }
    switch (flag) {
      case '--base-url': baseUrl = take(); break
      case '--route': routes.push(take()); break
      case '--widths': out.widths = take().split(',').map((w) => {
        const n = Number(w)
        if (!Number.isInteger(n) || n < 200) throw new ShellAlignmentUsageError(`--widths needs integers of at least 200, got "${w}"`)
        return n
      }); break
      case '--themes': out.themes = take().split(',').map((t) => {
        if (t !== 'light' && t !== 'dark') throw new ShellAlignmentUsageError(`--themes takes light and dark, got "${t}"`)
        return t
      }); break
      case '--storage-state': out.storageState = resolve(take()); break
      case '--theme-script': out.themeScript = readFileSync(resolve(take()), 'utf8'); break
      case '--ready': out.readySelector = take(); break
      case '--tolerance': {
        const n = Number(take())
        if (!(n >= 0)) throw new ShellAlignmentUsageError('--tolerance needs a non-negative number')
        out.tolerancePx = n
        break
      }
      case '--screenshots': out.screenshotDir = resolve(take()); break
      case '--json': out.jsonPath = take(); break
      default: throw new ShellAlignmentUsageError(`unknown option: ${flag}`)
    }
  }
  if (!baseUrl) throw new ShellAlignmentUsageError('--base-url is required')
  if (!routes.length) throw new ShellAlignmentUsageError('at least one --route is required')
  return { ...out, baseUrl, routes }
}

export async function runShellAlignmentCli(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${shellAlignmentUsage()}\n`)
    return 0
  }
  let options: ReturnType<typeof parseShellAlignmentArgs>
  try {
    options = parseShellAlignmentArgs(argv)
  } catch (error) {
    if (!(error instanceof ShellAlignmentUsageError)) throw error
    process.stderr.write(`agent-app-signoff shell-alignment: ${error.message}\n\n${shellAlignmentUsage()}\n`)
    return 2
  }
  if (options.screenshotDir) mkdirSync(options.screenshotDir, { recursive: true })
  const report = await checkShellAlignment(options)
  if (options.jsonPath) {
    const abs = resolve(options.jsonPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`)
  }
  process.stdout.write(`${formatShellAlignmentReport(report)}\n`)
  return report.findings.length ? 1 : 0
}
