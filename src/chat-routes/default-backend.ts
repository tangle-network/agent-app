/** The template's backend assembly. Products supply policy; routes own lane selection. */
import type { SandboxInstance } from '@tangle-network/sandbox'
import type { Harness } from '../harness/index'
import { createD1PrewarmClaimStore } from '../sandbox/prewarm-claim-d1'
import { runForegroundSandboxSingleFlight } from '../sandbox/foreground-single-flight'
import { ensureWorkspaceSandbox, peekWorkspaceSandbox, streamSandboxPrompt } from '../sandbox/index'
import type { SandboxRuntimeConfig } from '../sandbox/configuration'
import { sandboxPromptExecutionOptions, type StreamSandboxPromptOptions } from '../sandbox/prompt-options'
import type { ChatTurnStoreBindings } from './route-storage'
import { turnCarriesFiles } from './hybrid-producer'
import { normalizeChatPromptForSandbox } from './dispatch-parts'
import { assertPolicy, type ModelPolicy } from '../policy-filters/index'
import type { ChatTurnProduceArgs, ChatTurnHybridConfiguration } from './turn-route-contracts'
import type { RouterTurnTool } from '../runtime/router-turn'
import type { RouterTurnKey } from './router-producer'
import type { ComputerVault } from '../sandbox/computer-files'
import type { Outcome } from '../sandbox/outcome'

/** Worker bindings are explicit; no ambient deployment credentials replace product policy. */
export interface ChatTurnEnvironment {
  DB?: ChatTurnStoreBindings['db']
  TURN_STREAM?: ChatTurnStoreBindings['lock']['namespace']
  TURN_STREAM_DO?: ChatTurnStoreBindings['lock']['namespace']
  TURN_STREAM_AUTH_SECRET?: string
  D1_REGION?: ChatTurnStoreBindings['region']
  TANGLE_API_KEY?: string
  TANGLE_ROUTER_URL?: string
  MODEL_NAME?: string
  SANDBOX_API_KEY?: string
  SANDBOX_GATEWAY_URL?: string
}

/** Domain data for the default lane, instead of constructing producers or admission hooks. */
export interface ChatTurnDefaultBackend<TContext = unknown, TResource = unknown> {
  model?: string
  systemPrompt?: string
  harness?: Harness
  effort?: StreamSandboxPromptOptions['effort']
  interactions?: StreamSandboxPromptOptions['interactions']
  /** Existing product provisioning, credentials, profiles and egress policy remain authoritative. */
  shell?: SandboxRuntimeConfig
  /** Explicitly keep every turn on the sandbox lane. */
  router?: false
  /** Who pays for the Router model call: the turn's key, or a per-turn lease (`createDelegatedTurnKeys`) the
   *  producer revokes when the turn settles. Default `TANGLE_API_KEY`. Started before the turn lock, like the call. */
  funding?(args: ChatTurnProduceArgs<TContext, TResource>): RouterTurnKey | Promise<RouterTurnKey>
  /** The product's in-process tools for the Router model; `sandbox_run` is added after them. */
  tools?(args: ChatTurnProduceArgs<TContext, TResource>): RouterTurnTool[] | Promise<RouterTurnTool[]>
  /** What the computer step does beyond running the task: copy its files into the product's Vault, and run a model
   *  the box key allows (`readSandboxRouterModels` with the payer's key). */
  computer?: {
    files?(args: ChatTurnProduceArgs<TContext, TResource>): ComputerVault | undefined
    allowedModels?(args: ChatTurnProduceArgs<TContext, TResource>, signal: AbortSignal): Promise<Outcome<readonly string[] | null>>
  }
}

export function defaultChatShell(projectId: string, env: ChatTurnEnvironment, config: ChatTurnDefaultBackend): SandboxRuntimeConfig {
  return config.shell ?? {
    credentials: () => env.SANDBOX_API_KEY?.trim() && env.SANDBOX_GATEWAY_URL?.trim()
      ? { apiKey: env.SANDBOX_API_KEY.trim(), baseUrl: env.SANDBOX_GATEWAY_URL.trim() } : null,
    name: workspaceId => `${projectId}-${workspaceId}`.slice(0, 63),
    metadata: harness => ({ app: projectId, harness }),
    connectedIntegrationIds: async () => [], env: async () => ({}), files: async () => [], secrets: async () => [],
    profile: ({ systemPrompt, extraMcp }) => ({ name: projectId,
      prompt: { systemPrompt: systemPrompt ?? config.systemPrompt ?? '' },
      ...(extraMcp && Object.keys(extraMcp).length ? { mcp: extraMcp } : {}),
    }),
    provider: { apiKey: env.TANGLE_API_KEY, routerBaseUrl: env.TANGLE_ROUTER_URL,
      modelName: env.MODEL_NAME, defaultModel: config.model },
  }
}

