import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      // Mirror wrangler's `[[rules]]` Text modules: `.md` imports (the system
      // prompt) resolve to plain strings under vitest too.
      name: 'text-markdown',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('.md')) {
          return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`
        }
        return null
      },
    },
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
