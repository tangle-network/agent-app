import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
// Resolve each peer to the PLAYGROUND's own copy. agent-app is linked via
// `file:..` (a symlink), so Vite resolves react/react-konva imported from the
// linked dist by walking up from the symlink TARGET — which lands on the parent
// repo's own dev-dep copies. Two React copies break hooks, even when their
// versions match. Pinning absolute paths forces one set across both packages.
function pkgDir(id: string): string {
  let dir = dirname(require.resolve(id))
  while (true) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
      if (pkg.name === id) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`Could not locate package root for ${id}`)
    dir = parent
  }
}

// Dev-only playground for agent-app's local (uncommitted) UI build. It consumes
// the freshly-built dist via the `file:..` dependency, so the linked package's
// `dist/*` is the real module graph under test here.
export default defineConfig({
  plugins: [react()],
  server: { port: 4321 },
  preview: { port: 4321 },
  // The terminal panel (a lazy, never-rendered import here) drags in @xterm,
  // which the playground doesn't install. Exclude agent-app from pre-bundling
  // and alias the terminal subpath to a stub so the optimizer doesn't choke.
  optimizeDeps: { exclude: ['@tangle-network/agent-app'] },
  resolve: {
    dedupe: ['react', 'react-dom', 'react-konva', 'konva'],
    alias: {
      '@tangle-network/sandbox-ui/terminal': resolve(__dirname, 'terminal-stub.js'),
      '@xterm/xterm': resolve(__dirname, 'terminal-stub.js'),
      '@xterm/addon-fit': resolve(__dirname, 'terminal-stub.js'),
      '@xterm/addon-web-links': resolve(__dirname, 'terminal-stub.js'),
      react: pkgDir('react'),
      'react-dom': pkgDir('react-dom'),
      'react-konva': pkgDir('react-konva'),
      konva: pkgDir('konva'),
    },
  },
})
