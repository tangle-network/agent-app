import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/postcss'

export default defineConfig({
  root: 'web',
  // web/public is copied as-is to dist/client; it holds _headers (cache rules).
  publicDir: 'public',
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  build: { outDir: '../dist/client', emptyOutDir: true },
})
