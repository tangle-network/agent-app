import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

// Run the application seams against another admitted Eval line, leaving the
// current Runtime/Knowledge development cohort intact: the retained 0.204 line
// by default, or the line AGENT_EVAL_COMPAT names (agent-eval-0211).
const compat = process.env.AGENT_EVAL_COMPAT ?? 'agent-eval-0204'

export default defineConfig({
  ...base,
  resolve: {
    alias: [{
      find: /^@tangle-network\/agent-eval(?=\/|$)/,
      replacement: compat,
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
