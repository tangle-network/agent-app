/**
 * `agent-app-signoff defaults` — report which agent-app defaults each app in a checkout has.
 *
 *   agent-app-signoff defaults [repoDir]               # the matrix for the apps in repoDir
 *   agent-app-signoff defaults --probe                 # also ask Intelligence for each app's last exported turn
 *   agent-app-signoff defaults --json matrix.json      # the same rows, machine-readable
 *
 * Exit 0 unless an app turns a default off without a reason (1), or the usage is wrong (2). `--probe` reads the
 * Sandbox product key from `SANDBOX_API_KEY`, the key the turn trace sink exports with.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { checkAppDefaults, collectLastExports, formatAppDefaults } from './app-defaults'
import { loadSignoffConfig } from './config'

export function defaultsUsage(): string {
  return [
    'Usage: agent-app-signoff defaults [repoDir] [options]',
    '',
    '  --probe        ask Intelligence for each app\'s last exported turn (needs SANDBOX_API_KEY)',
    '  --no-bundle    skip the Worker upload measure (it runs the app\'s own wrangler, so build first)',
    '  --json <path>  write the rows',
  ].join('\n')
}

export async function runDefaultsCli(argv: readonly string[]): Promise<number> {
  let repoDir = process.cwd()
  let probe = false
  let measureBundle = true
  let jsonPath: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string
    if (flag === '--probe') probe = true
    else if (flag === '--no-bundle') measureBundle = false
    else if (flag === '--json') {
      jsonPath = argv[index + 1]
      index += 1
      if (jsonPath === undefined) return usageError('--json needs a path')
    } else if (flag === '-h' || flag === '--help') {
      process.stdout.write(`${defaultsUsage()}\n`)
      return 0
    } else if (flag.startsWith('-')) return usageError(`unknown option: ${flag}`)
    else repoDir = resolve(flag)
  }
  let exemptions
  try {
    exemptions = (await loadSignoffConfig({ repoRoot: repoDir })).config.agentApp?.exemptions
  } catch {
    // A checkout with no signoff config, or one that does not load here, declares no exemptions.
  }
  const apiKey = process.env.SANDBOX_API_KEY?.trim()
  if (probe && !apiKey) return usageError('--probe needs SANDBOX_API_KEY')
  const exports = probe && apiKey ? await collectLastExports(repoDir, apiKey) : undefined
  const result = checkAppDefaults(repoDir, { exemptions, measureBundle, exports })
  if (jsonPath !== undefined) {
    const abs = resolve(jsonPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `${JSON.stringify(result, null, 2)}\n`)
  }
  process.stdout.write(formatAppDefaults(result))
  return result.findings.length === 0 ? 0 : 1
}

function usageError(message: string): number {
  process.stderr.write(`agent-app-signoff defaults: ${message}\n\n${defaultsUsage()}\n`)
  return 2
}
