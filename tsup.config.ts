import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'tools/index': 'src/tools/index.ts',
    'delegation/index': 'src/delegation/index.ts',
    'tangle/index': 'src/tangle/index.ts',
    'runtime/index': 'src/runtime/index.ts',
    'eval/index': 'src/eval/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
})
