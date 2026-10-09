#!/usr/bin/env node
/**
 * `agent-app-agent-surfaces <config.json> --out <dir> [--check]`
 *
 * Writes a product's agent surfaces as static files, for products that serve
 * them as assets. `--check` writes nothing and exits 1 when a committed file
 * differs from what the config generates, so product docs cannot drift from
 * the shared source. Exit 2 is a usage error.
 */
import { runAgentSurfacesCli } from './generate'

process.exit(runAgentSurfacesCli(process.argv.slice(2)))
