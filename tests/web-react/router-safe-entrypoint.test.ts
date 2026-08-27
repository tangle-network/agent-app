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

  it('keeps sandbox terminal UI on the explicit terminal subpath', () => {
    const terminal = read('src/web-react/terminal.ts')

    expect(terminal).toContain("export * from './sandbox-terminal'")
    expect(terminal).toContain("export * from './workspace-terminal-panel'")
  })
})
