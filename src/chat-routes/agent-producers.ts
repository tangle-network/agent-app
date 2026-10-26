/**
 * A turn addressed to several agents runs them at the same time, each as its
 * own producer with the same thread history, and presents them one after
 * another in the order the mentions were typed: the route sees one stream,
 * persists one assistant row, and the row's parts carry a `speaker` part
 * before each responder's parts so a transcript can draw each answer under
 * its author. The live stream carries the same boundary as a `speaker`
 * event, so a viewer opens a new block as each agent's answer arrives.
 *
 * Parallel on purpose: the agents are addressed, not chained, so each answers
 * independently and none waits on another. Ordered presentation on purpose:
 * one live block at a time is what a reader can follow, and the stored order
 * is the order typed, so the transcript rereads the same way every time.
 */
import type { ChatTurnIdentity } from '@tangle-network/agent-runtime/durable'
import type { TurnTrace } from '../turn-trace/recorder'
import { errorResponse } from './turn-admission'
import type { ChatRouteEvent, ChatTurnAgentsOptions, ChatTurnAgentTarget, ChatTurnProduceArgs, ChatTurnRouteProducer, ChatTurnUsage } from './turn-route-contracts'
import { agentMentionsOf, ChatTurnInputError, type ChatMention } from './wire'

/**
 * Name a turn's responders from its agent mentions, before any lock, row or
 * model call: the product's resolver maps mentioned ids to the profiles they
 * run as, and a mention it does not return is refused. The thread's binding
 * does not move. Returns the response to send on refusal, otherwise the
 * produce args carrying `agents` in mention order (unchanged when none).
 */
export async function addressAgents<TContext, TResource>(input: {
  options: { agents?: ChatTurnAgentsOptions<TContext> }
  mentions: readonly ChatMention[]
  identity: ChatTurnIdentity
  context: TContext
  produceArgs: ChatTurnProduceArgs<TContext, TResource>
  trace: TurnTrace
}): Promise<Response | ChatTurnProduceArgs<TContext, TResource>> {
  const addressed = agentMentionsOf(input.mentions)
  if (addressed.length === 0) return input.produceArgs
  const { agents } = input.options
  if (!agents) {
    return errorResponse(new ChatTurnInputError('This chat does not address agents by mention', 400, 'agents_unsupported'))
  }
  const targets = await input.trace.measure('admission.agents', 'admission', () =>
    agents.resolve({ identity: input.identity, context: input.context, mentions: addressed }))
  const byId = new Map(targets.map((target) => [target.id, target]))
  const unknown = addressed.find((mention) => !byId.has(mention.agentId))
  if (unknown) return errorResponse(new ChatTurnInputError(`Unknown agent @${unknown.handle}`, 400, 'unknown_agent'))
  return { ...input.produceArgs, agents: addressed.map((mention) => byId.get(mention.agentId)!) }
}

/** The event a viewer receives when the next responder starts. */
export const SPEAKER_EVENT = 'speaker'

export function speakerPart(agent: ChatTurnAgentTarget): Record<string, unknown> {
  return { type: 'speaker', id: agent.id, name: agent.name, handle: agent.handle }
}

export async function composeAgentProducers<TContext, TResource>(
  args: ChatTurnProduceArgs<TContext, TResource>,
  produce: (final: ChatTurnProduceArgs<TContext, TResource>) => ChatTurnRouteProducer | Promise<ChatTurnRouteProducer>,
): Promise<ChatTurnRouteProducer> {
  const agents = args.agents ?? []
  if (agents.length === 0) throw new Error('composeAgentProducers needs at least one responder')
  const producers: Array<ChatTurnRouteProducer | undefined> = agents.map(() => undefined)
  const cleanups: Array<Promise<void>> = []
  // One slot per responder: its events as they arrive, drained eagerly so every
  // producer runs now, and read by the composite stream in mention order.
  const slots = agents.map(() => ({ queue: [] as ChatRouteEvent[], done: false, error: undefined as unknown, waiters: [] as Array<() => void> }))
  const notify = (slot: (typeof slots)[number]) => { for (const wake of slot.waiters.splice(0)) wake() }
  agents.forEach((agent, index) => {
    const slot = slots[index]!
    void (async () => {
      try {
        // Each responder runs under its own execution id, so two native sessions
        // started for one turn never share a key; the route keeps the turn's.
        const producer = await produce({ ...args, agent, executionId: `${args.executionId}-${index + 1}` })
        producers[index] = producer
        if (producer.cleanup) cleanups.push(producer.cleanup)
        for await (const event of producer.stream) {
          slot.queue.push(event)
          notify(slot)
        }
      } catch (error) {
        slot.error = error
      } finally {
        slot.done = true
        notify(slot)
      }
    })()
  })
  const stream = (async function* (): AsyncGenerator<ChatRouteEvent> {
    for (const [index, agent] of agents.entries()) {
      if (args.admissionSignal?.aborted) return
      yield { type: SPEAKER_EVENT, id: agent.id, name: agent.name, handle: agent.handle } as ChatRouteEvent
      const slot = slots[index]!
      for (;;) {
        if (slot.queue.length > 0) { yield slot.queue.shift()!; continue }
        if (slot.done) { if (slot.error !== undefined) throw slot.error; break }
        // Register before re-checking, so an event pushed between the check and the wait is never missed.
        await new Promise<void>((wake) => { slot.waiters.push(wake); if (slot.queue.length > 0 || slot.done) notify(slot) })
      }
    }
  })()
  const entries = () => agents.flatMap((agent, index) => (producers[index] ? [{ agent, producer: producers[index]! }] : []))
  const partsOf = (entry: { agent: ChatTurnAgentTarget; producer: ChatTurnRouteProducer }, read: 'assistantParts' | 'draftParts') => {
    const own = entry.producer[read]?.()
    const text = entry.producer.finalText()
    const parts = own ?? (text ? [{ type: 'text', text }] : [])
    return [speakerPart(entry.agent), ...parts]
  }
  const last = () => entries().at(-1)?.producer
  return {
    stream,
    finalText: () => entries().map(({ producer }) => producer.finalText()).filter((text) => text.trim() !== '').join('\n\n'),
    assistantParts: () => entries().flatMap((entry) => partsOf(entry, 'assistantParts')),
    draftParts: () => entries().flatMap((entry) => partsOf(entry, 'draftParts')),
    usage: () => entries().reduce<ChatTurnUsage>((sum, { producer }) => {
      const usage = producer.usage?.() ?? {}
      for (const [key, value] of Object.entries(usage)) {
        if (typeof value === 'number') (sum as Record<string, number>)[key] = ((sum as Record<string, number>)[key] ?? 0) + value
      }
      return sum
    }, {}),
    terminalObserved: () => entries().every(({ producer }) => producer.terminalObserved?.() ?? true),
    get model() { return last()?.model },
    modelFailover: () => last()?.modelFailover?.() as ReturnType<NonNullable<ChatTurnRouteProducer['modelFailover']>>,
    modelAttribution: () => last()?.modelAttribution?.() as ReturnType<NonNullable<ChatTurnRouteProducer['modelAttribution']>>,
    cleanup: (async () => { await Promise.all(cleanups) })(),
  }
}
