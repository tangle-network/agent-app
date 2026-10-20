import { describe, expect, it } from 'vitest'
import { toLoopEvents, type OpenAIStreamChunk } from '../runtime/openai-stream'
import { escalationHints } from './escalation-speculator'

async function* chunks(...items: OpenAIStreamChunk[]): AsyncIterable<OpenAIStreamChunk> {
  for (const item of items) yield item
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const value of it) out.push(value)
  return out
}

describe('tool_call_start', () => {
  it('announces each tool call once, as soon as its name arrives and before its arguments finish', async () => {
    const events = await collect(toLoopEvents(chunks(
      { choices: [{ delta: { content: 'Checking.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'sandbox_run', arguments: '{"ta' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'sk":"x"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call-2', function: { name: 'memory.recall', arguments: '{}' } }] } }] },
    )))
    expect(events.map((e) => e.type)).toEqual(['text', 'tool_call_start', 'tool_call_start', 'tool_call', 'tool_call'])
    expect(events[1]).toEqual({ type: 'tool_call_start', toolCallId: 'call-1', toolName: 'sandbox_run' })
    expect(events[3]).toMatchObject({ type: 'tool_call', call: { toolName: 'sandbox_run', args: { task: 'x' } } })
  })
})

describe('escalation hints', () => {
  it('reads plain questions as no escalation', () => {
    expect(escalationHints({ text: 'Can you remind the team about the 3 PM arrival?' })).toEqual([])
    expect(escalationHints({ text: 'Convert this sheet', attachments: [{ name: 'rates.xlsx' }] }))
      .toEqual(['attachment', 'execution-words'])
    expect(escalationHints({ text: 'fix this:\n```py\nprint(1)\n```' })).toEqual(['code-block'])
  })
})
