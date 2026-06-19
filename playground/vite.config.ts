import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)
// Resolve each peer to the PLAYGROUND's own copy. agent-app is linked via
// `file:..` (a symlink), so Vite resolves react/react-konva imported from the
// linked dist by walking up from the symlink TARGET — which lands on the parent
// repo's own dev-dep copies (react@19 + react-konva@19). react-konva@19 then
// throws "only compatible with React 19" against the playground's React 18, and
// two React copies break hooks. Pinning absolute paths forces one consistent,
// React-18 set across both the app and the linked package.
const pkgDir = (id: string) => dirname(require.resolve(`${id}/package.json`))

// Dev-only playground for agent-app's local (uncommitted) UI build. It consumes
// the freshly-built dist via the `file:..` dependency, so the linked package's
// `dist/*` is the real module graph under test here.
export default defineConfig({
  plugins: [react()],
  server: { port: 4321 },
  preview: { port: 4321 },
  resolve: {
    dedupe: ['react', 'react-dom', 'react-konva', 'konva'],
    alias: {
      react: pkgDir('react'),
      'react-dom': pkgDir('react-dom'),
      'react-konva': pkgDir('react-konva'),
      konva: pkgDir('konva'),
    },
  },
})
