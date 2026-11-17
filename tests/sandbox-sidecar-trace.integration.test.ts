import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { traceSandboxPromptEvents } from '../src/sandbox/prompt-trace'
import { createIntelligenceTurnTraceSink, createTurnTrace } from '../src/turn-trace/index'

it('projects sidecar startup spans from the HTTP event stream into the exported turn trace', async () => {
  const exports: unknown[] = []
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      exports.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      return
    }
    // Sidecar offsets are relative to turn_received, independent of this process's clock.
    await new Promise(resolve => setTimeout(resolve, 80))
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.end([
      { type: 'message.part.updated', data: { part: { type: 'text', text: 'Done.' } } },
      { type: 'result', data: { firstTextPhases: {
        phasesMs: { agent_run_start: 5, harness_spawn: 30, first_text: 50 },
        harnessWarm: false, model: 'served-model', spans: [
          { name: 'cli_initialize', startMs: 8, endMs: 27 },
          { name: 'cli_spawn', startMs: 27, endMs: 30 },
          { name: 'invalid', startMs: 30, endMs: 20 },
        ],
      } } },
    ].map(event => JSON.stringify(event)).join('\n'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const trace = createTurnTrace({ executionId: 'sidecar-integration' })
    async function* source() {
      const response = await fetch(baseUrl)
      for (const line of (await response.text()).split('\n')) yield JSON.parse(line)
    }
    const seen: unknown[] = []
    for await (const event of traceSandboxPromptEvents(source(), { trace })) seen.push(event)
    expect(seen).toHaveLength(2)
    const snapshot = trace.finish()
    const prompt = snapshot.spans.find(span => span.name === 'sandbox.prompt')!
    const startup = snapshot.spans.find(span => span.name === 'sidecar.cli_initialize')!
    expect(startup.parentSpanId).toBe(prompt.spanId)
    expect(startup.endMs - startup.startMs).toBe(19)
    expect(snapshot.spans.some(span => span.name === 'sidecar.invalid')).toBe(false)
    await createIntelligenceTurnTraceSink({ project: 'sidecar-integration', apiKey: 'test-key', baseUrl })(snapshot, {})
    expect(exports).toHaveLength(1)
    const serialized = JSON.stringify(exports[0])
    expect(serialized).toContain('sidecar.cli_initialize')
    expect(serialized).toContain('sidecar.cli_spawn')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('gives a box tool call the duration the box reported, though OpenCode sends the part only once it finished', async () => {
  // The box's clock, not this process's: only the difference may be used.
  const finished = { type: 'tool', id: 'part-1', callID: 'call-1', tool: 'bash', state: { status: 'completed', time: { start: 1_700_000_000_000, end: 1_700_000_000_250 } } }
  const server = createServer(async (_request, response) => {
    await new Promise(resolve => setTimeout(resolve, 300))
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.end([
      { type: 'message.part.updated', data: { part: { type: 'text', text: 'Running it.' } } },
      { type: 'message.part.updated', data: { part: finished } },
      { type: 'message.part.updated', data: { part: { ...finished, id: 'part-2', callID: 'call-2', state: { status: 'error', time: { start: 5, end: 45 } } } } },
    ].map(event => JSON.stringify(event)).join('\n'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const trace = createTurnTrace({ executionId: 'sidecar-tool-duration' })
    async function* source() {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      for (const line of (await response.text()).split('\n')) yield JSON.parse(line)
    }
    for await (const _event of traceSandboxPromptEvents(source(), { trace })) { /* pass through */ }
    const tools = trace.finish().spans.filter(span => span.name === 'tool.call')
    expect(tools.map(span => Math.round(span.endMs - span.startMs))).toEqual([250, 40])
    expect(tools.every(span => span.attrs.approx === undefined && span.attrs['gen_ai.tool.name'] === 'bash')).toBe(true)
    expect(tools[1]!.attrs['tool.status']).toBe('error')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
