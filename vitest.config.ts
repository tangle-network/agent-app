import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The framework's own tests live in `tests/**` and co-located `src/**`.
    // EXCLUDE `create-agent-app/template*/**`: those are scaffolder templates
    // whose tests run inside a GENERATED project, not here (they import the
    // published `@tangle-network/agent-app`, absent in this repo's module
    // graph). The scaffolders themselves are exercised by
    // `tests/create-agent-app.test.ts` / `tests/create-agent-app-chat.test.ts`.
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', 'create-agent-app/template/**', 'create-agent-app/template-chat/**'],
    // Unmount @testing-library React trees between tests (this repo doesn't run
    // with `globals: true`, so RTL's auto-cleanup hook isn't registered).
    setupFiles: ['./src/test-setup.ts'],
    // Run test FILES one at a time. Parallel forks each load the full module
    // graph (React, TipTap, drizzle, better-sqlite3, konva) and accumulate heap
    // across the files they own; serializing bounds peak RSS to a single file
    // (~0.7GB vs ~3.5GB fanned out) and removes the CPU contention that
    // intermittently failed real-timer tests. The suite is small, so the
    // sequential wall-time cost is only a few seconds.
    pool: 'forks',
    fileParallelism: false,
    poolOptions: {
      forks: { execArgv: ['--max-old-space-size=4096'] },
    },
  },
})
