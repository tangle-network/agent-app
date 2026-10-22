/**
 * `dispatchFirst` starts `produce` (the model call) right after the history read, while the lock, the history
 * recheck, the user-row insert, `contextGate` and `beforeTurn` run. Checked through the composed route:
 *
 *  - the model call starts before the lock is held, and the member sees nothing until the chain commits;
 *  - a same-thread double send keeps exactly one turn: the refused one is aborted and leaves no assistant row;
 *  - a gate refusal aborts the producer, rejects `admitted` and drops what the producer emitted;
 *  - `produce` reads the committed user row through `admitted`.
 */
import { describe, expect, it } from 'vitest'

import {
  createChatTurnRoutes,
  type ChatTurnGateResult,
  type ChatTurnLock,
  type ChatTurnMessageStore,
} from '../../src/chat-routes/index'
import { TurnAdmissionRefusedError } from '../../src/chat-routes/dispatch-first'
import { createMemoryTurnEventStore } from '../../src/stream/index'

type Row = { id: string; role: 'user' | 'assistant'; content: string }
const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function harness(options: { gate?: ChatTurnGateResult; lockMs?: number; words?: number; handoff?: boolean } = {}) {
  const log: string[] = []
  const rows: Row[] = []
  const store: ChatTurnMessageStore = {
    async listMessages() { return rows.map((row) => ({ ...row })) },
    async appendMessage(input) {
      const row = { id: `m-${rows.length + 1}`, role: input.role as Row['role'], content: input.content }
      rows.push(row)
      log.push(`append:${input.role}`)
      return { id: row.id }
    },
  }
  // A real single-flight lock: one holder per thread, refused while held.
  const held = new Set<string>()
  const turnLock: ChatTurnLock<Record<string, never>> = {
    acquire: async (args) => {
      await tick(options.lockMs ?? 20)
      const thread = args.identity.sessionId
      if (held.has(thread)) {
        log.push('lock.refused')
        return { acquired: false, response: Response.json({ code: 'chat_turn_in_flight' }, { status: 409 }) }
      }
      held.add(thread)
      log.push('lock.acquired')
      return { acquired: true, handle: thread }
    },
    release: (handle) => { held.delete(handle as string); log.push('lock.released') },
  }
  const signals: AbortSignal[] = []
  const admittedRows: Array<string | null | undefined> = []
  const refusals: unknown[] = []
  const handoffs: string[] = []
  let produced = 0
  const routes = createChatTurnRoutes<Record<string, never>>({
    projectId: 'dispatch-first',
    authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: {} }),
    dispatchFirst: { billing: 'model-service' },
    store,
    turnStore: createMemoryTurnEventStore(),
    incrementalPersistence: false,
    turnLock,
    contextGate: async () => { log.push('gate'); return options.gate ?? { proceed: true } },
    produce: async (args) => {
      log.push(`model.start:${args.userMessageId === undefined ? 'before-row' : 'after-row'}`)
      if (args.admissionSignal) signals.push(args.admissionSignal)
      args.admitted?.then((final) => admittedRows.push(final.userMessageId), (error: unknown) => refusals.push(error))
      // A product that hands completion to a durable owner calls this before it dispatches.
      if (options.handoff) args.handoffCompletion?.().then(() => handoffs.push('handed-off'), () => handoffs.push('handoff-refused'))
      let text = ''
      const words = options.words ? Array.from({ length: options.words }, (_, i) => ` w${i}`) : ['Hello', ' there']
      return {
        stream: (async function* () {
          for (const word of words) {
            await tick(15)
            if (args.admissionSignal?.aborted) return
            produced += 1
            text += word
            yield { type: 'message.part.updated', data: { part: { type: 'text', text: word }, delta: word } }
          }
        })(),
        finalText: () => text,
      }
    },
    log: () => {},
  })
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, cancelOnDisconnect: true }
  const send = (content = 'hi', signal?: AbortSignal) => routes.turn(new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: 't-1', content }),
    ...(signal ? { signal } : {}),
  }), ctx)
  return { send, log, rows, signals, admittedRows, refusals, handoffs, pending, produced: () => produced }
}

describe('dispatchFirst', () => {
  it('starts the model before the lock is held, and streams only after the user row is written', async () => {
    const h = harness({ lockMs: 60 })
    const response = await h.send()
    const body = await response.text()
    await Promise.all(h.pending)
    expect(h.log.indexOf('model.start:before-row')).toBeLessThan(h.log.indexOf('lock.acquired'))
    expect(h.log.indexOf('append:user')).toBeLessThan(h.log.indexOf('append:assistant'))
    expect(body).toContain('Hello')
    expect(h.rows.map((row) => `${row.role}:${row.content}`)).toEqual(['user:hi', 'assistant:Hello there'])
    // `produce` reads the committed user row through `admitted`.
    expect(h.admittedRows).toEqual(['m-1'])
    expect(h.signals[0]!.aborted).toBe(false)
  })

  it('keeps one turn on a same-thread double send: the refused one is aborted and writes no assistant row', async () => {
    const h = harness()
    const [first, second] = await Promise.all([h.send('one'), h.send('one')])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 409])
    await Promise.all([first.text(), second.text()])
    await Promise.all(h.pending)
    expect(h.log.filter((entry) => entry.startsWith('model.start'))).toHaveLength(2)
    expect(h.signals.filter((signal) => signal.aborted)).toHaveLength(1)
    expect(h.refusals).toHaveLength(1)
    expect(h.refusals[0]).toBeInstanceOf(TurnAdmissionRefusedError)
    expect(h.rows.filter((row) => row.role === 'assistant')).toHaveLength(1)
    expect(h.rows.filter((row) => row.role === 'user')).toHaveLength(1)
  })

  it('aborts the producer and drops its output when the gate refuses', async () => {
    const h = harness({ gate: { proceed: false, response: Response.json({ answer: 'from the gate' }) } })
    const response = await h.send()
    const body = await response.text()
    await Promise.all(h.pending)
    await tick(50)
    expect(body).toContain('from the gate')
    expect(body).not.toContain('Hello')
    expect(h.signals[0]!.aborted).toBe(true)
    expect(h.refusals[0]).toBeInstanceOf(TurnAdmissionRefusedError)
    expect(h.rows.filter((row) => row.role === 'assistant')).toEqual([])
  })

  it('stops the producer when the member disconnects after the turn opened', async () => {
    const h = harness({ words: 40 })
    const client = new AbortController()
    const response = await h.send('hi', client.signal)
    const reader = response.body!.getReader()
    await reader.read()
    await tick(60)
    client.abort()
    await reader.cancel().catch(() => {})
    await Promise.all(h.pending)
    await tick(100)
    expect(h.signals[0]!.aborted).toBe(true)
    expect(h.produced()).toBeLessThan(40)
  })

  it('hands completion to a durable owner only after admission commits', async () => {
    const refused = harness({ handoff: true, gate: { proceed: false, response: Response.json({ answer: 'no' }) } })
    await (await refused.send()).text()
    await Promise.all(refused.pending)
    await tick(20)
    expect(refused.handoffs).toEqual(['handoff-refused'])
    // The route kept the lock it took and released it on the refusal.
    expect(refused.log).toContain('lock.released')
  })
})
