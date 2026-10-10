import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

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
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', 'create-agent-app/template/**', 'create-agent-app/template-chat/**'],
    // Unmount @testing-library React trees between tests (this repo doesn't run
    // with `globals: true`, so RTL's auto-cleanup hook isn't registered).
    setupFiles: ['./src/test-setup.ts'],
    // sandbox-ui's workbench chunks import xterm.css; inlining sandbox-ui lets
    // vite stub the CSS import instead of node rejecting the extension (the
    // same fix every fleet app on sandbox-ui carries in ITS vitest config).
    server: { deps: { inline: [/@tangle-network\/sandbox-ui/] } },
    // Files run in 8 parallel forks. Each fork loads the full module
    // graph (React, TipTap, drizzle, better-sqlite3, konva), about 0.7 GB, so the
    // fork count bounds peak RSS; one fork at a time made the suite several
    // times slower.
    pool: 'forks',
    maxWorkers: 8,
    execArgv: ['--max-old-space-size=4096'],
  },
})
