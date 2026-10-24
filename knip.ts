import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * knip's entries are the built subpaths, read from `tsup.config.ts`, plus the
 * files that are entries without being built (tests, stories, fixtures, the
 * CLI). A static list had to be updated beside tsup by hand, and on 2026-10-11
 * three new subpaths landed without it (#1010, #1023, workspace-store/d1),
 * turning main's entry guard red each time. Deriving it removes that step.
 */
const root = dirname(fileURLToPath(import.meta.url))

/** Every source path on the right-hand side of `tsup.config.ts`'s `entry` map. */
export function tsupEntries(): string[] {
  const source = readFileSync(join(root, 'tsup.config.ts'), 'utf8')
  const block = /entry:\s*\{([\s\S]*?)\n {2}\}/.exec(source)
  if (!block?.[1]) throw new Error('tsup.config.ts: could not locate the `entry` map')
  return [...block[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1] as string)
}

/** Entries that tsup does not build. */
export const UNBUILT_ENTRIES = [
  'bin/tangle-agent/**/*.mjs',
  'src/**/*.stories.{ts,tsx}',
  'src/**/*.test.{ts,tsx}',
  'src/stories/fixtures/**/*.ts',
  'src/stories/**/fixtures.ts',
  'tests/**/*.test.{ts,tsx}',
  'tests/**/*.integration.ts',
  'tests/turn-stream/durable-stop.transport.ts',
  'tests/turn-stream/durable-stop.worker.ts',
  'tests/workers/lock-prewarm.worker.ts',
]

export default {
  entry: [...tsupEntries(), ...UNBUILT_ENTRIES],
  project: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
  ignore: [
    '.worktrees/**',
    'create-agent-app/template/**',
    'create-agent-app/template-chat/**',
    'playground/**',
    'tests/theme/fixtures/**',
  ],
  // The journeys kit shells out to ffmpeg and ffprobe for its videos; they are host tools, not dependencies.
  ignoreBinaries: ['tsc', 'ffmpeg', 'ffprobe'],
  ignoreDependencies: [
    '@anthropic-ai/sdk',
    '@tangle-network/agent-gateway',
    '@tangle-network/agent-profile-materialize',
    '@xterm/addon-fit',
    '@xterm/addon-web-links',
    '@xterm/addon-webgl',
    '@xterm/xterm',
    'hono',
  ],
  rules: { duplicates: 'off' },
}
