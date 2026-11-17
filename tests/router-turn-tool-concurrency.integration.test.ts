/** `maxConcurrentToolCalls` through the real Router turn over loopback HTTP: one model call asks for three lookups. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { runRouterTurn, type RouterTurnEvent } from '../src/runtime/router-turn'

const sse = (event: object) => `data: ${JSON.stringify(event)}\n\n`
const queries = ['first', 'second', 'third']

async function threeLookups(limits: { maxConcurrentToolCalls?: number; maxToolCalls?: number } = {}) {
  // The tool results each model request carried, in the order the model reads them.
  const toolResults: string[][] = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const { messages } = JSON.parse(raw) as { messages: Array<{ role: string; content?: string }> }
    const results = messages.filter(message => message.role === 'tool').map(message => message.content ?? '')
    toolResults.push(results)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (results.length === 0) {
      response.end(sse({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: { tool_calls: queries.map((query, index) =>
        ({ index, id: `c${index}`, function: { name: 'lookup', arguments: JSON.stringify({ query }) } })) } }] }))
    } else {
      response.end(sse({ choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'Compared.' } }] }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  // When each lookup started and finished, as the executor saw it.
  const runs: Array<{ query: string; start: number; end: number }> = []
  // The last status the turn reported for each call, as a caller's tool cards would show it.
  const cards = new Map<string, string>()
  try {
    const outcome = await runRouterTurn({ apiKey: 'local-integration-only', model: 'test-model', api: 'chat',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, systemPrompt: 's', userMessage: 'Compare three options',
      ...limits,
      onEvent: (event: RouterTurnEvent) => { if (event.type === 'tool') cards.set(event.callId, event.status) },
      tools: [{ name: 'lookup', description: 'Look something up', effect: 'lookup',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        run: async args => {
          const query = String(args.query)
          const run = { query, start: performance.now(), end: 0 }
          runs.push(run)
          // The first lookup is the slowest, so results that came back in finishing order would show.
          await new Promise(resolve => setTimeout(resolve, 300 - 100 * queries.indexOf(query)))
          run.end = performance.now()
          return `found ${query}`
        } }] })
    return { outcome, runs, toolResults, cards: Object.fromEntries(cards) }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

it('at width 3, runs the three lookups at once and the model reads their results in call order', async () => {
  const { outcome, runs, toolResults } = await threeLookups({ maxConcurrentToolCalls: 3 })
  expect(outcome.failure).toBeUndefined()
  expect(outcome.answer).toBe('Compared.')
  expect(runs.map(run => run.query)).toEqual(queries)
  // Every lookup started before any finished.
  expect(Math.max(...runs.map(run => run.start))).toBeLessThan(Math.min(...runs.map(run => run.end)))
  expect(toolResults).toEqual([[], queries.map(query => expect.stringContaining(`found ${query}`))])
})

it('by default, runs the lookups one at a time, in call order', async () => {
  const { outcome, runs, toolResults } = await threeLookups()
  expect(outcome.failure).toBeUndefined()
  expect(outcome.answer).toBe('Compared.')
  expect(runs.map(run => run.query)).toEqual(queries)
  // Each lookup started after the one before it finished.
  expect(runs.slice(1).every((run, index) => run.start >= runs[index]!.end)).toBe(true)
  expect(toolResults).toEqual([[], queries.map(query => expect.stringContaining(`found ${query}`))])
})

it('at width 3 with a limit of 2 tool calls, reports both lookups that ran before the refused one ends the turn', async () => {
  const { outcome, runs, toolResults, cards } = await threeLookups({ maxConcurrentToolCalls: 3, maxToolCalls: 2 })
  expect(outcome.failure?.code).toBe('turn_tool_limit')
  expect(runs.map(run => run.query)).toEqual(['first', 'second'])
  expect(outcome.toolCalls).toEqual([
    { callId: 'c0', toolName: 'lookup', ok: true },
    { callId: 'c1', toolName: 'lookup', ok: true },
    { callId: 'c2', toolName: 'lookup', ok: false },
  ])
  expect(cards).toEqual({ c0: 'completed', c1: 'completed', c2: 'error' })
  // The turn ends at the refusal instead of asking the model again.
  expect(toolResults).toEqual([[]])
})
