import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

describe('published channels subpath', () => {
  it('resolves and imports the real built package in Node, outside Vitest transforms', () => {
    // pnpm install's prepare and pnpm build produce the published package.
    // Missing build output is a failure, never a skipped compatibility claim.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const module = await import('@tangle-network/agent-app/channels');
      console.log(JSON.stringify({ url: import.meta.resolve('@tangle-network/agent-app/channels'), exports: Object.keys(module) }));
    `], { cwd: root, encoding: 'utf8' })
    const built = JSON.parse(output) as { url: string; exports: string[] }
    expect(built.url).toMatch(/\/dist\/channels\/index\.js$/)
    expect(built.exports).toEqual(expect.arrayContaining(['ChannelsProvider', 'useChannel', 'IMessageChannel', 'WhatsAppChannel', 'SMSChannel', 'EmailChannel', 'ChannelConversation', 'NumberChannel', 'LinePayPage']))
    expect(readFileSync(resolve(root, 'dist/channels/index.d.ts'), 'utf8')).toContain('ChannelsClient')
  })
})
