import type { AgentProfile } from '@tangle-network/agent-interface'
import { createExecutor, streamAgentTurn } from '@tangle-network/agent-runtime/kernel'
import {
  runProtectedAgentCandidateModelGrant,
  type RunProtectedAgentCandidateModelGrantOptions,
} from '@tangle-network/agent-runtime/candidate-execution'
import { ProtectedModelSettlementError } from '../runtime/protected-model'
import type { McpToolDefinition } from '../tools/mcp-rpc'
import { createSandboxChatProducer } from './sandbox-producer'
import type { ChatRouteEvent, ChatTurnRouteProducer, ChatTurnUsage } from './turn-routes'

export interface ProtectedRuntimeChatOptions {
  profile: AgentProfile
  prompt: string
  priorMessages?: ReadonlyArray<{ role: string; content: string }>
  /** Runtime owns reservation, activation, revocation and authoritative settlement. */
  grant: Omit<RunProtectedAgentCandidateModelGrantOptions<void>, 'execute'>
  /** Only tools authorized for this execution. Each tool validates its arguments and effects. */
  tools: readonly McpToolDefinition<{ signal: AbortSignal }>[]
  maxToolCalls: number
  signal?: AbortSignal
}

/** Run a profile through the protected Router tool executor and the shared chat projection. */
export function createProtectedRuntimeChatProducer(options: ProtectedRuntimeChatOptions): ChatTurnRouteProducer {
  if (!Number.isSafeInteger(options.maxToolCalls) || options.maxToolCalls < 0) {
    throw new Error('maxToolCalls must be a non-negative integer')
  }
  options = { ...options,
    grant: { ...options.grant, resolve: structuredClone(options.grant.resolve), reserve: structuredClone(options.grant.reserve) },
    tools: options.tools.map(tool => ({ ...tool, inputSchema: structuredClone(tool.inputSchema) })),
    priorMessages: options.priorMessages ? structuredClone(options.priorMessages) : undefined,
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

  async function* events(): AsyncGenerator<unknown> {
    if (started) throw new Error('A protected chat producer can only execute once')
    started = true
    const controller = new AbortController()
    options.signal?.throwIfAborted()
    if (Date.now() >= options.grant.deadlineAtMs) throw new Error('Protected execution deadline expired')
    const signal = AbortSignal.any([
      controller.signal, AbortSignal.timeout(Math.max(1, options.grant.deadlineAtMs - Date.now())),
      ...(options.signal ? [options.signal] : []),
    ])
    const channel = new TransformStream<unknown, unknown>()
    const writer = channel.writable.getWriter()
    const reader = channel.readable.getReader()
    const emit = (event: unknown) => writer.write(event)
    const execution = runProtectedAgentCandidateModelGrant({
      ...options.grant,
      port: {
        resolve: input => options.grant.port.resolve(input),
        reserveGrant: input => options.grant.port.reserveGrant(input),
        activateGrant: input => options.grant.port.activateGrant(input),
        // Runtime settles failed executions before rethrowing. Retain that receipt too.
        settleGrant: async input => {
          let auditError: ProtectedModelSettlementError | undefined
          const settlement = await options.grant.port.settleGrant(input).catch(error => {
            if (!(error instanceof ProtectedModelSettlementError)) throw error
            auditError = error
            return error.settlement
          })
          usage = {
            inputTokens: settlement.calls.reduce((sum, call) => sum + call.accountedInputTokens, 0),
            outputTokens: settlement.calls.reduce((sum, call) => sum + call.outputTokens, 0),
            reasoningTokens: settlement.calls.reduce((sum, call) => sum + call.reasoningTokens, 0),
            costUsd: settlement.calls.reduce((sum, call) => sum + call.costUsdNanos, 0) / 1e9,
          }
          budgetEnforced = settlement.usageWithinLimits
          if (!budgetEnforced) throw new Error('Provider settlement exceeded execution limits')
          if (auditError) throw auditError
          return settlement
        },
      },
      execute: async ({ activation, resolved }) => {
        signal.throwIfAborted()
        if (Date.now() >= options.grant.deadlineAtMs) throw new Error('Protected execution deadline expired')
        model = resolved.model
        // Protected Anthropic requests permit only client tools. Their result
        // text is included in input tokens, with no separately billed hosted tools.
        if (resolved.provider !== 'anthropic' || resolved.reasoningEffort !== 'none') {
          throw new Error('Protected chat currently requires Anthropic without reasoning')
        }
        toolTokens = 0
        const apiKey = activation.env.OPENAI_API_KEY
        const baseUrl = activation.env.OPENAI_BASE_URL
        if (!apiKey || !baseUrl) throw new Error('Protected Router activation is missing')
        const factory = createExecutor({
          backend: 'router-tools', routerBaseUrl: baseUrl, routerKey: apiKey,
          tools: options.tools.map(tool => ({ type: 'function' as const,
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
          ...(options.priorMessages?.length ? { initialMessages: options.priorMessages } : {}),
          executeToolCall: async (name, args) => {
            signal.throwIfAborted()
            const tool = tools.get(name)
            if (!tool) throw new Error('Tool is not authorized for this execution')
            if (toolCalls >= options.maxToolCalls) {
              controller.abort(new Error('Execution tool-call limit reached'))
              signal.throwIfAborted()
            }
            toolCalls += 1
            const id = `tool-${toolCalls}`
            await emit({ type: 'tool_call', data: { id, name, arguments: args } })
            try {
              const result = await tool.run(args, { signal })
              await emit({ type: 'tool_result', data: { id, name, output: result } })
              return JSON.stringify(result)
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Tool failed'
              await emit({ type: 'tool_result', data: { id, name, error: message } })
              throw error
            }
          },
        })
        let completed = false
        for await (const event of streamAgentTurn({ kind: 'executor', factory, profile },
          { prompt: options.prompt }, { signal, callId: options.grant.reserve.executionId,
            timeoutMs: Math.max(1, options.grant.deadlineAtMs - Date.now()) })) {
          if (event.type === 'text_delta' || event.type === 'reasoning_delta') {
            await emit({ type: 'message.part.updated', data: {
              part: { id: event.type, type: event.type === 'text_delta' ? 'text' : 'reasoning' }, delta: event.text,
            } })
          }
          if (event.type === 'final') {
            if (event.status !== 'completed') throw new Error(`Protected execution ${event.status}`)
            completed = true
            await emit({ type: 'result', data: { finalText: event.text } })
          }
        }
        if (!completed) throw new Error('Protected execution ended without a terminal result')
      },
    }).then(async () => {
      await writer.close()
    }).catch(error => writer.abort(error))
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        yield next.value
      }
      await execution
    } finally {
      controller.abort()
      await reader.cancel().catch(() => undefined)
      await execution
      reader.releaseLock()
      writer.releaseLock()
    }
  }

  const producer = createSandboxChatProducer({ events: events(), model: profile.model?.default })
  return {
    ...producer,
    stream: (async function* () {
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
    })(),
    get model() { return model ?? profile.model?.default },
    usage: () => ({ ...usage }),
  }
}
