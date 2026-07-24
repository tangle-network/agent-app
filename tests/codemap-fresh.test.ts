/**
 * The code-map staleness gate. `docs/CODEMAP.md` + `docs/api/*.md` are generated
 * from `tsup.config.ts` `entry` and the TypeScript export graph by
 * `scripts/gen-codemap.mjs`. This runs the generator's `--check` mode, which
 * regenerates in memory and exits non-zero the moment the committed docs drift
 * from the current source — a new subpath, a renamed export, a changed signature,
 * or a removed page. Fix by running `pnpm docs:gen` and committing the result.
 * Mirrors the intent of `tests/theme/tokens-contract.test.ts`: the generator IS
 * the single source of truth; this test just enforces adoption.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(repoRoot, 'scripts', 'gen-codemap.mjs')

describe('codemap freshness', () => {
  it('committed docs/CODEMAP.md + docs/api/*.md match the current source', () => {
    const res = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' })
    const detail = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim()
    expect(res.status, `codemap --check failed — run \`pnpm docs:gen\` and commit:\n${detail}`).toBe(0)
  })
})
