import { describe, expect, it, vi } from 'vitest'
import { toLoopEvents, type OpenAIStreamChunk } from '../runtime/openai-stream'
import { createEscalationSpeculator, escalationHints, parsePrewarmHint } from './escalation-speculator'

async function* chunks(...items: OpenAIStreamChunk[]): AsyncIterable<OpenAIStreamChunk> {
  for (const item of items) yield item
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const value of it) out.push(value)
  return out
}

function leases() {
  const signal = vi.fn(async () => ({ outcome: 'started' }))
  return { signal }
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

describe('escalation speculator', () => {
  it('stays silent when the hint is off', () => {
    const l = leases()
    const s = createEscalationSpeculator({ mode: parsePrewarmHint(undefined), leases: l, boxKey: 'box' })
    s.onInput({ text: 'Please run this script', attachments: [{ name: 'data.csv' }] })
    s.onEvent({ type: 'tool_call_start', toolName: 'sandbox_run' })
    expect(l.signal).not.toHaveBeenCalled()
    expect(s.fired).toBeNull()
  })

  it('warms on process-shaped input before the model call, once per turn', () => {
    const l = leases()
    const s = createEscalationSpeculator({ mode: parsePrewarmHint('deterministic'), leases: l, boxKey: 'box' })
    s.onInput({ text: 'Summarise this', attachments: [{ mediaType: 'application/pdf', name: 'menu.pdf' }] })
    s.onEvent({ type: 'tool_call_start', toolName: 'sandbox_run' })
    expect(l.signal).toHaveBeenCalledTimes(1)
    expect(l.signal).toHaveBeenCalledWith('box', 'escalation-likely')
    expect(s.fired).toBe('attachment')
  })

  it('warms when the model starts a sandbox tool, and not for other tools', () => {
    const l = leases()
    const s = createEscalationSpeculator({ mode: 'deterministic', leases: l, boxKey: 'box' })
    s.onInput({ text: 'What time is check-in?' })
    s.onEvent({ type: 'text' })
    s.onEvent({ type: 'tool_call_start', toolName: 'memory.recall' })
    expect(l.signal).not.toHaveBeenCalled()
    s.onEvent({ type: 'tool_call_start', toolName: 'sandbox_exec' })
    expect(l.signal).toHaveBeenCalledTimes(1)
    expect(s.fired).toBe('tool-call-start')
  })

  it('never lets a failing warm reach the turn', async () => {
    const signal = vi.fn(async () => { throw new Error('lease store down') })
    const s = createEscalationSpeculator({ mode: 'deterministic', leases: { signal }, boxKey: 'box' })
    expect(() => s.onInput({ text: 'run the tests' })).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(signal).toHaveBeenCalledTimes(1)
  })

  it('reads plain questions as no escalation', () => {
    expect(escalationHints({ text: 'Can you remind the team about the 3 PM arrival?' })).toEqual([])
    expect(escalationHints({ text: 'Convert this sheet', attachments: [{ name: 'rates.xlsx' }] }))
      .toEqual(['attachment', 'execution-words'])
    expect(escalationHints({ text: 'fix this:\n```py\nprint(1)\n```' })).toEqual(['code-block'])
  })
})
