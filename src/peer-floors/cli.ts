#!/usr/bin/env node
/**
 * `agent-app-peer-check` — fail a consumer's CI when its installed tree sits
 * below a peer floor this package declares.
 *
 * Runs in the CONSUMER's repo, over the consumer's own `node_modules`, because
 * the floors only mean anything against a real install. Add it next to
 * typecheck:
 *
 *     "scripts": { "peer-check": "agent-app-peer-check" }
 *
 * Exits 1 on any violation, 0 otherwise. Takes no configuration — the floors
 * come from the installed shell manifest, so the check cannot go stale when the
 * shell adds an engine.
 */
import { checkPeerFloors, formatPeerFloorReport } from './check'
import { invokedAsScript } from '../signoff/invoked-as-script'

function main(): void {
  const appDir = process.argv[2] ?? process.cwd()
  try {
    const report = checkPeerFloors({ appDir })
    process.stdout.write(`${formatPeerFloorReport(report)}\n`)
    process.exit(report.ok ? 0 : 1)
  } catch (err) {
    process.stderr.write(`agent-app-peer-check failed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

/* c8 ignore start — process wiring, exercised by the bin itself */
if (invokedAsScript(import.meta.url, process.argv[1])) main()
/* c8 ignore stop */
