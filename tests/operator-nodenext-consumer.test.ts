import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = resolve(__dirname, '..')

describe('operator package declarations', () => {
  it('expose the operator API, agent keys and agent surfaces to an installed NodeNext consumer', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'agent-app-operator-nodenext-'))
    const installation = join(consumer, 'node_modules', '@tangle-network', 'agent-app')

    try {
      mkdirSync(installation, { recursive: true })
      cpSync(join(repo, 'package.json'), join(installation, 'package.json'))
      cpSync(join(repo, 'dist'), join(installation, 'dist'), { recursive: true })
      writeFileSync(join(consumer, 'probe.mts'), [
        "import { createChatOperatorAdapter, createOperatorApi, createOperatorClient, OPERATOR_ACCESS, OPERATOR_API_BASE_PATH, OperatorError, withPlatformAgentKeys } from '@tangle-network/agent-app/operator'",
        "import type { OperatorAdapter, OperatorKeyStore, OperatorTurn, PlatformAgentOperatorKey } from '@tangle-network/agent-app/operator'",
        "import { createAgentSurfaceHandler } from '@tangle-network/agent-app/agent-surfaces'",
        "import { createPlatformAgentKeyVerifier, createPlatformAgentSpend } from '@tangle-network/agent-app/platform'",
        'export type OperatorSurface = [typeof createChatOperatorAdapter, typeof createOperatorApi, typeof createOperatorClient, typeof OPERATOR_ACCESS,',
        '  typeof OperatorError, typeof withPlatformAgentKeys, OperatorAdapter<unknown>, OperatorTurn, PlatformAgentOperatorKey,',
        '  typeof createAgentSurfaceHandler, typeof createPlatformAgentKeyVerifier, typeof createPlatformAgentSpend]',
        "export const basePath: '/api/operator/v1' = OPERATOR_API_BASE_PATH",
        // The key constraint resolves through the platform module; an unresolved import would make it `any`.
        '// @ts-expect-error a verified key needs ownerId, scopes and expiresAt',
        'export type IncompleteKey = OperatorKeyStore<{ keyId: string }, unknown>',
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
