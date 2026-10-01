import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApplicationIntelligence, type ApplicationIntelligence } from '../src/runtime/application-intelligence'
import { createApplicationIntelligenceLifecycle } from '../src/chat-routes/intelligence'
import type { ChatTurnProducer } from '@tangle-network/agent-runtime/durable'
import type { RunRecord } from '@tangle-network/agent-runtime/intelligence'

type Attribute = { key: string; value: { stringValue?: string; boolValue?: boolean; intValue?: string | number; doubleValue?: number } }
type Span = { attributes: Attribute[] }
type Envelope = { resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }> }
const received: Span[] = []
let requests = 0
let replyStatus = 200
const collector = createServer((request, response) => {
  requests++
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    if (request.method === 'GET') {
      response.writeHead(404).end()
      return
    }
    try {
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Envelope
      for (const rs of envelope.resourceSpans) {
        for (const ss of rs.scopeSpans) received.push(...ss.spans)
      }
      response.writeHead(replyStatus, { 'content-type': 'application/json' }).end('{}')
    } catch { response.writeHead(400).end() }
  })
})
let origin: string
let app: ApplicationIntelligence
const meta = { model: 'requested', runId: 'host-run', labels: {
  'tangle.sessionId': 'session', 'tangle.workspaceId': 'workspace', 'tangle.userId': 'user',
} }
beforeAll(async () => {
  collector.listen(0, '127.0.0.1')
  await once(collector, 'listening')
  const address = collector.address()
  if (!address || typeof address === 'string') throw new Error('Collector port unavailable')
  origin = `http://127.0.0.1:${address.port}`
})
beforeEach(() => {
  received.length = 0
  requests = 0
  replyStatus = 200
  app = createApplicationIntelligence({ config: () => ({ project: 'app-test', apiKey: 'local-proof', baseUrl: origin, effort: 'off' }) })
})
afterEach(async () => { await app.flush() })
afterAll(async () => {
  collector.closeAllConnections()
  await new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve()))
})
function attrs(span: Span) { return Object.fromEntries(span.attributes.map(a => [a.key, a.value])) }
async function one(kind?: string) {
  await app.flush()
  expect(received).toHaveLength(1)
  const values = attrs(received[0]!)
  if (kind) expect(values['tangle.stream.termination']?.stringValue).toBe(kind)
  expect(values['tangle.outcome.success']).toBeUndefined()
  expect(values['tangle.outcome.score']).toBeUndefined()
  expect(values['tangle.output']).toBeUndefined()
  return values
}
async function* source(): ChatTurnProducer['stream'] { yield { type: 'first' }; yield { type: 'second' } }
function observe(stream: ChatTurnProducer['stream']) {
  return app.observeProducer({ produce: () => ({ stream, finalText: () => 'done' }), meta })
}

