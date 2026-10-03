import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

// Run the application seams against the retained Eval line, leaving the current
// Runtime/Knowledge development cohort intact.
export default defineConfig({
  ...base,
  resolve: {
    alias: [{
      find: /^@tangle-network\/agent-eval(?=\/|$)/,
      replacement: 'agent-eval-0204',
    }],
  },
  test: {
    ...base.test,
    include: [
      'tests/eval-compat/identity.compat.ts',
      'tests/eval.test.ts',
      'tests/model-catalog.test.ts',
      'src/eval/**/*.test.ts',
      'src/eval-campaign/**/*.test.ts',
      'src/profile/**/*.test.ts',
      'src/knowledge/**/*.test.ts',
    ],
  },
})
