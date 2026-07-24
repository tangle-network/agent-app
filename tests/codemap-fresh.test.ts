/**
 * The code-map staleness gate. `docs/CODEMAP.md` + `docs/api/*.md` + `docs/llms.txt`
 * + `docs/codemap.json` are generated from the TypeScript export graph by
 * `@tangle-network/agent-docs` (this repo dogfoods its own doc tool). This runs
 * `agent-docs --check`, which regenerates in memory and exits non-zero the moment
 * the committed docs drift from the current source — a new subpath, a renamed
 * export, a changed signature, a removed page. Fix by running `pnpm docs:gen`
 * (= `agent-docs`) and committing the result.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(repoRoot, 'node_modules', '@tangle-network', 'agent-docs', 'dist', 'cli.js')

describe('codemap freshness', () => {
  // Spawns the generator over the whole source tree; the walk scales with the
  // number of documented exports, so give it well over vitest's 5s default.
  it('committed docs match the current source (agent-docs --check)', () => {
    const res = spawnSync(process.execPath, [cli, '--repo', repoRoot, '--check'], { cwd: repoRoot, encoding: 'utf8' })
    const detail = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim()
    expect(res.status, `agent-docs --check failed — run \`pnpm docs:gen\` and commit:\n${detail}`).toBe(0)
  }, 60_000)
})
