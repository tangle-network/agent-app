/**
 * The node-only recursive source walker `/legibility` and `/theme-contract`
 * both need: collect scannable files under a directory, skipping vendor and
 * generated output. Extracted here because it drifted into two copies one day
 * apart with different skip lists — `/theme-contract`'s was missing
 * `.react-router` / `.wrangler` / `.turbo`, so it descended into and linted
 * framework-generated output the newer list correctly skips.
 *
 * Zero dependencies beyond `node:fs`/`node:path`, so either subpath can import
 * it without pulling in the other's unrelated surface (`/legibility`'s own
 * hand-written lexer, in particular).
 */

import { type Dirent, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Extensions a "source file" scan considers — TS/TSX/JS/JSX/MJS/CJS. */
const SOURCE_FILE_RE = /\.(tsx?|jsx?|mjs|cjs)$/

/** Directories never worth descending into: dependency trees and every
 *  framework's generated-output dir this fleet's stacks produce. Callers
 *  needing a different set pass their own via `walkSources`'s `skipDirs`. */
const GENERATED_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.react-router',
  'coverage',
  '.wrangler',
  '.turbo',
])

/**
 * Recursively collect scannable files under `dir`.
 *
 * `ignore` is matched by substring against the full path — the caller's own
 * exclusions (test files, fixtures, `.d.ts`, generated route types, …) layer
 * on top of the shared `GENERATED_SKIP_DIRS` floor rather than being baked in
 * here, since which files count as "source" is a per-checker policy.
 */
export function walkSources(
  dir: string,
  ignore: readonly string[] = [],
  skipDirs: ReadonlySet<string> = GENERATED_SKIP_DIRS,
): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return skipDirs.has(entry.name) ? [] : walkSources(full, ignore, skipDirs)
      return SOURCE_FILE_RE.test(entry.name) ? [full] : []
    })
    .filter((file) => !ignore.some((needle) => file.includes(needle)))
}
