import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const workerBudget = Number(process.env.VITEST_MAX_WORKERS ?? 8)
if (!Number.isSafeInteger(workerBudget) || workerBudget < 1) throw new Error('VITEST_MAX_WORKERS must be a positive integer')

const lockPrewarmProof = 'tests/lock-prewarm-workers.integration.test.ts'
const excluded = ['**/node_modules/**', '**/dist/**', 'create-agent-app/template/**', 'create-agent-app/template-chat/**']

export default defineConfig({
  test: {
    // The example imports the published subpath. Resolve it to this checkout's
    // source when its Worker is exercised inside the repository test suite.
    alias: {
      '@tangle-network/agent-app/hosted-agent': fileURLToPath(new URL('./src/hosted-agent/index.ts', import.meta.url)),
    },
    // The framework's own tests live in `tests/**` and co-located `src/**`.
    // EXCLUDE `create-agent-app/template*/**`: those are scaffolder templates
    // whose tests run inside a GENERATED project, not here (they import the
    // published `@tangle-network/agent-app`, absent in this repo's module
    // graph). The scaffolders themselves are exercised by
    // `tests/create-agent-app.test.ts` / `tests/create-agent-app-chat.test.ts`.
    projects: [
      { extends: true, test: {
        name: 'main', include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
        exclude: [...excluded, lockPrewarmProof], sequence: { groupOrder: 1 },
      } },
      // A wall-clock latency proof must run without concurrent test files. Keep
      // its <100ms assertion and real workerd path; do not relax the target.
      { extends: true, test: {
        name: 'lock-prewarm', include: [lockPrewarmProof], exclude: excluded,
        fileParallelism: false, sequence: { groupOrder: 2 },
      } },
    ],
    // Unmount @testing-library React trees between tests (this repo doesn't run
    // with `globals: true`, so RTL's auto-cleanup hook isn't registered).
    setupFiles: ['./src/test-setup.ts'],
    // sandbox-ui's workbench chunks import xterm.css; inlining sandbox-ui lets
    // vite stub the CSS import instead of node rejecting the extension (the
    // same fix every fleet app on sandbox-ui carries in ITS vitest config).
    server: { deps: { inline: [/@tangle-network\/sandbox-ui/] } },
    // Forks honor the runner's worker budget. Each fork loads the full module
    // graph (React, TipTap, drizzle, better-sqlite3, konva), about 0.7 GB, so the
    // fork count bounds peak RSS; one fork at a time made the suite several
    // times slower.
    pool: 'forks',
    maxWorkers: workerBudget,
    execArgv: ['--max-old-space-size=4096'],
  },
})
