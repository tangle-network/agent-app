#!/usr/bin/env node
/**
 * `agent-app-legibility-check` — fail a product's CI when a screen leaves its
 * reader guessing.
 *
 * Runs in the PRODUCT's repo, over the product's own source, next to typecheck:
 *
 *     "scripts": {
 *       "legibility": "agent-app-legibility-check --src src --routes src/routes.ts --nav src/components/workspace-sidebar.tsx"
 *     }
 *
 * Flags (repeatable where a list makes sense):
 *   --src <dir>          source directory to scan (required unless the config supplies it)
 *   --routes <file>      react-router route config, for the unreachable-capability check
 *   --nav <file>         a file whose path literals are navigation entries
 *   --ignore <substr>    skip paths containing this substring
 *   --skip <check>       turn one check off wholesale (prefer a per-line suppression)
 *   --config <file>      a legibility.config.mjs default-exporting the config
 *                        (default: ./legibility.config.mjs when present)
 *   --json               print the report as JSON instead of text
 *   --list-suppressions  print every honoured suppression with its reason
 *
 * Exit 0 with no findings, 1 with findings, 2 on a usage or config error — the
 * same contract as `agent-app-preflight` and `agent-app-peer-check`.
 */
export {};