describe('shared application observation', () => {
  it('is lazy, exports after consumption, retains host identity and never reads output', async () => {
    let calls = 0
    let pulls = 0
    async function* events(): ChatTurnProducer['stream'] { pulls++; yield { type: 'one' }; pulls++ }
    const input = { produce: () => {
      calls++
      return { stream: events(), finalText: (): string => { throw new Error('must not read text') } }
    }, meta: { ...meta, labels: { ...meta.labels } } }
    const turn = await app.observeProducer(input)
    input.meta.labels['tangle.sessionId'] = 'mutated'
    expect(calls).toBe(1)
    expect(pulls).toBe(0)
    await app.flush()
    expect(received).toHaveLength(0)
    await turn.stream.next()
    expect(pulls).toBe(1)
    await app.flush()
    expect(received).toHaveLength(0)
    await turn.stream.next()
    const values = await one('exhausted')
    expect(values['tangle.runId']?.stringValue).toBe('host-run')
    expect(values['tangle.sessionId']?.stringValue).toBe('session')
    expect(values['tangle.usage.inference_usd_known']?.boolValue).toBe(false)
    await turn.stream.next()
    await app.flush()
    expect(received).toHaveLength(1)
  })

  it('preserves source failure identity and partial output', async () => {
    const failure = new Error('original')
    async function* events(): ChatTurnProducer['stream'] { yield { type: 'partial' }; throw failure }
    const turn = await observe(events())
    expect((await turn.stream.next()).value).toEqual({ type: 'partial' })
    await expect(turn.stream.next()).rejects.toBe(failure)
    await one('failed')
  })

  it('preserves native return including yielded cleanup', async () => {
    let cleaned = false
    async function* events(): ChatTurnProducer['stream'] {
      try { yield { type: 'one' } } finally { yield { type: 'cleanup' }; cleaned = true }
    }
    const turn = await observe(events())
    await turn.stream.next()
    expect((await turn.stream.return()).value).toEqual({ type: 'cleanup' })
    await app.flush()
    expect(cleaned).toBe(false)
    expect(received).toHaveLength(0)
    await turn.stream.next()
    expect(cleaned).toBe(true)
    await one('interrupted')
  })

  it('preserves recovered throws, next values, and queued pulls', async () => {
    const failure = new Error('recoverable')
    const sent: unknown[] = []
    async function* events(): ChatTurnProducer['stream'] {
      try { yield { type: 'one' } } catch (error) { expect(error).toBe(failure); sent.push(yield { type: 'recovered' }) }
      sent.push(yield { type: 'two' })
    }
    const turn = await observe(events())
    await turn.stream.next()
    expect((await turn.stream.throw(failure)).value).toEqual({ type: 'recovered' })
    await Promise.all([turn.stream.next('a'), turn.stream.next('b')])
    expect(sent).toEqual(['a', 'b'])
    await one('exhausted')
  })

  it('records no completed run for an unstarted or rejected producer', async () => {
    const turn = await observe(source())
    await turn.stream.return()
    const failure = new Error('factory')
    await expect(app.observeProducer({ meta, produce: () => { throw failure } })).rejects.toBe(failure)
    await app.flush()
    expect(received).toHaveLength(0)
  })

  it('keeps live model getters and private method receivers', async () => {
    class Producer {
      #text = 'not yet'
      #model = 'not yet'
      stream = (async function* (self: Producer) {
        self.#text = 'answer'
        self.#model = 'actually-served'
        yield { type: 'text' }
      })(this)
      get model() { return this.#model }
      finalText() { return this.#text }
    }
    const turn = await app.observeProducer({ produce: () => new Producer(), meta })
    expect(turn.model).toBe('not yet')
    await turn.stream.next()
    await turn.stream.next()
    expect(turn.model).toBe('actually-served')
    expect(turn.finalText()).toBe('answer')
    await one('exhausted')
  })

  it('does not claim semantic success for an in-band error', async () => {
    async function* events(): ChatTurnProducer['stream'] { yield { type: 'error', data: { message: 'failed' } } }
    const turn = await observe(events())
    await turn.stream.next()
    await turn.stream.next()
    await one('exhausted')
  })

  it('isolates concurrent identities', async () => {
    const first = await app.observeProducer({ produce: () => ({ stream: source(), finalText: () => '' }), meta: { runId: 'one' } })
    const second = await app.observeProducer({ produce: () => ({ stream: source(), finalText: () => '' }), meta: { runId: 'two' } })
    await Promise.all([first.stream.next(), second.stream.next()])
    await first.stream.return()
    await second.stream.next()
    await second.stream.next()
    await app.flush()
    expect(received).toHaveLength(2)
    expect(Object.fromEntries(received.map(span => {
      const value = attrs(span)
      return [value['tangle.runId']?.stringValue, value['tangle.stream.termination']?.stringValue]
    }))).toEqual({ one: 'interrupted', two: 'exhausted' })
  })

  it('preserves execution when observer setup fails, without leaking the error', async () => {
    const warnings: string[] = []
    app = createApplicationIntelligence({ config: () => { throw new Error('secret diagnostic') }, warn: message => warnings.push(message) })
    const turn = await observe(source())
    const result: string[] = []
    for await (const event of turn.stream) result.push(event.type)
    expect(result).toEqual(['first', 'second'])
    expect(warnings).toEqual(['[intelligence] application observation unavailable'])
  })

  it('interrupts an ignored abort during a pending first read, without certifying cleanup', async () => {
    const blocked = new Promise<void>(() => {})
    let signal: AbortSignal | undefined
    const turn = await app.observeProducer({ meta, cancellation: 'abort', produce: current => {
      signal = current
      return { stream: (async function* () { await blocked; yield { type: 'unreachable' } })(), finalText: () => '' }
    } })
    const pending = turn.stream.next()
    await turn.stream.return()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(signal?.aborted).toBe(true)
    const values = await one('interrupted')
    expect(values['tangle.stream.cleanup']?.stringValue).toBe('unconfirmed')
  })

  it('does not leak or hang an external abort after partial output', async () => {
    const controller = new AbortController()
    const failure = new Error('upstream abort')
    const blocked = new Promise<void>(() => {})
    const turn = await app.observeProducer({ meta, signal: controller.signal, cancellation: 'abort', produce: () => ({
      stream: (async function* () { yield { type: 'partial' }; await blocked })(), finalText: () => '',
    }) })
    await turn.stream.next()
    const pending = turn.stream.next()
    const rejected = expect(pending).rejects.toBe(failure)
    controller.abort(failure)
    await rejected
    await one('interrupted')
  })

  it('records terminal chat identity, actual attribution and observed zero, not semantic success', async () => {
    const lifecycle = createApplicationIntelligenceLifecycle(app)
    await lifecycle.onTurnComplete?.({
      identity: { tenantId: 'tenant', userId: 'user', sessionId: 'session', turnIndex: 2 },
      executionId: 'exact-run', turnStreamId: 'stream', context: undefined,
      finalText: 'private response', usage: { costUsd: 0 }, durationMs: 125,
      requestedModel: 'requested', servedModel: 'served', assistantMessageId: 'message',
    })
    const values = await one()
    expect(values['tangle.runId']?.stringValue).toBe('exact-run')
    expect(values['tangle.execution.state']?.stringValue).toBe('completed')
    expect(values['gen_ai.response.model']?.stringValue).toBe('served')
    expect(values['tangle.usage.inference_usd_known']).toBeUndefined()
  })

  it('keeps gated execution and missing failure costs unknown', async () => {
    const lifecycle = createApplicationIntelligenceLifecycle(app)
    const identity = { tenantId: 'tenant', userId: 'user', sessionId: 'session', turnIndex: 2 }
    await lifecycle.onTurnComplete?.({ identity, executionId: 'gated', turnStreamId: 's', context: undefined,
      finalText: '', usage: { costUsd: 123 }, durationMs: 1, assistantMessageId: null, gated: true })
    await lifecycle.onTurnError?.({ identity, executionId: 'failed', turnStreamId: 's', context: undefined,
      error: new Error('private failure'), durationMs: 2 })
    await app.flush()
    expect(received).toHaveLength(2)
    for (const span of received) {
      const value = attrs(span)
      expect(value['tangle.usage.inference_usd_known']?.boolValue).toBe(false)
      expect(value['tangle.outcome.success']).toBeUndefined()
    }
  })

  it('keeps native RunRecord uncertainty and never equates configuration with delivery', async () => {
    const record: RunRecord = { runId: 'native', traceId: '12345678901234567890123456789012', project: 'app-test', target: 'target',
      input: undefined, output: undefined, outcome: { usage: { inferenceUsd: 0, inferenceUsdKnown: false, intelligenceUsd: 0 } } }
    const result = app.recordRun(record)
    expect(result).toEqual({ traceId: record.traceId, exportConfigured: true, delivery: 'unconfirmed' })
    const values = await one()
    expect(values['tangle.usage.inference_usd_known']?.boolValue).toBe(false)
  })

  it('keeps guidance disabled without initializing a source or making a request', async () => {
    app = createApplicationIntelligence({ config: () => ({ project: 'app-test' }), delivery: {
      enabled: () => false, config: () => { throw new Error('must not initialize') },
    } })
    expect(await app.composePrompt('base')).toBe('base')
    expect(requests).toBe(0)
  })

  it('uses the existing guidance source and preserves the baseline on 404', async () => {
    app = createApplicationIntelligence({ config: () => ({ project: 'app-test' }), delivery: {
      enabled: () => true, config: () => ({ target: 'test', baseUrl: origin, apiKey: 'local-proof', timeoutMs: 500 }),
    } })
    expect(await app.composePrompt('base')).toBe('base')
    expect(requests).toBe(1)
  })
})
