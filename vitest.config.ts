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
    // The suite grew large enough that a fork worker hit the default ~2GB heap
    // and crashed (ERR_WORKER_OUT_OF_MEMORY) in the publish verify job. Give
    // each worker headroom; the runner has ample RAM.
    pool: 'forks',
    poolOptions: {
      forks: { execArgv: ['--max-old-space-size=4096'] },
    },
  },
})
