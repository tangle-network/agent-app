import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = resolve(__dirname, '..')

// The packed archive is what a NodeNext consumer such as super-agent installs. Every
// relative specifier in its declarations must name a file, or `export *` exports
// nothing and named re-exports fail with TS2305.
describe('packed declarations', () => {
  it('resolve for an installed NodeNext consumer', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'agent-app-nodenext-'))
    const consumer = join(scratch, 'consumer')
    const installation = join(consumer, 'node_modules', '@tangle-network', 'agent-app')

    try {
      const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], {
        cwd: repo, encoding: 'utf8',
      }))
      const archive = (Array.isArray(packed) ? packed[0] : packed['@tangle-network/agent-app']).filename
      mkdirSync(installation, { recursive: true })
      execFileSync('tar', ['-xzf', join(scratch, archive), '-C', installation, '--strip-components=1'])
      writeFileSync(join(consumer, 'probe.mts'), [
        "import type { ChatMessageSegment, ChatToolCallInfo, ChatUiMessage, ModelPickerProps } from '@tangle-network/agent-app/web-react'",
        "import { ChatMessages } from '@tangle-network/agent-app/web-react'",
        "import { createChatOperatorAdapter, createOperatorApi, createOperatorClient, OPERATOR_ACCESS, OPERATOR_API_BASE_PATH, OperatorError, withPlatformAgentKeys } from '@tangle-network/agent-app/operator'",
        "import type { OperatorAdapter, OperatorKeyStore, OperatorTurn, PlatformAgentOperatorKey } from '@tangle-network/agent-app/operator'",
        "import { createAgentSurfaceHandler } from '@tangle-network/agent-app/agent-surfaces'",
        "import { createPlatformAgentKeyVerifier, createPlatformAgentSpend, createTangleSsoHandlers } from '@tangle-network/agent-app/platform'",
        "import type { TangleSsoAccountStore, TangleSsoExchangeResult } from '@tangle-network/agent-app/platform'",
        'export type ChatSurface = [ChatMessageSegment, ChatToolCallInfo, ChatUiMessage, ModelPickerProps, typeof ChatMessages]',
        'export type OperatorSurface = [typeof createChatOperatorAdapter, typeof createOperatorApi, typeof createOperatorClient, typeof OPERATOR_ACCESS,',
        '  typeof OperatorError, typeof withPlatformAgentKeys, OperatorAdapter<unknown>, OperatorTurn, PlatformAgentOperatorKey,',
        '  typeof createAgentSurfaceHandler, typeof createPlatformAgentKeyVerifier, typeof createPlatformAgentSpend,',
        '  typeof createTangleSsoHandlers, TangleSsoAccountStore, TangleSsoExchangeResult]',
        "export const basePath: '/api/operator/v1' = OPERATOR_API_BASE_PATH",
        // The key constraint resolves through the platform module; an unresolved import would make it `any`.
        '// @ts-expect-error a verified key needs ownerId, scopes and expiresAt',
        'export type IncompleteKey = OperatorKeyStore<{ keyId: string }, unknown>',
        // A segment that resolved to `any` would accept this.
        '// @ts-expect-error a chat segment is not a number',
        'export const segment: ChatMessageSegment = 1',
      ].join('\n'))

      const result = spawnSync(join(repo, 'node_modules', '.bin', 'tsc'), [
        '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--jsx', 'react-jsx',
        '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
        join(consumer, 'probe.mts'),
      ], { cwd: consumer, encoding: 'utf8', stdio: 'pipe' })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 120_000)
})
