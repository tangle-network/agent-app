/**
 * A turn addressed to several agents runs them one after another, in mention
 * order, as one producer: the route sees one stream, persists one assistant
 * row, and the row's parts carry a `speaker` part before each responder's
 * parts so a transcript can draw each answer under its author. The live
 * stream carries the same boundary as a `speaker` event, so a viewer can
 * open a new block as each agent starts.
 *
 * Sequential on purpose: one live block at a time is what a reader can follow,
 * the order is the order typed, and the box runs one session at a time per
 * turn. Running responders concurrently is an internal change here, not a
 * change to what is stored.
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
  const producers: Array<{ agent: ChatTurnAgentTarget; producer: ChatTurnRouteProducer }> = []
  const cleanups: Array<Promise<void>> = []
  const stream = (async function* (): AsyncGenerator<ChatRouteEvent> {
    for (const agent of agents) {
      if (args.admissionSignal?.aborted) return
      // Each responder is produced when its turn comes, so the second agent's
      // profile and prompt are built after the first has answered.
      const producer = await produce({ ...args, agent })
      producers.push({ agent, producer })
      if (producer.cleanup) cleanups.push(producer.cleanup)
      yield { type: SPEAKER_EVENT, id: agent.id, name: agent.name, handle: agent.handle } as ChatRouteEvent
      for await (const event of producer.stream) yield event
    }
  })()
  const partsOf = (entry: { agent: ChatTurnAgentTarget; producer: ChatTurnRouteProducer }, read: 'assistantParts' | 'draftParts') => {
    const own = entry.producer[read]?.()
    const text = entry.producer.finalText()
    const parts = own ?? (text ? [{ type: 'text', text }] : [])
    return [speakerPart(entry.agent), ...parts]
  }
  const last = () => producers[producers.length - 1]?.producer
  return {
    stream,
    finalText: () => producers.map(({ producer }) => producer.finalText()).filter((text) => text.trim() !== '').join('\n\n'),
    assistantParts: () => producers.flatMap((entry) => partsOf(entry, 'assistantParts')),
    draftParts: () => producers.flatMap((entry) => partsOf(entry, 'draftParts')),
    usage: () => producers.reduce<ChatTurnUsage>((sum, { producer }) => {
      const usage = producer.usage?.() ?? {}
      for (const [key, value] of Object.entries(usage)) {
        if (typeof value === 'number') (sum as Record<string, number>)[key] = ((sum as Record<string, number>)[key] ?? 0) + value
      }
      return sum
    }, {}),
    terminalObserved: () => producers.every(({ producer }) => producer.terminalObserved?.() ?? true),
    get model() { return last()?.model },
    modelFailover: () => last()?.modelFailover?.() as ReturnType<NonNullable<ChatTurnRouteProducer['modelFailover']>>,
    modelAttribution: () => last()?.modelAttribution?.() as ReturnType<NonNullable<ChatTurnRouteProducer['modelAttribution']>>,
    cleanup: (async () => { await Promise.all(cleanups) })(),
  }
}
