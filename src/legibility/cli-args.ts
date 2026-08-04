/**
 * The bin's argument and config layer, split from `cli.ts` so it can be tested
 * without executing a `main()` that calls `process.exit`.
 *
 * Errors are thrown as {@link LegibilityUsageError} rather than exiting here:
 * exiting is the bin's job, and a parser that exits cannot be exercised.
 */

import { LEGIBILITY_CHECKS, type LegibilityCheckId, type LegibilityConfig } from './types'

export const DEFAULT_CONFIG_FILE = 'legibility.config.mjs'

/** A usage or config problem — exit code 2, never a finding. */
export class LegibilityUsageError extends Error {}

export interface ParsedArgs {
  srcDirs: string[]
  navFiles: string[]
  ignorePaths: string[]
  skip: LegibilityCheckId[]
  routes?: string
  config?: string
  json: boolean
  listSuppressions: boolean
  help: boolean
}

export const USAGE = [
  'Usage: agent-app-legibility-check --src <dir> [--src <dir>…] [--routes <file>] [--nav <file>…]',
  '                                 [--ignore <substr>…] [--skip <check>…] [--config <file>]',
  '                                 [--json] [--list-suppressions]',
  `Checks: ${LEGIBILITY_CHECKS.join(', ')}`,
].join('\n')

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    srcDirs: [],
    navFiles: [],
    ignorePaths: [],
    skip: [],
    json: false,
    listSuppressions: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const take = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new LegibilityUsageError(`${flag} needs a value`)
      return value
    }
    switch (flag) {
      case '--src':
        out.srcDirs.push(take())
        break
      case '--routes':
        out.routes = take()
        break
      case '--nav':
        out.navFiles.push(take())
        break
      case '--ignore':
        out.ignorePaths.push(take())
        break
      case '--skip': {
        const check = take()
        if (!LEGIBILITY_CHECKS.includes(check as LegibilityCheckId)) {
          throw new LegibilityUsageError(`--skip ${check} is not a check. Known: ${LEGIBILITY_CHECKS.join(', ')}`)
        }
        out.skip.push(check as LegibilityCheckId)
        break
      }
      case '--config':
        out.config = take()
        break
      case '--json':
        out.json = true
        break
      case '--list-suppressions':
        out.listSuppressions = true
        break
      case '-h':
      case '--help':
        out.help = true
        break
      default:
        throw new LegibilityUsageError(`unknown argument: ${flag}`)
    }
  }
  return out
}

/**
 * Merge a config file with the flags. Flags WIN, so a one-off CI invocation can
 * narrow a run without editing the committed config.
 */
export function mergeConfig(fromFile: Partial<LegibilityConfig>, args: ParsedArgs): LegibilityConfig {
  const checks: Partial<Record<LegibilityCheckId, boolean>> = { ...fromFile.checks }
  for (const check of args.skip) checks[check] = false

  const reachability = {
    ...fromFile.reachability,
    ...(args.routes ? { routeConfigFile: args.routes } : {}),
    ...(args.navFiles.length > 0 ? { navFiles: args.navFiles } : {}),
  }

  return {
    ...fromFile,
    srcDirs: args.srcDirs.length > 0 ? args.srcDirs : (fromFile.srcDirs ?? []),
    ignorePaths: [...(fromFile.ignorePaths ?? []), ...args.ignorePaths],
    ...(Object.keys(checks).length > 0 ? { checks } : {}),
    ...(reachability.routeConfigFile || reachability.routePaths ? { reachability } : {}),
  }
}
