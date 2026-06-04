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
  },
})
