import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = resolve(__dirname, '..')

describe('sandbox recovery package declarations', () => {
  it('requires a replacement key in an installed consumer while accepting a keyless decline', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'agent-app-recovery-consumer-'))
    const installation = join(consumer, 'node_modules', '@tangle-network', 'agent-app')

    try {
      mkdirSync(installation, { recursive: true })
      cpSync(join(repo, 'package.json'), join(installation, 'package.json'))
      cpSync(join(repo, 'dist'), join(installation, 'dist'), { recursive: true })
      writeFileSync(join(consumer, 'consumer.mts'), [
        "import { createWorkspaceSandboxRecoveryManager } from '@tangle-network/agent-app/sandbox'",
        'const manager = createWorkspaceSandboxRecoveryManager({',
        '  read: async () => undefined, write: async () => {},',
        '})',
        "void manager.decide({ workspaceId: 'w', sandboxId: 'box', decision: 'replace', replacementBoxKey: 'fresh' })",
        "void manager.decide({ workspaceId: 'w', sandboxId: 'box', decision: 'decline' })",
        '// @ts-expect-error Replacement requires an explicit key.',
        "void manager.decide({ workspaceId: 'w', sandboxId: 'box', decision: 'replace' })",
        '// @ts-expect-error Undefined is not a replacement key.',
        "void manager.decide({ workspaceId: 'w', sandboxId: 'box', decision: 'replace', replacementBoxKey: undefined })",
      ].join('\n'))

      const result = spawnSync(join(repo, 'node_modules', '.bin', 'tsc'), [
        '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
        '--module', 'ESNext', '--moduleResolution', 'Bundler',
        join(consumer, 'consumer.mts'),
      ], { cwd: consumer, encoding: 'utf8', stdio: 'pipe' })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    } finally {
      rmSync(consumer, { recursive: true, force: true })
    }
  }, 30_000)
})