export function createDefaultChatBackend<TContext, TResource>(projectId: string, env: ChatTurnEnvironment, config: ChatTurnDefaultBackend<TContext, TResource>, bindings?: ChatTurnStoreBindings, modelPolicy?: ModelPolicy) {
  const shell = defaultChatShell(projectId, env, config)
  const harness = config.harness ?? 'opencode'
  const acquire = (args: ChatTurnProduceArgs<TContext, TResource>): Promise<SandboxInstance> => {
    const scope = { workspaceId: args.identity.tenantId, userId: args.identity.userId }
    if (!bindings) throw new Error('Default sandbox execution requires durable D1 claim bindings')
    return runForegroundSandboxSingleFlight({ claim: createD1PrewarmClaimStore(bindings.db), workspaceId: scope.workspaceId,
      trace: args.trace, harness, provision: () => ensureWorkspaceSandbox(shell, { ...scope, harness, trace: args.trace }),
      peek: () => peekWorkspaceSandbox(shell, scope), adopt: ({ box }) => box })
  }
  const modelFor = (args: ChatTurnProduceArgs<TContext, TResource>) => {
    const model = args.body.model ?? env.MODEL_NAME ?? config.model
    if (!model?.trim()) throw new Error('Default chat requires MODEL_NAME or produce.model')
    return model
  }
  const runOptions = (args: ChatTurnProduceArgs<TContext, TResource>) => ({
    model: modelFor(args), harness, detach: true as const,
    systemPrompt: config.systemPrompt, interactions: config.interactions,
    ...sandboxPromptExecutionOptions(args.executionLimits, args.body.effort ?? config.effort),
  })
  const promptOptions = (args: ChatTurnProduceArgs<TContext, TResource>): StreamSandboxPromptOptions => ({
    ...runOptions(args), sessionId: args.identity.sessionId, executionId: args.executionId,
    turnId: args.executionId, trace: args.trace, signal: args.admissionSignal,
  })
  return {
    when: (args: ChatTurnProduceArgs<TContext, TResource>) => config.router !== false
      && (Boolean(config.funding) || Boolean(env.TANGLE_API_KEY?.trim())) && !turnCarriesFiles(args.prompt)
      // The Router can cap total output but not a separate reasoning subset.
      && !(args.executionLimits?.maxReasoningTokens),
    async router(args: ChatTurnProduceArgs<TContext, TResource>): Promise<ChatTurnHybridConfiguration> {
      const model = modelFor(args)
      if (modelPolicy) await assertPolicy({ kind: 'model', id: model, ...modelPolicy })
      const base = env.TANGLE_ROUTER_URL?.trim().replace(/\/+$/, '')
      const funding = config.funding
      const tools = config.tools ? await config.tools(args) : undefined
      const files = config.computer?.files?.(args)
      const allowedModels = config.computer?.allowedModels
      return { apiKey: funding ? Promise.resolve().then(() => funding(args)) : env.TANGLE_API_KEY!.trim(), model,
        ...(tools?.length ? { tools } : {}),
        reasoningEffort: args.executionLimits?.maxReasoningTokens === 0 ? 'none' : args.body.effort ?? config.effort,
        ...(args.executionLimits?.maxOutputTokens !== undefined ? {
          maxTokens: args.executionLimits.maxOutputTokens, maxCompletionTokens: args.executionLimits.maxOutputTokens,
        } : {}),
        ...(base ? { baseUrl: base.endsWith('/v1') ? base : `${base}/v1` } : {}),
        systemPrompt: { profile: shell.profile({ systemPrompt: config.systemPrompt, harness }) },
        box: { acquire: () => acquire(args), computer: {
          shell, prompt: runOptions(args), parentExecutionId: args.executionId,
          session: { id: `sandbox-run-${args.identity.sessionId}` },
          ...(allowedModels ? { models: { preferred: [model], allowed: (signal: AbortSignal) => allowedModels(args, signal) } } : {}),
          ...(files ? { files } : {}),
        } },
      }
    },
    sandbox: async (args: ChatTurnProduceArgs<TContext, TResource>) => {
      const model = modelFor(args)
      if (modelPolicy) await assertPolicy({ kind: 'model', id: model, ...modelPolicy })
      // Resolve the box before the producer, but dispatch only when the route pulls
      // openEvents: producer construction failure can never leave native work running.
      const box = await acquire(args)
      return { model, modelPolicy, modelFailover: false as const, errorNotice: true,
        openEvents: ({ model, signal }: { model: string; signal: AbortSignal }) => streamSandboxPrompt(shell, box,
          normalizeChatPromptForSandbox(args.prompt), { ...promptOptions(args), model, signal }),
      }
    },
  }
}
