/** The template's backend assembly. Products supply policy; routes own lane selection. */
import type { SandboxInstance } from '@tangle-network/sandbox'
import type { Harness } from '../harness/index'
import { createD1PrewarmClaimStore } from '../sandbox/prewarm-claim-d1'
import { createSandboxPrewarmer } from '../sandbox/prewarm'
import { runForegroundSandboxSingleFlight } from '../sandbox/foreground-single-flight'
import { ensureWorkspaceSandbox, peekWorkspaceSandbox, streamSandboxPrompt } from '../sandbox/index'
import type { SandboxRuntimeConfig } from '../sandbox/configuration'
import type { ProviderResolutionConfig } from '../sandbox/model'
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

/** The workspace and model authorized for this execution. Its shell owns the box identity,
 * credential references and Sandbox payer. */
export interface ChatTurnSandboxBinding {
  shell: SandboxRuntimeConfig
  harness: Harness
  model: string
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
  /** Resolve the authenticated turn's saved connection before acquiring its box. A refused
   * connection throws. Returning null selects the app's ordinary sandbox. An app using this
   * callback resolves every message on the sandbox lane, including messages with no model override. */
  resolveSandboxBinding?: (args: ChatTurnProduceArgs<TContext, TResource>) => Promise<ChatTurnSandboxBinding | null>
  /** A model's own provider, keyed by the exact model id a turn carries; any other model runs on the shell's. The box is
   *  created on the shell's provider, and only an api-mode keyless provider there gets the box its own Router key, so a
   *  pool of an OpenCode free model and a Router model puts the Router member on the shell and the free one here.
   *  A function is resolved for each turn, so a turn can carry its own key, e.g. a child of the caller's linked key. */
  providers?: Readonly<Record<string, ProviderResolutionConfig
    | ((args: ChatTurnProduceArgs<TContext, TResource>) => ProviderResolutionConfig | Promise<ProviderResolutionConfig>)>>
  /** Explicitly keep every turn on the sandbox lane. */
  router?: false
  /** A durable owner for a sandbox turn, so its answer outlives the request (a closed tab, a lost connection): called
   *  after the box is resolved and the turn lock is held, before the prompt is dispatched, with the session and execution the dispatch uses.
   *  It registers the owner (preset-cloudflare `createNativeCompletionOwner`, as creative-agent does) and then calls
   *  `args.handoffCompletion()`. A throw fails the turn before any native work starts. */
  completionOwner?(input: { args: ChatTurnProduceArgs<TContext, TResource>; box: SandboxInstance; sessionId: string; executionId: string }): Promise<void>
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

export function defaultChatShell<TContext, TResource>(projectId: string, env: ChatTurnEnvironment, config: ChatTurnDefaultBackend<TContext, TResource>): SandboxRuntimeConfig {
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
  const acquire = (args: ChatTurnProduceArgs<TContext, TResource>, binding: ChatTurnSandboxBinding): Promise<SandboxInstance> => {
    const scope = { workspaceId: args.identity.tenantId, userId: args.identity.userId }
    if (!bindings) throw new Error('Default sandbox execution requires durable D1 claim bindings')
    return runForegroundSandboxSingleFlight({ claim: createD1PrewarmClaimStore(bindings.db), workspaceId: scope.workspaceId,
      trace: args.trace, harness: binding.harness,
      provision: () => ensureWorkspaceSandbox(binding.shell, { ...scope, harness: binding.harness, trace: args.trace }),
      peek: () => peekWorkspaceSandbox(binding.shell, scope), adopt: ({ box }) => box })
  }
  const modelFor = (args: ChatTurnProduceArgs<TContext, TResource>) => {
    const model = args.body.model ?? env.MODEL_NAME ?? config.model
    if (!model?.trim()) throw new Error('Default chat requires MODEL_NAME or produce.model')
    return model
  }
  const runOptions = (args: ChatTurnProduceArgs<TContext, TResource>) => ({
    harness, detach: true as const,
    systemPrompt: config.systemPrompt, interactions: config.interactions,
    ...sandboxPromptExecutionOptions(args.executionLimits, args.body.effort ?? config.effort),
  })
  const promptOptions = (args: ChatTurnProduceArgs<TContext, TResource>): StreamSandboxPromptOptions => ({
    ...runOptions(args), sessionId: args.identity.sessionId, executionId: args.executionId,
    turnId: args.executionId, trace: args.trace, signal: args.admissionSignal,
  })
  const warmer = !config.resolveSandboxBinding && bindings && createSandboxPrewarmer(shell, { claim: createD1PrewarmClaimStore(bindings.db), mode: 'create-or-resume', claimTtlSeconds: 45 })
  return {
    prewarm: (scope: { workspaceId: string; userId: string }) => warmer ? warmer.prewarm({ ...scope, harness }).then(warm => warm.completion) : Promise.resolve(),
    when: (args: ChatTurnProduceArgs<TContext, TResource>) => !config.resolveSandboxBinding && config.router !== false
      && (Boolean(config.funding) || Boolean(env.TANGLE_API_KEY?.trim())) && !turnCarriesFiles(args.prompt)
      // The Router can cap total output but not a separate reasoning subset.
      && !(args.executionLimits?.maxReasoningTokens)
      // A model with its own provider (`providers`) runs where that provider does: the sandbox lane.
      && !config.providers?.[args.body.model ?? env.MODEL_NAME ?? config.model ?? ''],
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
        box: { acquire: () => acquire(args, { shell, harness, model }), computer: {
          shell, prompt: { ...runOptions(args), model }, parentExecutionId: args.executionId,
          session: { id: `sandbox-run-${args.identity.sessionId}` },
          ...(allowedModels ? { models: { preferred: [model], allowed: (signal: AbortSignal) => allowedModels(args, signal) } } : {}),
          ...(files ? { files } : {}),
        } },
      }
    },
    sandbox: async (args: ChatTurnProduceArgs<TContext, TResource>) => {
      const connected = await config.resolveSandboxBinding?.(args)
      const binding = connected ?? { shell, harness, model: modelFor(args) }
      const { model } = binding
      if (modelPolicy) await assertPolicy({ kind: 'model', id: model, ...modelPolicy })
      // Resolve the box before the producer, but dispatch only when the route pulls
      // openEvents: producer construction failure can never leave native work running.
      // A per-turn provider resolves here, before the box and the stream: a refused mint fails the producer's
      // construction, which never leaves native work running, so the turn lock is released, not parked.
      const own = connected ? undefined : config.providers?.[model]
      const provider = typeof own === 'function' ? await own(args) : own
      const box = await acquire(args, binding)
      const completionOwner = config.completionOwner
      const dispatch = (signal: AbortSignal) => streamSandboxPrompt(provider ? { ...binding.shell, provider } : binding.shell, box,
        normalizeChatPromptForSandbox(args.prompt), { ...promptOptions(args), model, harness: binding.harness, signal })
      return { model, modelPolicy, modelFailover: false as const, errorNotice: true,
        // The route pulls openEvents only after the turn lock, so the durable owner registers holding it.
        openEvents: ({ signal }: { model: string; signal: AbortSignal }) => completionOwner
          ? (async function* () {
            await completionOwner({ args, box, sessionId: args.identity.sessionId, executionId: args.executionId })
            yield* dispatch(signal)
          })()
          : dispatch(signal),
      }
    },
  }
}
