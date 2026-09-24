import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'spend/index': 'src/spend/index.ts',
    'spend/cli': 'src/spend/cli.ts',
  },
  outDir: 'dist-spend',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['@tangle-network/sandbox', 'drizzle-orm', 'drizzle-orm/*'],
})
