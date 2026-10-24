/**
 * src/sandbox.ts — product sandbox policy and file/interaction access.
 *
 * `createChatTurnRoutes` owns Router-first hybrid execution and sandbox fallback.
 * This file supplies the product policy and the sandbox access that uploads
 * and interaction answers need:
 *
 *   - `createSandboxShell` — product provisioning, profile and credential policy.
 *     `createChatTurnRoutes` assembles the lane from it.
 *   - `resolveUploadSink`      — where >inline-cap uploads land (`box.fs`).
 *   - `resolveSidecarConnection` — where interaction answers go.
 *
 * No mock fallback: without SANDBOX_API_KEY / SANDBOX_GATEWAY_URL the turn
 * fails loud with a clear error instead of pretending to answer.
 */

import { config } from '../agent.config'
import {
  type SandboxUploadSink,
} from '@tangle-network/agent-app/chat-routes'
import type { SidecarInteractionsConnection } from '@tangle-network/agent-app/interactions'
import {
  createD1PrewarmClaimStore,
  ensureWorkspaceSandbox,
  peekWorkspaceSandbox,
  runForegroundSandboxSingleFlight,
  type SandboxRuntimeConfig,
} from '@tangle-network/agent-app/sandbox'
import type { TurnTrace } from '@tangle-network/agent-app/turn-trace'
import type { AppEnv } from './env'

/** Lowercased, non-alphanumerics collapsed: box names + projectId. */
export const appSlug = config.name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

/**
 * The sandbox shell: how boxes are named, credentialed, and provisioned for
 * this product. Extend here when you add per-workspace env, file mounts, or
 * per-user key minting (see `resolveSandboxClientCredentials` in
 * `@tangle-network/agent-app/sandbox` for the credential-policy helper).
 */
export function createSandboxShell(env: AppEnv): SandboxRuntimeConfig {
  return {
    credentials: () => {
      const apiKey = env.SANDBOX_API_KEY?.trim()
      const baseUrl = env.SANDBOX_GATEWAY_URL?.trim()
      if (!apiKey || !baseUrl) return null
      return { apiKey, baseUrl }
    },
    name: (workspaceId) => `${appSlug}-${workspaceId}`.slice(0, 63),
    metadata: (harness) => ({ app: appSlug, harness }),
    connectedIntegrationIds: async () => [],
    env: async () => ({}),
    files: async () => [],
    secrets: async () => [],
    profile: ({ systemPrompt, extraMcp }) => ({
      name: appSlug,
      prompt: { systemPrompt: systemPrompt ?? config.systemPrompt },
      ...(extraMcp && Object.keys(extraMcp).length > 0 ? { mcp: extraMcp } : {}),
    }),
    provider: {
      ...(env.TANGLE_API_KEY ? { apiKey: env.TANGLE_API_KEY } : {}),
      ...(env.TANGLE_ROUTER_URL ? { routerBaseUrl: env.TANGLE_ROUTER_URL } : {}),
      ...(env.MODEL_NAME ? { modelName: env.MODEL_NAME } : {}),
      defaultModel: config.model.default,
    },
  }
}

/**
 * Provision once across Worker isolates. A turn, upload, and interaction can
 * arrive together for one new workspace. They must adopt one box, not create
 * three boxes with the same name.
 */
async function ensureForegroundWorkspaceSandbox(
  env: AppEnv,
  shell: SandboxRuntimeConfig,
  scope: { workspaceId: string; userId: string },
  trace?: TurnTrace,
) {
  return runForegroundSandboxSingleFlight({
    claim: createD1PrewarmClaimStore(env.DB),
    workspaceId: scope.workspaceId,
    harness: config.harness,
    provision: () => ensureWorkspaceSandbox(shell, { ...scope, harness: config.harness, ...(trace ? { trace } : {}) }),
    peek: () => peekWorkspaceSandbox(shell, scope),
    adopt: ({ box }) => box,
  })
}

/** Where large uploads land: the workspace box's filesystem. Returns null when
 *  no sandbox is configured — the upload route then accepts inline files only
 *  and rejects oversized ones with an explicit 413. */
export async function resolveUploadSink(
  env: AppEnv,
  scope: { workspaceId: string; userId: string },
): Promise<SandboxUploadSink | null> {
  if (!env.SANDBOX_API_KEY?.trim() || !env.SANDBOX_GATEWAY_URL?.trim()) return null
  const shell = createSandboxShell(env)
  const box = await ensureForegroundWorkspaceSandbox(env, shell, scope)
  return box.fs
}

/** The sidecar connection interaction answers travel over. `sessionId` is the
 *  thread id — the same session the turn streams under. */
export async function resolveSidecarConnection(
  env: AppEnv,
  scope: { workspaceId: string; userId: string; threadId: string },
  options: { readOnly?: boolean } = {},
): Promise<SidecarInteractionsConnection | null> {
  if (!env.SANDBOX_API_KEY?.trim() || !env.SANDBOX_GATEWAY_URL?.trim()) return null
  const shell = createSandboxShell(env)
  // Reading pending decisions must not provision paid compute.
  const found = options.readOnly ? await peekWorkspaceSandbox(shell, { workspaceId: scope.workspaceId, userId: scope.userId }) : null
  const box = options.readOnly
    ? found?.status === 'running' ? found.box : null
    : await ensureForegroundWorkspaceSandbox(env, shell, { workspaceId: scope.workspaceId, userId: scope.userId })
  if (!box) return null
  const connection = box.connection
  if (!connection?.runtimeUrl) return null
  return {
    runtimeUrl: connection.runtimeUrl,
    ...(connection.authToken ? { authToken: connection.authToken } : {}),
    sessionId: scope.threadId,
  }
}
