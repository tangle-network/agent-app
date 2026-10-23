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
  startHybridBox,
  turnCarriesFiles,
  type ChatTurnAfterAuthorizeArgs,
  type ChatTurnProduceArgs,
  type ChatTurnRouteProducer,
  type ChatTurnHybridConfiguration,
  type SandboxUploadSink,
} from '@tangle-network/agent-app/chat-routes'
import type { SidecarInteractionsConnection } from '@tangle-network/agent-app/interactions'
import {
  createD1PrewarmClaimStore,
  createSandboxPrewarmer,
  createWorkspacePrewarmRoute,
  ensureWorkspaceSandbox,
  peekWorkspaceSandbox,
  runForegroundSandboxSingleFlight,
  sandboxPromptRunner,
  streamSandboxPrompt,
  type SandboxRuntimeConfig,
} from '@tangle-network/agent-app/sandbox'
import type { TurnTrace } from '@tangle-network/agent-app/turn-trace'
import type { SandboxInstance } from '@tangle-network/sandbox'
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
    trace,
  }: ChatTurnProduceArgs<void>): Promise<ChatTurnRouteProducer> => {
    const box = await ensureForegroundWorkspaceSandbox(env, shell, {
      workspaceId: identity.tenantId,
      userId: identity.userId,
    }, trace)
    const model = body.model ?? env.MODEL_NAME ?? config.model.default
    return createSandboxChatProducer({
      model,
      errorNotice: true,
      // A detached dispatch can keep doing hidden work after transport loss.
      // Do not turn observation failure into another model dispatch.
      modelFailover: false,
      openEvents: ({ model: attemptModel, signal }) => {
        return streamSandboxPrompt(shell, box, normalizeChatPromptForSandbox(prompt), {
          sessionId: identity.sessionId,
          executionId,
          turnId: executionId,
          model: attemptModel,
          signal,
          ...(trace ? { trace } : {}),
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
          // Gateway output is inclusive of reasoning. Keep the same total
          // ceiling even when a separate reasoning subset was authorized.
          ...(executionLimits?.maxOutputTokens !== undefined
            ? { maxTotalOutputTokens: executionLimits.maxOutputTokens }
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
        })
      },
    })
  }
}

/** The Router's OpenAI-compatible base URL (`…/v1`), or undefined for the platform default. */
function routerBaseUrl(env: AppEnv): string | undefined {
  const url = env.TANGLE_ROUTER_URL?.trim().replace(/\/+$/, '')
  if (!url) return undefined
  return url.endsWith('/v1') ? url : `${url}/v1`
}

/**
 * The default chat lane: the model answers first through the Tangle Router and
 * escalates to the workspace box through one `sandbox_run` call when the work
 * needs a computer (`createHybridTurnProducer`). The box starts at admission
 * when the ask needs it (`afterAuthorize`), or when the model names
 * `sandbox_run`, and that one start serves the call. A turn that carries files,
 * or a deployment with no Router key, runs on the sandbox lane, where the
 * files are.
 *
 * Pass `afterAuthorize` and `produce` to `createChatTurnRoutes`.
 */
export function createHybridLane(env: AppEnv) {
  const shell = createSandboxShell(env)
  const sandboxProduce = createSandboxProduce(env)
  // The box a turn's admission started, by thread; `produce` takes it in the same request.
  const started = new Map<string, Promise<SandboxInstance>>()
  const acquire = (scope: { workspaceId: string; userId: string }, trace?: TurnTrace) =>
    ensureForegroundWorkspaceSandbox(env, shell, scope, trace)

  return {
    afterAuthorize({ body, tenantId, userId, threadId, trace }: ChatTurnAfterAuthorizeArgs<void>) {
      if (!env.TANGLE_API_KEY?.trim()) return undefined
      const start = startHybridBox(body, () => acquire({ workspaceId: tenantId, userId }, trace))
      if (!start) return undefined
      started.set(threadId, start)
      // A turn that ends before `produce` leaves the box to idle out.
      return () => { started.delete(threadId) }
    },
    produce: {
      when: ({ prompt }: ChatTurnProduceArgs<void>) => Boolean(env.TANGLE_API_KEY?.trim()) && !turnCarriesFiles(prompt),
      router(args: ChatTurnProduceArgs<void>): ChatTurnHybridConfiguration {
        const { body, identity, trace } = args
        const box = started.get(identity.sessionId)
        started.delete(identity.sessionId)
        const apiKey = env.TANGLE_API_KEY?.trim()
        if (!apiKey) throw new Error('Router credentials are not configured')
        const model = body.model ?? env.MODEL_NAME ?? config.model.default
        const baseUrl = routerBaseUrl(env)
        const scope = { workspaceId: identity.tenantId, userId: identity.userId }
        return {
          apiKey,
          model,
          ...(baseUrl ? { baseUrl } : {}),
          systemPrompt: { profile: { prompt: { systemPrompt: config.systemPrompt } } },
          box: {
            acquire: () => acquire(scope, trace),
            ...(box ? { started: box } : {}),
            // The box agent keeps its own session per thread, so a sandbox-lane turn on the same thread never collides with it.
            runTask: sandboxPromptRunner(shell, { model, harness: config.harness, sessionId: `sandbox-run-${identity.sessionId}` }),
          },
        }
      },
      sandbox(args: ChatTurnProduceArgs<void>) {
        started.delete(args.identity.sessionId)
        return sandboxProduce(args)
      },
    },
  }
}

/**
 * Warm the open workspace's box (`POST /api/chat/prewarm`): the shared route
 * behind `AgentWorkspaceLayout`'s `prewarm`. The default lane answers on the
 * Router and starts the box only when a turn needs it, so with a Router key a
 * warm on open is declined and the speculator starts the box instead.
 */
export function createPrewarmRoute(env: AppEnv, requireUserId: (request: Request) => Promise<string | null>) {
  return createWorkspacePrewarmRoute<void>({
    authorize: async ({ request }) => {
      const userId = await requireUserId(request)
      if (!userId) return { status: 'denied', response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
      if (env.TANGLE_API_KEY?.trim()) return { status: 'declined', reason: 'router_lane' }
      if (!env.SANDBOX_API_KEY?.trim() || !env.SANDBOX_GATEWAY_URL?.trim()) return { status: 'declined', reason: 'no_sandbox' }
      const scope = { workspaceId: userId, userId }
      return {
        status: 'allowed',
        key: scope.workspaceId,
        warm: async () => {
          const prewarmer = createSandboxPrewarmer(createSandboxShell(env), {
            claim: createD1PrewarmClaimStore(env.DB),
            mode: 'create-or-resume',
          })
          const decision = await prewarmer.prewarm({ ...scope, harness: config.harness })
          await decision.completion
          return { outcome: decision.outcome }
        },
      }
    },
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
