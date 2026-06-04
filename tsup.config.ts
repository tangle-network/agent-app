import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'tools/index': 'src/tools/index.ts',
    'delegation/index': 'src/delegation/index.ts',
    'tangle/index': 'src/tangle/index.ts',
    'runtime/index': 'src/runtime/index.ts',
    'eval/index': 'src/eval/index.ts',
    'knowledge/index': 'src/knowledge/index.ts',
    'config/index': 'src/config/index.ts',
    'preset-cloudflare/index': 'src/preset-cloudflare/index.ts',
    'billing/index': 'src/billing/index.ts',
    'crypto/index': 'src/crypto/index.ts',
    'stream/index': 'src/stream/index.ts',
    'integrations/index': 'src/integrations/index.ts',
    'web/index': 'src/web/index.ts',
    'redact/index': 'src/redact/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['@tangle-network/agent-integrations', '@tangle-network/agent-integrations/catalog', '@tangle-network/agent-eval'],
})
