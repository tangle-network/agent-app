import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { satisfiesRange } from '../src/peer-floors/check'

const root = fileURLToPath(new URL('..', import.meta.url))

// Run without a built dist or installed engine graph, so a template pin drift
// fails before the more expensive fresh packed-consumer install.
it('generates a chat consumer whose Sandbox UI pin satisfies the shell peer floor', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'generated-ui-peer-'))
  try {
    const project = join(temporary, 'chat')
    execFileSync(process.execPath, [join(root, 'create-agent-app/index.mjs'), project, '--name', 'profile-peer-check', '--chat'])
    const generated = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const shell = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string; peerDependencies: Record<string, string> }
    expect(generated.dependencies['@tangle-network/agent-app']).toBe(shell.version)
    const pin = generated.dependencies['@tangle-network/sandbox-ui']
    const floor = shell.peerDependencies['@tangle-network/sandbox-ui']
    expect(pin).toBeDefined()
    expect(floor).toBeDefined()
    expect(satisfiesRange(pin!, floor!), `generated Sandbox UI ${pin} must satisfy ${floor}`).toBe(true)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
