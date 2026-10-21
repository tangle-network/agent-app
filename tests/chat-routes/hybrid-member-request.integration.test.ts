import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SandboxInstance } from '@tangle-network/sandbox'
import { expect, it } from 'vitest'
import { createHybridTurnProducer } from '../../src/chat-routes/hybrid-producer'

// Real HTTP Router -> producer -> engine tool loop -> sandbox_run -> product box seam.
// The upstream deliberately substitutes code for the member's output contract.
it.each([{ long: false, resumed: false }, { long: true, resumed: false }, { long: false, resumed: true }])('preserves the exact member contract at the box boundary ($long, resumed: $resumed)', async ({ long, resumed }) => {
  const memberRequest = '  Read /workspace/campaign.csv.\nWrite /workspace/report.json as JSON with numeric spendUsd, revenueUsd, and roas at the root.\nDo not nest them under totals.  ' + (long ? 'Additional context. '.repeat(1200) : '')
  const routerTask = 'Run Python and write {"totals":{"spendUsd":10,"revenueUsd":30,"roas":3}}.'
  const tasks: string[] = []
  let calls = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      const delta = ++calls === 1
        ? { tool_calls: [{ index: 0, id: 'box-call', function: { name: 'sandbox_run', arguments: JSON.stringify({ task: routerTask }) } }] }
        : { content: 'Report saved.' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ model: 'served/model', choices: [{ delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const producer = createHybridTurnProducer({
      apiKey: 'test-key', model: 'test-model', systemPrompt: 'Complete the member request.',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, userMessage: resumed ? 'ignored placeholder' : memberRequest,
      ...(resumed ? { continueFrom: { messages: [{ role: 'user' as const, content: memberRequest }], hops: 1, text: '' } } : {}),
      box: {
        acquire: async () => ({ id: 'test-box' }) as unknown as SandboxInstance,
        runTask: async (_box, task) => { tasks.push(task); return 'Report saved.' },
      },
    })
    for await (const _event of producer.stream) { /* drain the real tool loop */ }
    expect(calls).toBe(2)
    expect(tasks).toHaveLength(1)
    const prefix = `The member's request (verbatim):\n${memberRequest}\n\nYour part of it:\n`
    expect(tasks[0]!.slice(0, prefix.length)).toBe(prefix)
    expect(tasks[0]!.slice(prefix.length)).toBe(routerTask.slice(0, Math.max(0, 20_000 - prefix.length)))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
