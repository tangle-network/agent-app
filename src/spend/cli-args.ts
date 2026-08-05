import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import type { ReconcileSpendOptions } from './reconcile'

/** A usage or config problem — exit code 2, never a finding. */
export class SpendUsageError extends Error {}

const DEFAULT_CONFIG_FILE = 'spend.config.mjs'

export const USAGE = [
  'agent-app-spend-check — reconcile settled sandbox compute against what this product asked for.',
  '',
  'Usage: agent-app-spend-check [--config <file>] [--json] [--as-of <iso>] [--skip <check,check>]',
  '',
  `  --config <file>   Config module. Default ${DEFAULT_CONFIG_FILE}.`,
  '  --json            Emit the report as JSON instead of a table.',
  '  --as-of <iso>     Treat this instant as "now". Default: the current time.',
  '  --skip <checks>   Comma-separated check ids to leave out.',
  '',
  'The config module default-exports (or exports as `config`) the reconcile options,',
  'or a function returning them. It supplies the two things this package cannot:',
  'the product\'s own expectation store, and an authenticated fetch of its settled',
  'ledger rows. Scope that fetch to boxes this product owns.',
  '',
  'Exit 0 = clean, 1 = findings, 2 = usage or config error.',
].join('\n')

export interface SpendCliArgs {
  readonly configFile: string
  readonly json: boolean
  readonly asOf: number | undefined
  readonly skip: readonly string[]
}

/** Parse argv. Split out of `cli.ts` so it is testable without a `process.exit`. */
export function parseSpendArgs(argv: readonly string[]): SpendCliArgs {
  let configFile = DEFAULT_CONFIG_FILE
  let json = false
  let asOf: number | undefined
  let skip: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') {
      json = true
    } else if (arg === '--config') {
      const value = argv[++i]
      if (!value) throw new SpendUsageError('--config needs a file path')
      configFile = value
    } else if (arg === '--as-of') {
      const value = argv[++i]
      if (!value) throw new SpendUsageError('--as-of needs an ISO instant')
      const parsed = Date.parse(value)
      if (Number.isNaN(parsed)) throw new SpendUsageError(`--as-of is not a date: ${value}`)
      asOf = parsed
    } else if (arg === '--skip') {
      const value = argv[++i]
      if (!value) throw new SpendUsageError('--skip needs a comma-separated list of check ids')
      skip = value.split(',').map((part) => part.trim()).filter(Boolean)
    } else if (arg === '--help' || arg === '-h') {
      throw new SpendUsageError('help')
    } else if (arg !== undefined) {
      throw new SpendUsageError(`unrecognized argument: ${arg}`)
    }
  }

  return { configFile, json, asOf, skip }
}

/**
 * Load the product's reconcile options.
 *
 * A function export is awaited, so a config can open its database connection and
 * mint its platform credential at load time rather than at module scope.
 */
export async function loadSpendConfig(configFile: string): Promise<ReconcileSpendOptions> {
  const resolved = resolve(process.cwd(), configFile)
  let module: Record<string, unknown>
  try {
    module = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>
  } catch (err) {
    throw new SpendUsageError(
      `could not load ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const exported = module.default ?? module.config
  const value = typeof exported === 'function' ? await (exported as () => unknown)() : exported
  if (!value || typeof value !== 'object') {
    throw new SpendUsageError(`${resolved} must export reconcile options as \`default\` or \`config\``)
  }
  const options = value as Partial<ReconcileSpendOptions>
  if (!Array.isArray(options.rows)) {
    throw new SpendUsageError(`${resolved} must supply \`rows\` — the product's own settled-ledger fetch`)
  }
  if (!options.store) {
    throw new SpendUsageError(`${resolved} must supply \`store\` — the product's expectation ledger`)
  }
  return options as ReconcileSpendOptions
}
