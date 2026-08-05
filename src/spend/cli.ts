#!/usr/bin/env node
/**
 * `agent-app-spend-check` — reconcile what the platform charged for sandbox
 * compute against what this product believes it asked for.
 *
 * Runs in the CONSUMER's repo, on a schedule, over the consumer's own ledger
 * fetch and expectation store — the two things this package deliberately does
 * not reach for. Add it next to the other gates:
 *
 *     "scripts": { "spend-check": "agent-app-spend-check" }
 *
 * Exits 1 on any finding, 0 when clean, 2 on a usage or config error. It never
 * disputes, refunds, or writes anything; the output is evidence a human acts on.
 */
import { SpendUsageError, USAGE, loadSpendConfig, parseSpendArgs } from './cli-args'
import { reconcileSpend } from './reconcile'
import { formatSpendReport, spendReportToJson } from './report'
import type { SpendCheckId } from './types'

async function main(): Promise<number> {
  const args = parseSpendArgs(process.argv.slice(2))
  const config = await loadSpendConfig(args.configFile)
  const report = await reconcileSpend({
    ...config,
    ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
    ...(args.skip.length > 0 ? { skip: args.skip as SpendCheckId[] } : {}),
  })
  const rendered = args.json ? spendReportToJson(report) : formatSpendReport(report)
  // A clean report is routine output; a failing one belongs on stderr so a cron
  // that only forwards stderr still delivers the alert.
  if (report.ok) process.stdout.write(`${rendered}\n`)
  else process.stderr.write(`${rendered}\n`)
  return report.ok ? 0 : 1
}

try {
  process.exit(await main())
} catch (err) {
  if (err instanceof SpendUsageError) {
    process.stderr.write(`${err.message === 'help' ? '' : `${err.message}\n\n`}${USAGE}\n`)
    process.exit(2)
  }
  process.stderr.write(
    `agent-app-spend-check failed: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(2)
}
