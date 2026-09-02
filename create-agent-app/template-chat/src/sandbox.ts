/**
 * src/sandbox.ts — the config-driven sandbox lane. CODE, not data.
 *
 * Everything agent-shaped runs in a Tangle sandbox (a full agent harness:
 * skills, tools, bash, MCP) reached through `@tangle-network/agent-app`'s
 * sandbox helpers. This file turns `agent.config.ts` + env into the three
 * seams the chat vertical needs:
 *
 *   - `createSandboxProduce`   — the turn producer (`createChatTurnRoutes`'s
 *     `produce` seam): resolve the workspace box, stream the prompt, bridge
 *     raw sidecar events through `createSandboxChatProducer`.
 *   - `resolveUploadSink`      — where >inline-cap uploads land (`box.fs`).
 *   - `resolveSidecarConnection` — where interaction answers go.
 *
 * No mock fallback: without SANDBOX_API_KEY / SANDBOX_GATEWAY_URL the turn
 * fails loud with a clear error instead of pretending to answer.
 */

import { config } from '../agent.config'
import {
  createSandboxChatProducer,
  normalizeChatPromptForSandbox,
  type ChatTurnProduceArgs,
  type ChatTurnRouteProducer,
  type SandboxUploadSink,
} from '@tangle-network/agent-app/chat-routes'
import type { SidecarInteractionsConnection } from '@tangle-network/agent-app/interactions'
import {
  createD1PrewarmClaimStore,
  ensureWorkspaceSandbox,
  peekWorkspaceSandbox,
  runForegroundSandboxSingleFlight,
  streamSandboxPrompt,
  type SandboxRuntimeConfig,
} from '@tangle-network/agent-app/sandbox'
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
) {
  return runForegroundSandboxSingleFlight({
    claim: createD1PrewarmClaimStore(env.DB),
    workspaceId: scope.workspaceId,
    harness: config.harness,
    provision: () => ensureWorkspaceSandbox(shell, { ...scope, harness: config.harness }),
    peek: () => peekWorkspaceSandbox(shell, scope),
    adopt: ({ box }) => box,
  })
}

/**
 * The `produce` seam for `createChatTurnRoutes`: one call per turn. The
 * chat thread id doubles as the agent session id, so follow-up turns land in
 * the same sidecar session and keep its context.
 */
export function createSandboxProduce(env: AppEnv) {
  const shell = createSandboxShell(env)
  return async ({
    body,
    identity,
    prompt,
    executionId,
    executionLimits,
  }: ChatTurnProduceArgs<void>): Promise<ChatTurnRouteProducer> => {
    const box = await ensureForegroundWorkspaceSandbox(env, shell, {
      workspaceId: identity.tenantId,
      userId: identity.userId,
    })
    const model = body.model ?? env.MODEL_NAME ?? config.model.default
    return createSandboxChatProducer({
      model,
      // Reactive model failover, ON by default: when `model`'s upstream is
      // dead (quota wall, 502, provider outage), the turn moves to the next
      // model in `config.model.fallbacks` BEFORE any client-visible byte.
      // Never silent: the persisted row and billing receipt name the model
      // that actually served, and the transcript gets a visible notice.
      // Opt out with `modelFailover: false` (or empty `fallbacks`).
      fallbackModels: config.model.fallbacks,
      openEvents: ({ model: attemptModel, attempt, signal }) =>
        streamSandboxPrompt(shell, box, normalizeChatPromptForSandbox(prompt), {
          sessionId: identity.sessionId,
          // A failover attempt is a NEW dispatch, not a reconnect to the dead
          // one — it needs its own execution identity or the platform would
          // resume the failed execution instead of starting a fresh run.
          executionId: attempt === 1 ? executionId : `${executionId}-f${attempt}`,
          model: attemptModel,
          signal,
          // A zero reasoning allowance maps to the profile's supported
          // no-reasoning control. Positive limits use token ceilings below.
          effort: executionLimits?.maxReasoningTokens === 0
            ? 'none'
            : (body.effort ?? config.model.effort),
          ...(executionLimits?.maxOutputTokens
            ? { maxOutputTokens: executionLimits.maxOutputTokens }
            : {}),
          ...(executionLimits?.maxReasoningTokens
            ? { maxReasoningTokens: executionLimits.maxReasoningTokens }
            : {}),
          ...(executionLimits?.maxOutputTokens !== undefined
            && executionLimits.maxReasoningTokens !== undefined
            ? {
                maxTotalOutputTokens:
                  executionLimits.maxOutputTokens + executionLimits.maxReasoningTokens,
              }
            : {}),
          harness: config.harness,
          systemPrompt: config.systemPrompt,
          // Durable by default: the run keeps executing server-side if the operator
          // refreshes, closes the tab, or the Worker restarts mid-turn. On reopen
          // the client re-attaches via GET /api/chat/running → /api/chat/replay, so
          // nothing is lost. Drop this only for a run that should stop when the tab
          // closes (e.g. a throwaway preview).
          detach: true,
          interactions: config.interactions,
        }),
    })
  }
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
): Promise<SidecarInteractionsConnection | null> {
  if (!env.SANDBOX_API_KEY?.trim() || !env.SANDBOX_GATEWAY_URL?.trim()) return null
  const shell = createSandboxShell(env)
  const box = await ensureForegroundWorkspaceSandbox(env, shell, {
    workspaceId: scope.workspaceId,
    userId: scope.userId,
  })
  const connection = box.connection
  if (!connection?.runtimeUrl) return null
  return {
    runtimeUrl: connection.runtimeUrl,
    ...(connection.authToken ? { authToken: connection.authToken } : {}),
    sessionId: scope.threadId,
  }
}
