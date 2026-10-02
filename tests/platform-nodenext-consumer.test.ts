import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = resolve(__dirname, '..')

describe('platform package declarations', () => {
  it('exposes SSO symbols to an installed NodeNext consumer', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'agent-app-platform-nodenext-'))
    const installation = join(consumer, 'node_modules', '@tangle-network', 'agent-app')

    try {
      mkdirSync(installation, { recursive: true })
      cpSync(join(repo, 'package.json'), join(installation, 'package.json'))
      cpSync(join(repo, 'dist'), join(installation, 'dist'), { recursive: true })
      writeFileSync(join(consumer, 'probe.mts'), [
        "import { createTangleSsoHandlers } from '@tangle-network/agent-app/platform'",
        "import type { TangleSsoAccountStore, TangleSsoExchangeResult } from '@tangle-network/agent-app/platform'",
        'export type SsoSurface = [typeof createTangleSsoHandlers, TangleSsoAccountStore, TangleSsoExchangeResult]',
      ].join('\n'))

      const result = spawnSync(join(repo, 'node_modules', '.bin', 'tsc'), [
        '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
        '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
        join(consumer, 'probe.mts'),
      ], { cwd: consumer, encoding: 'utf8', stdio: 'pipe' })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    } finally {
      rmSync(consumer, { recursive: true, force: true })
    }
  }, 30_000)
})
