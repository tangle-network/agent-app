import { profileMaterializationAxes, type AgentProfile } from '@tangle-network/agent-interface'
import { runProtectedRouterTurn, type RouterTurnGrant } from '../runtime/protected-router-turn'
import type { RouterTurnOptions } from '../runtime/router-turn'
import type { McpToolDefinition } from '../tools/mcp-rpc'
import { createSandboxChatProducer } from './sandbox-producer'
import type { ChatRouteEvent, ChatTurnRouteProducer, ChatTurnUsage } from './turn-routes'

export interface ProtectedRuntimeChatOptions {
  profile: AgentProfile
  prompt: string
  priorMessages?: ReadonlyArray<{ role: string; content: string }>
  /** Runtime owns reservation, activation, revocation and authoritative settlement. */
  grant: RouterTurnGrant
  /** Only tools authorized for this execution. Each tool validates its arguments and effects. */
  tools: readonly McpToolDefinition<{ signal: AbortSignal }>[]
  maxToolCalls: number
  signal?: AbortSignal
}

/**
 * The AgentProfile leaves (agent-interface's materialization axes) a protected turn
 * carries. Identity, `harness` (cli-base only) and `metadata` are control fields;
 * `modelMetadata` is accepted only when empty. A leaf outside this set, including one
 * agent-interface adds later, is refused by name before a grant is reserved: running
 * the turn without it would silently drop what the profile asked for.
 */
const PROTECTED_TURN_AXES: ReadonlySet<string> = new Set([
  'name', 'description', 'version', 'tags', 'metadata', 'harness', 'tools',
  'systemPrompt', 'instructions',
  'modelDefault', 'modelProvider', 'modelReasoningEffort', 'modelMaxVisibleOutputTokens',
  'modelMaxTotalOutputTokens', 'modelMetadata',
])

/**
 * The parts of a profile a protected turn applies: its prompt text, its model and
 * reasoning effort, and its completion ceilings. Anything else would change the
 * execution without the grant pricing it, so it is refused by name.
 */
function protectedTurnSettings(profile: AgentProfile, toolNames: ReadonlySet<string>): Pick<RouterTurnOptions,
  'model' | 'systemPrompt' | 'reasoningEffort' | 'maxTokens' | 'maxCompletionTokens'> {
  if (profile.harness && profile.harness !== 'cli-base') throw new Error(`Protected chat runs only the cli-base harness, not ${profile.harness}`)
  if (profile.resources) throw new Error('Protected chat applies prompt text only; run profile resources in the Sandbox lane')
  if (profile.model?.metadata && Object.keys(profile.model.metadata).length > 0) {
    throw new Error('Protected chat does not apply AgentProfile.model.metadata')
  }
  if (profile.model?.maxReasoningTokens !== undefined) throw new Error('Protected chat cannot enforce maxReasoningTokens')
  const unsupported = profileMaterializationAxes(profile).filter(axis => !PROTECTED_TURN_AXES.has(axis))
  if (unsupported.length > 0) {
    throw new Error(`Protected chat does not apply AgentProfile ${unsupported.join(', ')}; run this profile in the Sandbox lane`)
  }
  const declared = profile.model?.default?.trim()
  const provider = profile.model?.provider?.trim()
  const model = declared && provider && declared.startsWith(`${provider}/`) ? declared.slice(provider.length + 1) : declared
  if (!model) throw new Error('Protected chat requires AgentProfile.model.default')
  for (const [name, enabled] of Object.entries(profile.tools ?? {})) {
    if (enabled !== toolNames.has(name)) throw new Error(`Protected tool ${name} does not match AgentProfile.tools`)
  }
  for (const name of toolNames) {
    if (profile.tools?.[name] !== true) throw new Error(`Protected tool ${name} is not enabled by AgentProfile.tools`)
  }
  const { visible, total } = { visible: profile.model?.maxVisibleOutputTokens, total: profile.model?.maxTotalOutputTokens }
  return {
    model,
    systemPrompt: [profile.prompt?.systemPrompt, ...(profile.prompt?.instructions ?? [])]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n'),
    ...(profile.model?.reasoningEffort ? { reasoningEffort: profile.model.reasoningEffort } : {}),
    ...(visible !== undefined ? { maxTokens: visible } : {}),
    ...(total !== undefined ? { maxCompletionTokens: total } : {}),
  }
}

