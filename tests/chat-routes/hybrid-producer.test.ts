/**
 * The hybrid turn behind the shared chat route: the Router answers first, the
 * box starts once (at admission when the ask needs it, or when the model names
 * `sandbox_run`), and `sandbox_run` reuses that start. The Router is replaced at
 * its HTTP boundary and the box at the product's acquire seam; the route,
 * engine, tool loop, speculator and `sandbox_run` tool are the real ones.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SandboxInstance } from '@tangle-network/sandbox'
import {
  createChatTurnRoutes,
  createHybridTurnProducer,
  HYBRID_TURN_GUIDANCE,
  routerTurnHistory,
  startHybridBox,
  turnPromptText,
  type ChatTurnMessageStore,
} from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

function sse(chunks: unknown[]) {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const text = (value: string) => ({ model: 'served/model', choices: [{ delta: { content: value } }] })
const toolCall = (id: string, name: string, args: string) => ({ model: 'served/model',
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }] })

interface Harness {
  order: string[]
  acquire: ReturnType<typeof vi.fn>
  runTask: ReturnType<typeof vi.fn>
  requests: Array<{ messages: Array<{ role: string; content: unknown }> }>
  rows: Array<{ role: string; content: string }>
  turn(content: string, routerAnswers: Response[]): Promise<string>
}

function harness(): Harness {
  const order: string[] = []
  const box = { id: 'box-1' } as unknown as SandboxInstance
  const acquire = vi.fn(async () => { order.push('box.acquire'); return box })
  const runTask = vi.fn(async (_box: SandboxInstance, task: string) => { order.push(`box.run:${task}`); return 'The script printed 42.' })
  const requests: Harness['requests'] = []
  const rows: Harness['rows'] = []
  const store: ChatTurnMessageStore = {
    async listMessages() { return [] },
    async appendMessage(input) { rows.push(input as never); return { id: `m-${rows.length}` } },
  }
  return {
    order, acquire, runTask, requests, rows,
    async turn(content, routerAnswers) {
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        order.push('router.call')
        requests.push(JSON.parse(String(init?.body)))
        const next = routerAnswers.shift()
        if (!next) throw new Error('unexpected model call')
        return next
      }) as unknown as typeof fetch
      const pending: Promise<unknown>[] = []
      const routes = createChatTurnRoutes<{ box?: Promise<SandboxInstance> }>({
        projectId: 'hybrid-producer',
        authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: {} }),
        store,
        turnStore: createMemoryTurnEventStore(),
        incrementalPersistence: false,
        afterAuthorize: ({ body, context }) => {
          context.box = startHybridBox(body, () => acquire())
        },
        produce: ({ prompt, priorMessages, context, trace }) => createHybridTurnProducer({
          apiKey: 'k', model: 'm', systemPrompt: 'You are the workspace agent.',
          userMessage: turnPromptText(prompt), history: routerTurnHistory(priorMessages), trace, fetchImpl,
          box: { acquire, runTask, ...(context.box ? { started: context.box } : {}) },
        }),
        log: () => {},
      })
      const response = await routes.turn(new Request('http://app.test/api/chat', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 't-1', content }) }),
      { waitUntil: (p: Promise<unknown>) => { pending.push(p) } })
      const body = await response.text()
      await Promise.all(pending)
      expect(response.status).toBe(200)
      return body
    },
  }
}

describe('createHybridTurnProducer behind the chat route', () => {
  it('starts the box once at admission for an execution ask, says what it is doing first, and runs sandbox_run on that box', async () => {
    const h = harness()
    const body = await h.turn('Run the attached script and tell me what it prints', [
      sse([text('I will run the script on the workspace computer.'), toolCall('call-1', 'sandbox_run', '{"task":"run script.py"}')]),
      sse([text('It printed 42.')]),
    ])

    // One box start, begun at admission before the first model call, and the tool ran on it.
    expect(h.acquire).toHaveBeenCalledTimes(1)
    expect(h.order.indexOf('box.acquire')).toBeLessThan(h.order.indexOf('router.call'))
    expect(h.runTask).toHaveBeenCalledWith({ id: 'box-1' }, 'run script.py', expect.anything())
    // The member reads the lead-in before the box answers.
    expect(body.indexOf('I will run the script')).toBeGreaterThan(-1)
    expect(body.indexOf('I will run the script')).toBeLessThan(body.indexOf('It printed 42.'))
    // The default prompt asks for that lead-in.
    expect(JSON.stringify(h.requests[0]!.messages[0])).toContain(HYBRID_TURN_GUIDANCE.slice(0, 60))
    const assistant = h.rows.find(row => row.role === 'assistant')
    expect(assistant?.content).toContain('It printed 42.')
  })

  it('starts no box for a plain question, and starts one when the model names sandbox_run', async () => {
    const plain = harness()
    await plain.turn('What does a mutual NDA usually cover?', [sse([text('Both sides keep each other\'s information confidential.')])])
    expect(plain.acquire).not.toHaveBeenCalled()

    const named = harness()
    await named.turn('How long is this lease?', [
      sse([text('Let me read the lease on the workspace computer.'), toolCall('call-1', 'sandbox_run', '{"task":"read lease.pdf"}')]),
      sse([text('Twelve months.')]),
    ])
    // The speculator's start and the tool's call share one start.
    expect(named.acquire).toHaveBeenCalledTimes(1)
    expect(named.runTask).toHaveBeenCalledTimes(1)
  })
})
