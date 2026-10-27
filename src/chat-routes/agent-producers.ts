/**
 * A turn addressed to several agents runs them at the same time, each as its
 * own producer with the same thread history: the route sees one stream,
 * persists one assistant row, and the row's parts carry a `speaker` part
 * before each responder's parts, in the order the mentions were typed, so a
 * transcript draws each answer under its author.
 *
 * Live, every responder is announced up front with a `speaker` event, in
 * mention order, and then every event carries `speaker` (the responder's
 * agent id) as it arrives, so a viewer draws one live block per responder and
 * sees them answer at the same time. The stored order stays the order typed,
 * so the transcript rereads the same way every time.
 *
 * Parallel and independent on purpose: the agents are addressed, not chained.
 * A responder that fails leaves a notice under its own name and the others
 * still answer; the turn fails only when every responder did.
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

/**
 * What a responder reads as the message: the addressed handles leave the text
 * (they are addressing, not content) and one line names who it answers as and
 * who else is answering, so each agent answers its own part instead of
 * playing every role (both did, GTM production 2026-10-27).
 */
function addressedTurnText(content: string, agent: ChatTurnAgentTarget, agents: readonly ChatTurnAgentTarget[]): string {
  let text = content
  for (const target of agents) {
    text = text.replace(new RegExp(`(^|\\s)@${escapeRegExp(target.handle)}(?=\\s|$|[.,;:!?])`, 'g'), '$1')
  }
  text = text.replace(/[ \t]{2,}/g, ' ').trim()
  const others = agents.filter((target) => target.id !== agent.id).map((target) => `${target.name} (@${target.handle})`)
  const line = others.length === 0
    ? `You answer this message as ${agent.name} (@${agent.handle}).`
    : `You answer this message as ${agent.name} (@${agent.handle}). ${others.join(', ')} ${others.length === 1 ? 'answers' : 'answer'} it separately at the same time; do your part and leave theirs to them.`
  return text ? `${line}\n\n${text}` : line
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The responder's copy of the produce args: its agent, its execution id and the message as it reads it. */
function responderArgs<TContext, TResource>(
  args: ChatTurnProduceArgs<TContext, TResource>, agent: ChatTurnAgentTarget, index: number,
): ChatTurnProduceArgs<TContext, TResource> {
  const agents = args.agents ?? []
  const address = (text: string) => addressedTurnText(text, agent, agents)
  const prompt = typeof args.prompt === 'string'
    ? address(args.prompt)
    : (() => {
        let done = false
        return args.prompt.map((part) => {
          if (done || part.type !== 'text' || typeof (part as { text?: unknown }).text !== 'string') return part
          done = true
          return { ...part, text: address((part as { text: string }).text) }
        })
      })()
  return {
    ...args, agent, executionId: `${args.executionId}-${index + 1}`, prompt,
    body: { ...args.body, ...(typeof args.body.content === 'string' ? { content: address(args.body.content) } : {}) },
  }
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
  // producer runs now; the composite stream reads whichever slot has events.
  const slots = agents.map(() => ({ queue: [] as ChatRouteEvent[], done: false, error: undefined as unknown, failure: undefined as ChatRouteEvent | undefined }))
  const failedNotice = (agent: ChatTurnAgentTarget, message: string): ChatRouteEvent =>
    ({ type: 'notice', id: `speaker-failed:${agent.id}`, noticeKind: 'error', text: `${agent.name} could not answer: ${message}`, speaker: agent.id } as ChatRouteEvent)
  let wake: (() => void) | undefined
  const notify = () => { const w = wake; wake = undefined; w?.() }
  agents.forEach((agent, index) => {
    const slot = slots[index]!
    void (async () => {
      try {
        // Each responder runs under its own execution id, so two native sessions
        // started for one turn never share a key; the route keeps the turn's.
        const producer = await produce(responderArgs(args, agent, index))
        producers[index] = producer
        if (producer.cleanup) cleanups.push(producer.cleanup)
        for await (const event of producer.stream) {
          // A responder's own failure stays its own: the route fails the turn on an
          // `error` event, so it becomes a notice under this speaker unless every
          // responder fails (then the last failure is forwarded at the end).
          if (event.type === 'error' || event.type === 'session.run.failed') {
            slot.failure = { ...event, speaker: agent.id } as ChatRouteEvent
            const message = typeof event.data?.message === 'string' ? event.data.message : 'the run failed'
            slot.queue.push(failedNotice(agent, message))
          } else {
            slot.queue.push({ ...event, speaker: agent.id } as ChatRouteEvent)
          }
          notify()
        }
      } catch (error) {
        slot.error = error
      } finally {
        slot.done = true
        notify()
      }
    })()
  })
  const stream = (async function* (): AsyncGenerator<ChatRouteEvent> {
    for (const agent of agents) {
      yield { type: SPEAKER_EVENT, id: agent.id, name: agent.name, handle: agent.handle } as ChatRouteEvent
    }
    const reported = new Set<number>()
    for (;;) {
      if (args.admissionSignal?.aborted) return
      let yielded = false
      for (const [index, slot] of slots.entries()) {
        while (slot.queue.length > 0) { yield slot.queue.shift()!; yielded = true }
        if (slot.done && slot.error !== undefined && !reported.has(index)) {
          reported.add(index)
          const agent = agents[index]!
          yield failedNotice(agent, slot.error instanceof Error ? slot.error.message : String(slot.error))
          yielded = true
        }
      }
      if (slots.every((slot) => slot.done && slot.queue.length === 0)) {
        // Every responder failed: the turn fails, as a thrown producer error or the last failure event.
        const failed = slots.every((slot) => slot.error !== undefined || slot.failure !== undefined)
        if (failed) {
          const thrown = slots.find((slot) => slot.error !== undefined)?.error
          if (thrown !== undefined) throw thrown
          const failure = slots.map((slot) => slot.failure).find((event) => event !== undefined)
          if (failure) yield failure
        }
        return
      }
      if (!yielded) await new Promise<void>((resolve) => {
        wake = resolve
        if (slots.some((slot) => slot.queue.length > 0 || slot.done)) {
          // Something landed between the scan and the wait; re-scan unless everything scanned is already settled.
          const pending = slots.some((slot) => slot.queue.length > 0 || (slot.done && slot.error !== undefined && !reported.has(slots.indexOf(slot))))
          if (pending || slots.every((slot) => slot.done)) { wake = undefined; resolve() }
        }
      })
    }
  })()
  const entries = () => agents.flatMap((agent, index) => (producers[index] ? [{ agent, producer: producers[index]! }] : []))
  const failureOf = (index: number): string | undefined => {
    const slot = slots[index]!
    if (slot.error !== undefined) return slot.error instanceof Error ? slot.error.message : String(slot.error)
    const data = slot.failure?.data
    return slot.failure ? (typeof data?.message === 'string' ? data.message : 'the run failed') : undefined
  }
  // Every responder keeps its header in the stored row; a failed one carries its notice after whatever it said.
  const partsOf = (index: number, read: 'assistantParts' | 'draftParts') => {
    const agent = agents[index]!
    const producer = producers[index]
    const own = producer?.[read]?.()
    const text = producer?.finalText() ?? ''
    const parts = own ?? (text ? [{ type: 'text', text }] : [])
    const failure = failureOf(index)
    const notice = failure === undefined ? [] : [{ type: 'notice', noticeKind: 'error', id: `speaker-failed:${agent.id}`, text: `${agent.name} could not answer: ${failure}` }]
    return [speakerPart(agent), ...parts, ...notice]
  }
  const last = () => entries().at(-1)?.producer
  return {
    stream,
    finalText: () => entries().map(({ producer }) => producer.finalText()).filter((text) => text.trim() !== '').join('\n\n'),
    assistantParts: () => agents.flatMap((_, index) => partsOf(index, 'assistantParts')),
    draftParts: () => agents.flatMap((_, index) => partsOf(index, 'draftParts')),
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