/** The text a model reads for one tool result: the JSON of its value, or the tool's own error. */
function protectedToolResultText(outcome: { ok: true; result: unknown } | { ok: false; message: string }): string {
  if (!outcome.ok) return `error: ${outcome.message}`
  return JSON.stringify(outcome.result) ?? 'null'
}

/**
 * Run a profile as one Router turn under a protected model grant
 * (`runProtectedRouterTurn`), projected through the shared chat projection. The
 * usage is published only from the settled grant.
 */
export function createProtectedRuntimeChatProducer(options: ProtectedRuntimeChatOptions): ChatTurnRouteProducer {
  if (!Number.isSafeInteger(options.maxToolCalls) || options.maxToolCalls < 0) {
    throw new Error('maxToolCalls must be a non-negative integer')
  }
  options = { ...options,
    grant: { ...options.grant, resolve: structuredClone(options.grant.resolve), reserve: structuredClone(options.grant.reserve) },
    tools: options.tools.map(tool => ({ ...tool, inputSchema: structuredClone(tool.inputSchema) })),
    // Chat history rows carry storage fields (id, parts, timestamps). The
    // provider receives exactly role and content; Anthropic rejects extra keys.
    priorMessages: options.priorMessages?.map(({ role, content }) => ({ role, content })),
  }
  const tools = new Map(options.tools.map(tool => [tool.name, tool]))
  if (tools.size !== options.tools.length) throw new Error('Duplicate protected tool name')
  const profile = structuredClone(options.profile)
  let toolCalls = 0
  let usage: ChatTurnUsage = {}
  let started = false
  let model: string | undefined
  let budgetEnforced = false
  let toolTokens: number | undefined
  const controller = new AbortController()
  const pendingTools = new Set<Promise<unknown>>()
  let execution: Promise<void> | undefined
  let reader: ReadableStreamDefaultReader<unknown> | undefined
  let writer: WritableStreamDefaultWriter<unknown> | undefined
  let terminalObserved = false
  let closing: Promise<void> | undefined

  // A local execution owns its completion evidence. A projected result can arrive
  // before cleanup, and Runtime cancellation can finish before a tool's effects.
  function close(reason?: unknown): Promise<void> {
    controller.abort(reason)
    closing ??= (async () => {
      const errors: unknown[] = []
      try { await reader?.cancel() } catch (error) { errors.push(error) }
      try { await execution } catch (error) { errors.push(error) }
      while (pendingTools.size) await Promise.allSettled([...pendingTools])
      try { reader?.releaseLock() } catch (error) { errors.push(error) }
      try { writer?.releaseLock() } catch (error) { errors.push(error) }
      terminalObserved = true
      if (errors.length) throw errors[0]
    })()
    return closing
  }

  async function* events(): AsyncGenerator<unknown> {
    if (started) throw new Error('A protected chat producer can only execute once')
    started = true
    try {
      controller.signal.throwIfAborted()
      options.signal?.throwIfAborted()
      if (Date.now() >= options.grant.deadlineAtMs) throw new Error('Protected execution deadline expired')
      const settings = protectedTurnSettings(profile, new Set(tools.keys()))
      const signal = AbortSignal.any([
        controller.signal, AbortSignal.timeout(Math.max(1, options.grant.deadlineAtMs - Date.now())),
        ...(options.signal ? [options.signal] : []),
      ])
      const channel = new TransformStream<unknown, unknown>()
      const channelWriter = channel.writable.getWriter()
      const channelReader = channel.readable.getReader()
      writer = channelWriter
      reader = channelReader
      const emit = (event: unknown) => channelWriter.write(event)
      // Each model call's text, by segment. The answer is the last segment the model wrote.
      const segments: string[] = []
      execution = runProtectedRouterTurn({
        ...settings,
        grant: options.grant,
        userMessage: options.prompt,
        history: [...(options.priorMessages ?? [])],
        signal,
        // The grant's ledger expects one buffered completion per model call.
        stream: false,
        maxToolCalls: options.maxToolCalls,
        // The grant bounds model calls; the loop must not stop the turn earlier.
        maxToolTurns: options.grant.reserve.limits.maxModelCalls,
        tools: options.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
          run: (args: Record<string, unknown>) => {
            const work = (async () => {
              signal.throwIfAborted()
              toolCalls += 1
              const id = `tool-${toolCalls}`
              await emit({ type: 'tool_call', data: { id, name: tool.name, arguments: args } })
              signal.throwIfAborted()
              try {
                const result = await tool.run(args, { signal })
                await emit({ type: 'tool_result', data: { id, name: tool.name, output: result } })
                return result
              } catch (error) {
                const message = error instanceof Error ? error.message : 'Tool failed'
                await emit({ type: 'tool_result', data: { id, name: tool.name, error: message } })
                throw error
              }
            })()
            pendingTools.add(work)
            void work.then(() => pendingTools.delete(work), () => pendingTools.delete(work))
            return work
          } })),
        toolError: error => ({ code: 'tool_failed', message: error instanceof Error ? error.message : 'Tool failed' }),
        renderToolResult: (_toolName, outcome) => protectedToolResultText(outcome),
        onEvent: event => {
          if (event.type === 'text') segments[event.segment - 1] = (segments[event.segment - 1] ?? '') + event.delta
        },
      }).then(async outcome => {
        if (outcome.settlement) {
          usage = { ...outcome.settlement.usage }
          budgetEnforced = outcome.settlement.budgetEnforced
          model = outcome.settlement.model
          // Tool-result text is billed as input under a grant.
          toolTokens = 0
        }
        // A settlement check fails after the turn answered; the answer stands beside the failure.
        if (!outcome.failure || outcome.failure.code.startsWith('settlement_')) {
          const finalText = segments.filter(Boolean).at(-1) ?? ''
          if (finalText) await emit({ type: 'message.part.updated', data: { part: { id: 'text_delta', type: 'text' }, delta: finalText } })
          await emit({ type: 'result', data: { finalText } })
        }
        if (outcome.failure) throw new Error(outcome.failure.message)
        await channelWriter.close()
      }).catch(error => channelWriter.abort(error))
      for (;;) {
        const next = await channelReader.read()
        if (next.done) break
        yield next.value
      }
      await execution
    } finally {
      await close()
    }
  }

  const producer = createSandboxChatProducer({ events: events(), model: profile.model?.default })
  const stream = (async function* () {
    let failure: ChatRouteEvent | undefined
    for await (const event of producer.stream) {
      if (event.type === 'error') failure = event
      else yield event
    }
    if (usage.inputTokens !== undefined && usage.outputTokens !== undefined && usage.costUsd !== undefined) {
      yield { type: 'usage' as const, usage: { promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens, providerCostUsd: usage.costUsd,
        reasoningTokens: usage.reasoningTokens, toolTokens,
        toolCallCount: toolCalls, budgetEnforced } }
    }
    if (failure) yield failure
  })()
  // AsyncGenerator.return before its first pull never enters the body/finally.
  // Abort and drain independently, also waking a pending read before return queues.
  const end = stream.return.bind(stream)
  const fail = stream.throw.bind(stream)
  stream.return = async value => {
    const stopped = close(new Error('The chat route stopped reading this turn'))
    void stopped.catch(() => undefined)
    try { return await end(value) } finally { await stopped }
  }
  stream.throw = async error => {
    const stopped = close(error)
    void stopped.catch(() => undefined)
    try { return await fail(error) } finally { await stopped }
  }
  return {
    ...producer,
    stream,
    terminalObserved: () => terminalObserved,
    get model() { return model ?? profile.model?.default },
    usage: () => ({ ...usage }),
  }
}
