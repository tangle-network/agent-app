import type { AgentProfile } from '@tangle-network/agent-interface'
import { runProtectedRouterTurn, type RouterTurnGrant } from '../runtime/protected-router-turn'
import type { RouterTurnOptions } from '../runtime/router-turn'
import type { McpToolDefinition } from '../tools/mcp-rpc'
import { createSandboxChatProducer } from './sandbox-producer'
import type { ChatTurnRouteProducer, ChatTurnUsage } from './turn-routes'

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

/** Refuse unsupported profile leaves by name instead of silently dropping them. */
const PROTECTED_TURN_AXES: ReadonlySet<string> = new Set([
  'name', 'description', 'version', 'tags', 'metadata', 'harness', 'tools',
  'systemPrompt', 'instructions',
  'modelDefault', 'modelProvider', 'modelReasoningEffort', 'modelMaxVisibleOutputTokens',
  'modelMaxTotalOutputTokens', 'modelMetadata',
])

function protectedTurnSettings(profile: AgentProfile, toolNames: ReadonlySet<string>,
  profileMaterializationAxes: typeof import('@tangle-network/agent-interface').profileMaterializationAxes): Pick<RouterTurnOptions,
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

/** Project one protected Router turn, publishing usage only from its settled grant. */
export function createProtectedRuntimeChatProducer(options: ProtectedRuntimeChatOptions): ChatTurnRouteProducer {
  if (!Number.isSafeInteger(options.maxToolCalls) || options.maxToolCalls < 0) throw new Error('maxToolCalls must be a non-negative integer')
  options = { ...options,
    grant: { ...options.grant, resolve: structuredClone(options.grant.resolve), reserve: structuredClone(options.grant.reserve) },
    tools: options.tools.map(tool => ({ ...tool, inputSchema: structuredClone(tool.inputSchema) })),
    // Providers reject the storage fields carried by chat history rows.
    priorMessages: options.priorMessages?.map(({ role, content }) => ({ role, content })),
  }
  const tools = new Set(options.tools.map(tool => tool.name))
  if (tools.size !== options.tools.length) throw new Error('Duplicate protected tool name')
  const profile = structuredClone(options.profile)
  let toolCalls = 0
  let usage: ChatTurnUsage = {}
  let started = false
  let model: string | undefined
  const controller = new AbortController()
  const pendingTools = new Set<Promise<unknown>>()
  let execution: Promise<void> | undefined
  let reader: ReadableStreamDefaultReader<unknown> | undefined
  let writer: WritableStreamDefaultWriter<unknown> | undefined
  let terminalObserved = false
  let closing: Promise<void> | undefined

  // Local completion requires drained execution and tool effects, not a projected result.
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
      const signal = AbortSignal.any([
        controller.signal, AbortSignal.timeout(Math.max(1, options.grant.deadlineAtMs - Date.now())),
        ...(options.signal ? [options.signal] : []),
      ])
      const channel = new TransformStream<unknown, unknown>()
      const channelWriter = writer = channel.writable.getWriter()
      reader = channel.readable.getReader()
      const emit = (event: unknown) => channelWriter.write(event)
      // Each model call's text, by segment. The answer is the last segment the model wrote.
      const segments: string[] = []
      // The agent-interface root initializes every schema; only a protected turn needs it, so it loads here.
      const { profileMaterializationAxes } = await import('@tangle-network/agent-interface')
      execution = runProtectedRouterTurn({
        ...protectedTurnSettings(profile, tools, profileMaterializationAxes),
        grant: options.grant,
        userMessage: options.prompt,
        history: [...(options.priorMessages ?? [])],
        signal,
        // The grant's ledger expects one buffered completion per model call.
        stream: false,
        maxToolCalls: options.maxToolCalls,
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
        renderToolResult: (_toolName, outcome) => outcome.ok ? JSON.stringify(outcome.result) ?? 'null' : `error: ${outcome.message}`,
        onEvent: event => {
          if (event.type === 'text') segments[event.segment - 1] = (segments[event.segment - 1] ?? '') + event.delta
        },
      }).then(async outcome => {
        if (outcome.settlement) {
          usage = { ...outcome.settlement.usage }
          model = outcome.settlement.model
          // Tool-result text is billed as input under a grant.
          await emit({ type: 'usage', usage: { promptTokens: usage.inputTokens,
            completionTokens: usage.outputTokens, providerCostUsd: usage.costUsd,
            reasoningTokens: usage.reasoningTokens, toolTokens: 0,
            toolCallCount: toolCalls, budgetEnforced: outcome.settlement.budgetEnforced } })
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
        const next = await reader.read()
        if (next.done) break
        yield next.value
      }
    } finally {
      await close()
    }
  }

  const producer = createSandboxChatProducer({ events: events(), model: profile.model?.default, errorNotice: true })
  const stream = producer.stream
  // Even return/throw before the first pull must abort and drain local work.
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
