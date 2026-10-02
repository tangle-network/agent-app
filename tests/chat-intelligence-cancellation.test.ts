import { describe, expect, it } from 'vitest'
import { observeChatTurnStream, type ChatTurnIntelligenceOptions } from '../src/chat-routes/intelligence'

type Meta = Parameters<ReturnType<ChatTurnIntelligenceOptions['client']>['traceRun']>[0]
function setup(signal: AbortSignal) {
  const records: Meta[] = []
  const options: ChatTurnIntelligenceOptions = {
    sessionId: 'session', signal,
    client: () => ({ async traceRun(meta, body) {
      const value = await body({
        recordOutput() { throw new Error('No content capture is authorized') },
        recordOutcome() { throw new Error('No semantic outcome is observed') },
      })
      records.push(meta)
      return value
    } }),
  }
  return { records, options }
}

describe('abort-aware observation', () => {
  it('records interruption when return settles an outstanding read first', async () => {
    const controller = new AbortController()
    const { records, options } = setup(controller.signal)
    let release!: (value: IteratorResult<{ type: string }, void>) => void
    const pending = new Promise<IteratorResult<{ type: string }, void>>((resolve) => { release = resolve })
    const source: AsyncGenerator<{ type: string }, void, unknown> = {
      [Symbol.asyncIterator]() { return this },
      next() { return pending },
      async return() {
        controller.abort()
        release({ done: true, value: undefined })
        return { done: true, value: undefined }
      },
      async throw(error) { throw error },
      async [Symbol.asyncDispose]() { await this.return(undefined) },
    }
    const stream = observeChatTurnStream(source, options)
    const read = stream.next()
    await stream.return(undefined)
    await read
    expect(records).toHaveLength(1)
    expect(records[0]?.labels?.['tangle.stream.termination']).toBe('interrupted')
  })

  it('preserves the original aborted source error without exporting its reason', async () => {
    const controller = new AbortController()
    const { records, options } = setup(controller.signal)
    const failure = new Error('private abort reason')
    async function* source(): AsyncGenerator<{ type: string }, void, unknown> {
      controller.abort(failure)
      throw failure
    }
    await expect(observeChatTurnStream(source(), options).next()).rejects.toBe(failure)
    expect(records[0]?.labels?.['tangle.stream.termination']).toBe('interrupted')
    expect(JSON.stringify(records)).not.toContain('private abort reason')
  })

  it('freezes terminal status before a later abort during export', async () => {
    const controller = new AbortController()
    const { records, options } = setup(controller.signal)
    const client = options.client
    options.client = () => { controller.abort(); return client() }
    async function* source(): AsyncGenerator<{ type: string }, void, unknown> {
      yield { type: 'one' }
    }
    const stream = observeChatTurnStream(source(), options)
    await stream.next()
    await stream.next()
    expect(records[0]?.labels?.['tangle.stream.termination']).toBe('exhausted')
  })
})
