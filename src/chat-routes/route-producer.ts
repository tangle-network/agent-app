/** Bind backend configuration to this route's identity, trace and admission. */
import { createHybridTurnProducer, routerTurnHistory, turnPromptText } from './hybrid-producer'
import { createRouterTurnProducer } from './router-producer'
import { createSandboxChatProducer } from './sandbox-producer'
import type { ChatTurnProduceArgs, ChatTurnRouteProducer, ChatTurnRouterBackend, ChatTurnSandboxBackend } from './turn-route-contracts'

function isProducer(value: ChatTurnRouterBackend | ChatTurnSandboxBackend): value is ChatTurnRouteProducer {
  return 'stream' in value && typeof value.stream === 'object' && value.stream !== null && Symbol.asyncIterator in value.stream
}

export function routerRouteProducer<TContext, TResource>(value: ChatTurnRouterBackend, args: ChatTurnProduceArgs<TContext, TResource>): ChatTurnRouteProducer {
  if (isProducer(value)) return value
  const options = {
    ...value,
    userMessage: value.userMessage ?? turnPromptText(args.prompt),
    history: value.history ?? routerTurnHistory(args.priorMessages),
    trace: args.trace,
    traceId: args.trace?.traceId,
    signal: args.admissionSignal,
    // Domain fences may wait for a certified profile or per-turn resource.
    // They can only add a requirement; they never replace route admission.
    admitted: Promise.all([args.admitted, value.admitted]),
  }
  if (!('box' in value)) return createRouterTurnProducer(options)
  // A repeated call of the same turn's tool call is the same computer step, whatever the trace.
  const computer = value.box.computer && { parentExecutionId: args.executionId, ...value.box.computer }
  return createHybridTurnProducer({ ...options, box: { ...value.box, ...(computer ? { computer } : {}) } })
}

export function sandboxRouteProducer<TContext, TResource>(value: ChatTurnSandboxBackend, args: ChatTurnProduceArgs<TContext, TResource>): ChatTurnRouteProducer {
  if (isProducer(value)) return value
  const openEvents = value.openEvents
  return createSandboxChatProducer({ ...value, ...(openEvents && args.admissionSignal ? {
    openEvents: input => openEvents({ ...input, signal: AbortSignal.any([input.signal, args.admissionSignal!]) }),
  } : {}) })
}
