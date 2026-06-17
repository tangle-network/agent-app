import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The framework's own tests live in `tests/**` and co-located `src/**`.
    // EXCLUDE `create-agent-app/template/**`: that is a scaffolder template whose
    // tests run inside a GENERATED project, not here (they import the published
    // `@tangle-network/agent-app`, absent in this repo's module graph). The
    // scaffolder itself is exercised by `tests/create-agent-app.test.ts`.
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'create-agent-app/template/**'],
    // Run test FILES one at a time. With parallel forks, each worker loads the
    // full module graph (React, TipTap, drizzle, better-sqlite3, konva) and
    // accumulates heap across the files it owns; on the 4-core publish runner the
    // combined footprint exceeded usable RAM and tinypool crashed a worker with
    // ERR_WORKER_OUT_OF_MEMORY. Serializing bounds peak RSS to a single file
    // (~0.7GB locally vs ~3.5GB fanned out) and also removes the CPU contention
    // that intermittently failed real-timer tests. The suite is small, so the
    // sequential wall-time cost is a few seconds — acceptable for a publish gate.
    pool: 'forks',
    fileParallelism: false,
    poolOptions: {
      forks: { execArgv: ['--max-old-space-size=4096'] },
    },
  },
})
