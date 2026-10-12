/**
 * `agent-app-signoff surface-ladder` — measure, in Chromium, that each route's
 * cards and fields step off the surface they sit on, field borders read, and
 * card body copy stays one short line.
 *
 *   agent-app-signoff surface-ladder --base-url http://127.0.0.1:8787 \
 *     --route /workspaces/w1/connections --route /workspaces/w1/overview --storage-state auth.json
 *
 * Exit 0 when every route, width and theme passes; 1 on any failure; 2 on a usage error.
 */
import { formatNetworkCount } from './browser-budget'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { checkSurfaceLadder, formatSurfaceLadderReport, type SurfaceLadderOptions } from './surface-ladder'

function surfaceLadderUsage(): string {
  return [
    'Usage: agent-app-signoff surface-ladder --base-url <url> --route <path> [--route <path> ...] [options]',
    '',
    '  --widths <w,w>           viewport widths (default 1440,390)',
    '  --themes <t,t>           light,dark (default both)',
    '  --storage-state <file>   Playwright storage state for an authenticated app',
    '  --theme-script <file>    JS run before each page loads with `theme` in scope',
    '  --ready <selector>       wait for this after navigation (default [data-shell-header])',
    '  --tolerance <L>          minimum |ΔL| (OKLCH L x100) for a card or field (default 3)',
    '  --min-border-contrast <r> minimum field border contrast against its parent (default 3)',
    '  --max-words <n>          maximum words in one card body-copy element (default 12)',
    '  --inject-css <file>      calibration only: add this stylesheet to each page before measuring',
    '  --screenshots <dir>      screenshot each failing page here',
    '  --json <path>            write every sample and finding',
  ].join('\n')
}

export class SurfaceLadderUsageError extends Error {}

export function parseSurfaceLadderArgs(argv: readonly string[]): SurfaceLadderOptions & { readonly jsonPath?: string } {
  const routes: string[] = []
  let baseUrl: string | undefined
  const out: { -readonly [K in keyof SurfaceLadderOptions]?: SurfaceLadderOptions[K] } & { jsonPath?: string } = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string
    const take = (): string => {
      const value = argv[index + 1]
      if (value === undefined) throw new SurfaceLadderUsageError(`${flag} needs a value`)
      index += 1
      return value
    }
    const nonNegative = (): number => {
      const n = Number(take())
      if (!(n >= 0)) throw new SurfaceLadderUsageError(`${flag} needs a non-negative number`)
      return n
    }
    switch (flag) {
      case '--base-url': baseUrl = take(); break
      case '--route': routes.push(take()); break
      case '--widths': out.widths = take().split(',').map((w) => {
        const n = Number(w)
        if (!Number.isInteger(n) || n < 200) throw new SurfaceLadderUsageError(`--widths needs integers of at least 200, got "${w}"`)
        return n
      }); break
      case '--themes': out.themes = take().split(',').map((t) => {
        if (t !== 'light' && t !== 'dark') throw new SurfaceLadderUsageError(`--themes takes light and dark, got "${t}"`)
        return t
      }); break
      case '--storage-state': out.storageState = resolve(take()); break
      case '--theme-script': out.themeScript = readFileSync(resolve(take()), 'utf8'); break
      case '--ready': out.readySelector = take(); break
      case '--tolerance': out.minDeltaL = nonNegative(); break
      case '--min-border-contrast': out.minBorderContrast = nonNegative(); break
      case '--max-words': {
        const n = Number(take())
        if (!Number.isInteger(n) || n < 1) throw new SurfaceLadderUsageError('--max-words needs a positive integer')
        out.maxWords = n
        break
      }
      case '--inject-css': out.injectCss = readFileSync(resolve(take()), 'utf8'); break
      case '--screenshots': out.screenshotDir = resolve(take()); break
      case '--json': out.jsonPath = take(); break
      default: throw new SurfaceLadderUsageError(`unknown option: ${flag}`)
    }
  }
  if (!baseUrl) throw new SurfaceLadderUsageError('--base-url is required')
  if (!routes.length) throw new SurfaceLadderUsageError('at least one --route is required')
  return { ...out, baseUrl, routes }
}

export async function runSurfaceLadderCli(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${surfaceLadderUsage()}\n`)
    return 0
  }
  let options: ReturnType<typeof parseSurfaceLadderArgs>
  try {
    options = parseSurfaceLadderArgs(argv)
  } catch (error) {
    if (!(error instanceof SurfaceLadderUsageError)) throw error
    process.stderr.write(`agent-app-signoff surface-ladder: ${error.message}\n\n${surfaceLadderUsage()}\n`)
    return 2
  }
  if (options.screenshotDir) mkdirSync(options.screenshotDir, { recursive: true })
  const report = await checkSurfaceLadder(options)
  if (options.jsonPath) {
    const abs = resolve(options.jsonPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`)
  }
  process.stdout.write(`${formatSurfaceLadderReport(report)}\n`)
  if (report.network) process.stdout.write(`${formatNetworkCount(report.network)}\n`)
  return report.findings.length ? 1 : 0
}
