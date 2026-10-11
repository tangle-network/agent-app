/**
 * `agent-app-signoff workspace-surface` — every route renders one shared
 * floating panel whose first row is an inset ShellHeader.
 *
 *   agent-app-signoff workspace-surface --base-url http://127.0.0.1:8787 \
 *     --route /app/w1/assets --route /app/w1/tasks --storage-state auth.json
 *
 * Same options as `shell-alignment` (it ignores --tolerance). Exit 0 when every
 * page is on the panel, 1 on any page that is not, 2 on a usage error.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseShellAlignmentArgs, ShellAlignmentUsageError } from './shell-alignment-cli'
import { checkWorkspaceSurface, formatWorkspaceSurfaceReport } from './workspace-surface'

const USAGE = [
  'Usage: agent-app-signoff workspace-surface --base-url <url> --route <path> [--route <path> ...] [options]',
  '',
  '  --widths <w,w>           viewport widths (default 1440,390)',
  '  --themes <t,t>           light,dark (default both)',
  '  --storage-state <file>   Playwright storage state for an authenticated app',
  '  --theme-script <file>    JS run before each page loads with `theme` in scope',
  '  --ready <selector>       wait for this after navigation (default [data-shell-header])',
  '  --screenshots <dir>      screenshot each failing page here',
  '  --json <path>            write every sample and finding',
].join('\n')

export async function runWorkspaceSurfaceCli(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  let options: ReturnType<typeof parseShellAlignmentArgs>
  try {
    options = parseShellAlignmentArgs(argv)
  } catch (error) {
    if (!(error instanceof ShellAlignmentUsageError)) throw error
    process.stderr.write(`agent-app-signoff workspace-surface: ${error.message}\n\n${USAGE}\n`)
    return 2
  }
  if (options.screenshotDir) mkdirSync(options.screenshotDir, { recursive: true })
  const report = await checkWorkspaceSurface(options)
  if (options.jsonPath) {
    const abs = resolve(options.jsonPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`)
  }
  process.stdout.write(`${formatWorkspaceSurfaceReport(report)}\n`)
  return report.findings.length ? 1 : 0
}
