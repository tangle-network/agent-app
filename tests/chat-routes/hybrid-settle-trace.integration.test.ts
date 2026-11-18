/**
 * A hybrid turn's settle runs after the answer and before the row is written: it waits out a box the speculator started,
 * then releases it. On a live Tax turn that was 4,535 ms no span named (7,248 to 11,783 ms of 15,489). Both waits are spans.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SandboxInstance } from '@tangle-network/sandbox'
import { expect, it } from 'vitest'
import { createHybridTurnProducer } from '../../src/chat-routes/hybrid-producer'
import { createTurnTrace } from '../../src/turn-trace/index'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

it('names the settle wait for a speculatively started box and its release', async () => {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ model: 'served/model', choices: [{ delta: { content: 'Your estimate is ready.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const trace = createTurnTrace({ executionId: 'hybrid-settle' })
    const producer = createHybridTurnProducer({
      apiKey: 'test-key', model: 'test-model', trace,
      systemPrompt: { profile: { prompt: { systemPrompt: 'Answer.' } } },
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, userMessage: 'Estimate my tax.',
      box: {
        // The speculator started the box at admission; it is still starting when the Router has answered.
        started: sleep(400).then(() => ({ id: 'speculative-box' }) as unknown as SandboxInstance),
        acquire: async () => ({ id: 'speculative-box' }) as unknown as SandboxInstance,
        runTask: async () => 'unused',
        dispose: () => sleep(60),
      },
    })
    for await (const _event of producer.stream) { /* drain */ }
    const spans = trace.finish().spans
    const span = (name: string) => spans.find((s) => s.name === name)
    const boxStart = span('hybrid.settle.box_start')
    const release = span('hybrid.settle.release')
    expect(boxStart && boxStart.endMs - boxStart.startMs).toBeGreaterThanOrEqual(150)
    expect(release && release.endMs - release.startMs).toBeGreaterThanOrEqual(55)
    expect(release!.startMs).toBeGreaterThanOrEqual(boxStart!.endMs)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
