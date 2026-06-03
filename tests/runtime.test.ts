import { describe, it, expect } from 'vitest'
import { runAppToolLoop, streamAppToolLoop, type LoopEvent, type LoopToolCall, type StreamLoopYield } from '../src/runtime/index'
import type { AppToolOutcome } from '../src/tools/index'

/** A scripted model: each entry is the events for one turn. */
function scriptedStream(turns: LoopEvent[][]) {
  let i = 0
  return async function* () {
    const turn = turns[Math.min(i, turns.length - 1)]!
    i++
    for (const ev of turn) yield ev
  }
}

const isExec = (n: string) => n === 'submit_proposal' || n === 'schedule_followup'

describe('runAppToolLoop', () => {
  it('returns text immediately when no tool calls are emitted (single turn)', async () => {
    const stream = scriptedStream([[{ type: 'text', text: 'Here is my analysis.' }]])
    const r = await runAppToolLoop({
      systemPrompt: 's', userMessage: 'u',
      streamTurn: () => stream(),
      executeToolCall: async () => ({ ok: true, result: {} }),
      isExecutableTool: isExec,
    })
    expect(r.finalText).toBe('Here is my analysis.')
    expect(r.turns).toBe(1)
    expect(r.toolResults).toHaveLength(0)
    expect(r.cappedOut).toBe(false)
  })

  it('executes a tool call, folds the result back, and re-runs to the final answer', async () => {
    const calls: LoopToolCall[] = []
    let turn = 0
    const streamTurn = async function* (messages: Array<{ role: string; content: string }>) {
      turn++
      const sawResults = messages.some((m) => m.content.includes('Tool results'))
      if (!sawResults) {
        yield { type: 'text', text: 'Routing. ' } as LoopEvent
        yield { type: 'tool_call', call: { toolName: 'submit_proposal', toolCallId: 'p1', args: { type: 'propose_swap', title: 'Swap A' } } } as LoopEvent
        return
      }
      yield { type: 'text', text: 'Routed for approval.' } as LoopEvent
    }
    const r = await runAppToolLoop({
      systemPrompt: 's', userMessage: 'u',
      streamTurn,
      executeToolCall: async (c) => { calls.push(c); return { ok: true, result: { proposalId: 'prop-1' } } satisfies AppToolOutcome },
      isExecutableTool: isExec,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolName).toBe('submit_proposal')
    expect(r.turns).toBe(2)
    expect(r.finalText).toBe('Routing. Routed for approval.')
    expect(r.toolResults[0]!.outcome).toMatchObject({ ok: true })
    expect(turn).toBe(2)
  })

  it('ignores non-executable tool calls (UI-only tools the app renders elsewhere)', async () => {
    const stream = scriptedStream([[
      { type: 'text', text: 'done' },
      { type: 'tool_call', call: { toolName: 'render_widget', args: {} } },
    ]])
    let executed = 0
    const r = await runAppToolLoop({
      systemPrompt: 's', userMessage: 'u',
      streamTurn: () => stream(),
      executeToolCall: async () => { executed++; return { ok: true, result: {} } },
      isExecutableTool: isExec, // render_widget not executable
    })
    expect(executed).toBe(0)
    expect(r.turns).toBe(1)
    expect(r.finalText).toBe('done')
  })

  it('caps the loop and flags cappedOut when the model keeps calling tools', async () => {
    // Always emits a tool call → would loop forever without the cap.
    const streamTurn = async function* () {
      yield { type: 'tool_call', call: { toolName: 'schedule_followup', args: { title: 'x', dueDate: '2026-01-01' } } } as LoopEvent
    }
    const r = await runAppToolLoop({
      systemPrompt: 's', userMessage: 'u', maxToolTurns: 3,
      streamTurn,
      executeToolCall: async () => ({ ok: true, result: {} }),
      isExecutableTool: isExec,
    })
    expect(r.cappedOut).toBe(true)
    expect(r.turns).toBe(4) // turns 0..3 ran, the 4th detected the cap
    expect(r.toolResults.length).toBe(3)
  })

  it('turns an executor throw into a failed outcome and keeps going', async () => {
    let turn = 0
    const streamTurn = async function* (messages: Array<{ role: string; content: string }>) {
      turn++
      if (!messages.some((m) => m.content.includes('Tool results'))) {
        yield { type: 'tool_call', call: { toolName: 'submit_proposal', args: { type: 'propose_swap', title: 'X' } } } as LoopEvent
        return
      }
      yield { type: 'text', text: 'noted the failure' } as LoopEvent
    }
    const r = await runAppToolLoop({
      systemPrompt: 's', userMessage: 'u',
      streamTurn,
      executeToolCall: async () => { throw new Error('db down') },
      isExecutableTool: isExec,
    })
    expect(r.toolResults[0]!.outcome).toEqual({ ok: false, code: 'executor_error', message: 'db down' })
    expect(r.finalText).toBe('noted the failure')
  })
})

// Raw event type a streaming consumer (e.g. insurance's runtime) would map.
type Raw = { type: 'text_delta'; text: string } | { type: 'tool_call'; toolName: string; toolCallId?: string; args: Record<string, unknown> }

describe('streamAppToolLoop', () => {
  const opts = {
    extractText: (e: Raw) => (e.type === 'text_delta' ? e.text : ''),
    extractToolCall: (e: Raw): LoopToolCall | null => (e.type === 'tool_call' ? { toolName: e.toolName, toolCallId: e.toolCallId, args: e.args } : null),
    isExecutableTool: (n: string) => n === 'submit_proposal',
  }

  it('yields every raw event + each tool_result, drives the loop, folds results back', async () => {
    let turn = 0
    const streamTurn = async function* (messages: Array<{ role: string; content: string }>): AsyncIterable<Raw> {
      turn++
      if (!messages.some((m) => m.content.includes('Tool results'))) {
        yield { type: 'text_delta', text: 'Routing. ' }
        yield { type: 'tool_call', toolName: 'submit_proposal', toolCallId: 'p1', args: { type: 'propose_swap', title: 'A' } }
        return
      }
      yield { type: 'text_delta', text: 'Done.' }
    }
    const yields: StreamLoopYield<Raw>[] = []
    const exec: AppToolOutcome[] = []
    for await (const item of streamAppToolLoop<Raw>({
      systemPrompt: 's', userMessage: 'u', streamTurn, ...opts,
      executeToolCall: async () => { const o: AppToolOutcome = { ok: true, result: { proposalId: 'prop-1' } }; exec.push(o); return o },
    })) {
      yields.push(item)
    }
    const events = yields.filter((y) => y.kind === 'event')
    const results = yields.filter((y) => y.kind === 'tool_result')
    expect(events.length).toBe(3) // 2 turn-1 events + 1 turn-2 event
    expect(results.length).toBe(1)
    expect(results[0]).toMatchObject({ kind: 'tool_result', toolName: 'submit_proposal', label: 'submit_proposal', outcome: { ok: true } })
    expect(exec).toHaveLength(1)
    expect(turn).toBe(2)
  })

  it('emits a single capped signal when the model never stops calling tools', async () => {
    const streamTurn = async function* (): AsyncIterable<Raw> {
      yield { type: 'tool_call', toolName: 'submit_proposal', args: { type: 'propose_swap', title: 'x' } }
    }
    const yields: StreamLoopYield<Raw>[] = []
    for await (const item of streamAppToolLoop<Raw>({
      systemPrompt: 's', userMessage: 'u', maxToolTurns: 2, streamTurn, ...opts,
      executeToolCall: async () => ({ ok: true, result: {} }),
    })) {
      yields.push(item)
    }
    const capped = yields.filter((y) => y.kind === 'capped')
    expect(capped).toHaveLength(1)
    expect((capped[0] as { pending: number }).pending).toBe(1)
  })

  it('passes a custom labelFor through to the tool_result (e.g. an integration hub path)', async () => {
    const streamTurn = async function* (messages: Array<{ role: string; content: string }>): AsyncIterable<Raw> {
      if (!messages.some((m) => m.content.includes('Tool results'))) {
        yield { type: 'tool_call', toolName: 'gmail_send', args: {} }
        return
      }
      yield { type: 'text_delta', text: 'ok' }
    }
    const yields: StreamLoopYield<Raw>[] = []
    for await (const item of streamAppToolLoop<Raw>({
      systemPrompt: 's', userMessage: 'u', streamTurn,
      extractText: opts.extractText,
      extractToolCall: opts.extractToolCall,
      isExecutableTool: (n) => n === 'gmail_send',
      labelFor: () => 'gmail.messages.send',
      executeToolCall: async () => ({ ok: true, result: { id: 'm1' } }),
    })) {
      yields.push(item)
    }
    const result = yields.find((y) => y.kind === 'tool_result')
    expect((result as { label: string }).label).toBe('gmail.messages.send')
  })
})
