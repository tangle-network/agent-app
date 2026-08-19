import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

function read(path: string) {
  return readFileSync(join(root, path), 'utf8')
}

describe('web-react Router entrypoint', () => {
  it('does not import sandbox-only UI through the default React surface', () => {
    const index = read('src/web-react/index.tsx')
    const composer = read('src/web-react/chat-composer.tsx')

    expect(index).not.toContain("from './workspace-terminal-panel'")
    expect(composer).not.toContain('@tangle-network/sandbox-ui')
  })

  it('keeps the mention stack free of sandbox-ui (ported from it, never importing it)', () => {
    for (const file of [
      'src/web-react/mention-editor.tsx',
      'src/web-react/mention-list.tsx',
      'src/web-react/mention-serialize.ts',
      'src/web-react/mention-pill.ts',
    ]) {
      expect(read(file)).not.toContain('@tangle-network/sandbox-ui')
    }
  })

  it('keeps the entry-composer assembly free of sandbox-ui and lucide (moved from /chat-react)', () => {
    // These two came from the subpath whose whole purpose was importing
    // sandbox-ui, and one carried a lucide icon. In /web-react a static
    // import of either optional peer is a build-time requirement for every
    // consumer of the default surface.
    for (const file of [
      'src/web-react/entry-composer.tsx',
      'src/web-react/composer-mode-controls.tsx',
    ]) {
      const source = read(file)
      expect(source).not.toContain('@tangle-network/sandbox-ui')
      expect(source).not.toContain('lucide-react')
    }
  })

  it('reaches the @tiptap optional peers only through type-only or dynamic imports', () => {
    // A missing optional peer resolves to a bundler stub with no named
    // exports, so ONE static `import { x } from '@tiptap/…'` anywhere in the
    // shipped graph fails the build of every tiptap-less web-react consumer
    // (measured against Vite 7's `__vite-optional-peer-dep` stub). Dynamic
    // `import()` builds clean and throws a named error at first load instead.
    for (const file of ['src/web-react/mention-editor.tsx', 'src/web-react/chat-composer.tsx']) {
      for (const line of read(file).split('\n')) {
        if (!/from ['"]@tiptap\//.test(line)) continue
        expect(
          line.trimStart().startsWith('import type'),
          `${file}: static @tiptap value-import breaks tiptap-less consumers: ${line.trim()}`,
        ).toBe(true)
      }
    }
  })

  it('keeps sandbox terminal connection mechanism on the explicit terminal subpath', () => {
    // The shared panel component was removed (#340, zero importers org-wide)
    // — the subpath now serves only the connection hook/id; panel chrome is a
    // product concern (gtm/creative each keep their own local panel).
    const terminal = read('src/web-react/terminal.ts')

    expect(terminal).toContain("export * from './sandbox-terminal'")
    expect(terminal).not.toContain('workspace-terminal-panel')
  })
})
