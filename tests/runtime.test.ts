import { describe, it, expect } from 'vitest'
import { runAppToolLoop, streamAppToolLoop, type ToolLoopEvent, type LoopMessage, type LoopToolCall, type StreamLoopYield } from '../src/runtime/index'
import type { AppToolOutcome } from '../src/tools/index'

/** A scripted model: each entry is the events for one turn. */
function scriptedStream(turns: ToolLoopEvent[][]) {
  let i = 0
  return async function* () {
    const turn = turns[Math.min(i, turns.length - 1)]!
    i++
    for (const ev of turn) yield ev
  }
}

const isExec = (n: string) => n === 'submit_proposal' || n === 'schedule_followup'

/** True once tool results have been appended — i.e. this is a re-run after a
 *  dispatch. Keys off the OpenAI-correct `role: 'tool'` message, not a `user`
 *  "Tool results:" string. */
const sawToolResult = (messages: LoopMessage[]) => messages.some((m) => m.role === 'tool')

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

  it('executes a tool call, appends the result, and re-runs to the final answer', async () => {
    const calls: LoopToolCall[] = []
    let turn = 0
    const streamTurn = async function* (messages: LoopMessage[]) {
      turn++
      if (!sawToolResult(messages)) {
        yield { type: 'text', text: 'Routing. ' } as ToolLoopEvent
        yield { type: 'tool_call', call: { toolName: 'submit_proposal', toolCallId: 'p1', args: { type: 'recommend', title: 'Proposal A' } } } as ToolLoopEvent
        return
      }
      yield { type: 'text', text: 'Routed for approval.' } as ToolLoopEvent
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

  it('appends tool results in OpenAI shape: assistant.tool_calls then a role:tool message per result, keyed by tool_call_id', async () => {
    const turnMessages: LoopMessage[][] = []
    const streamTurn = async function* (messages: LoopMessage[]) {
      turnMessages.push(messages)
      if (!sawToolResult(messages)) {
        yield { type: 'text', text: 'Routing both. ' } as ToolLoopEvent
        yield { type: 'tool_call', call: { toolName: 'submit_proposal', toolCallId: 'p1', args: { type: 'recommend', title: 'A' } } } as ToolLoopEvent
        yield { type: 'tool_call', call: { toolName: 'schedule_followup', toolCallId: 'f9', args: { title: 'x', dueDate: '2026-01-01' } } } as ToolLoopEvent
        return
      }
      yield { type: 'text', text: 'Done.' } as ToolLoopEvent
    }
    await runAppToolLoop({
      systemPrompt: 's', userMessage: 'u',
      streamTurn,
      executeToolCall: async (c) => ({ ok: true, result: { id: c.toolName } }),
      isExecutableTool: isExec,
    })

    // The re-run sees: system, user, the assistant turn (with both tool_calls),
    // then one role:'tool' result per call — and NO user-role "Tool results".
    const reRun = turnMessages[1]!
    expect(reRun.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Tool results'))).toBe(false)

    const assistant = reRun.find((m) => m.role === 'assistant')!
    expect(assistant.content).toBe('Routing both.')
    expect(assistant.tool_calls).toEqual([
      { id: 'p1', type: 'function', function: { name: 'submit_proposal', arguments: JSON.stringify({ type: 'recommend', title: 'A' }) } },
      { id: 'f9', type: 'function', function: { name: 'schedule_followup', arguments: JSON.stringify({ title: 'x', dueDate: '2026-01-01' }) } },
    ])

    const toolMsgs = reRun.filter((m) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['p1', 'f9'])
    // Each result message is keyed by tool_call_id and follows its assistant turn.
    expect(reRun.indexOf(assistant)).toBeLessThan(reRun.indexOf(toolMsgs[0]!))
    expect(typeof toolMsgs[0]!.content).toBe('string')
  })

  it('a tool-only assistant turn carries content:null and still emits tool_calls', async () => {
    const turnMessages: LoopMessage[][] = []
    const streamTurn = async function* (messages: LoopMessage[]) {
      turnMessages.push(messages)
      if (!sawToolResult(messages)) {
        yield { type: 'tool_call', call: { toolName: 'submit_proposal', toolCallId: 'p1', args: { type: 'recommend', title: 'A' } } } as ToolLoopEvent
        return
      }
      yield { type: 'text', text: 'ok' } as ToolLoopEvent
    }
    await runAppToolLoop({
      systemPrompt: 's', userMessage: 'u',
      streamTurn,
      executeToolCall: async () => ({ ok: true, result: {} }),
      isExecutableTool: isExec,
    })
    const assistant = turnMessages[1]!.find((m) => m.role === 'assistant')!
    expect(assistant.content).toBeNull()
    expect(assistant.tool_calls).toHaveLength(1)
  })

  it('derives a stable tool_call_id when the model omits one (assistant + result match)', async () => {
    const turnMessages: LoopMessage[][] = []
    const streamTurn = async function* (messages: LoopMessage[]) {
      turnMessages.push(messages)
      if (!sawToolResult(messages)) {
        yield { type: 'tool_call', call: { toolName: 'submit_proposal', args: { type: 'recommend', title: 'A' } } } as ToolLoopEvent
        return
      }
      yield { type: 'text', text: 'ok' } as ToolLoopEvent
    }
    await runAppToolLoop({
      systemPrompt: 's', userMessage: 'u',
      streamTurn,
      executeToolCall: async () => ({ ok: true, result: {} }),
      isExecutableTool: isExec,
    })
    const reRun = turnMessages[1]!
    const assistant = reRun.find((m) => m.role === 'assistant')!
    const toolMsg = reRun.find((m) => m.role === 'tool')!
    expect(assistant.tool_calls![0]!.id).toBe('call_submit_proposal')
    expect(toolMsg.tool_call_id).toBe('call_submit_proposal')
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

  it('stops with backstop stopReason when the model keeps calling tools (varying args)', async () => {
    // Each turn emits a DIFFERENT args object so stuck-loop never fires; only
    // the backstop cap is hit.
    let seq = 0
    const streamTurn = async function* () {
      yield { type: 'tool_call', call: { toolName: 'schedule_followup', args: { title: 'x', seq: seq++ } } } as ToolLoopEvent
    }
    const r = await runAppToolLoop({
      systemPrompt: 's', userMessage: 'u', maxToolTurns: 3,
      streamTurn,
      executeToolCall: async () => ({ ok: true, result: {} }),
      isExecutableTool: isExec,
    })
    expect(r.cappedOut).toBe(true)
    expect(r.stopReason).toBe('backstop')
    expect(r.turns).toBe(4) // turns 0..3 ran, the 4th detected the backstop
    expect(r.toolResults.length).toBe(3)
  })

  it('stops with stuck-loop stopReason when the model repeats the same call 3 times', async () => {
    // Identical args each turn — stuck-loop fires at the 3rd repetition.
    const streamTurn = async function* () {
      yield { type: 'tool_call', call: { toolName: 'schedule_followup', args: { title: 'x', dueDate: '2026-01-01' } } } as ToolLoopEvent
    }
    const r = await runAppToolLoop({
      systemPrompt: 's', userMessage: 'u',
      streamTurn,
      executeToolCall: async () => ({ ok: true, result: {} }),
      isExecutableTool: isExec,
    })
    expect(r.cappedOut).toBe(true)
    expect(r.stopReason).toBe('stuck-loop')
    // Fires on the 3rd identical call — 2 tool results recorded before stop.
    expect(r.toolResults.length).toBe(2)
  })

  it('turns an executor throw into a failed outcome and keeps going', async () => {
    let turn = 0
    const streamTurn = async function* (messages: LoopMessage[]) {
      turn++
      if (!sawToolResult(messages)) {
        yield { type: 'tool_call', call: { toolName: 'submit_proposal', args: { type: 'recommend', title: 'X' } } } as ToolLoopEvent
        return
      }
      yield { type: 'text', text: 'noted the failure' } as ToolLoopEvent
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

// Raw event type a streaming consumer (e.g. a product's runtime) would map.
type Raw = { type: 'text_delta'; text: string } | { type: 'tool_call'; toolName: string; toolCallId?: string; args: Record<string, unknown> }

describe('streamAppToolLoop', () => {
  const opts = {
    extractText: (e: Raw) => (e.type === 'text_delta' ? e.text : ''),
    extractToolCall: (e: Raw): LoopToolCall | null => (e.type === 'tool_call' ? { toolName: e.toolName, toolCallId: e.toolCallId, args: e.args } : null),
    isExecutableTool: (n: string) => n === 'submit_proposal',
  }

  it('appends the OpenAI tool history (assistant.tool_calls + role:tool) for the next turn', async () => {
    const turnMessages: LoopMessage[][] = []
    const streamTurn = async function* (messages: LoopMessage[]): AsyncIterable<Raw> {
      turnMessages.push(messages)
      if (!sawToolResult(messages)) {
        yield { type: 'text_delta', text: 'Routing. ' }
        yield { type: 'tool_call', toolName: 'submit_proposal', toolCallId: 'p1', args: { type: 'recommend', title: 'A' } }
        return
      }
      yield { type: 'text_delta', text: 'Done.' }
    }
    for await (const _ of streamAppToolLoop<Raw>({
      systemPrompt: 's', userMessage: 'u', streamTurn, ...opts,
      executeToolCall: async () => ({ ok: true, result: { proposalId: 'prop-1' } }),
    })) { /* drain */ }

    const reRun = turnMessages[1]!
    expect(reRun.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Tool results'))).toBe(false)
    const assistant = reRun.find((m) => m.role === 'assistant')!
    expect(assistant.tool_calls).toEqual([
      { id: 'p1', type: 'function', function: { name: 'submit_proposal', arguments: JSON.stringify({ type: 'recommend', title: 'A' }) } },
    ])
    const toolMsg = reRun.find((m) => m.role === 'tool')!
    expect(toolMsg.tool_call_id).toBe('p1')
  })

  it('yields every raw event + each tool_result, drives the loop, appends results back', async () => {
    let turn = 0
    const streamTurn = async function* (messages: LoopMessage[]): AsyncIterable<Raw> {
      turn++
      if (!sawToolResult(messages)) {
        yield { type: 'text_delta', text: 'Routing. ' }
        yield { type: 'tool_call', toolName: 'submit_proposal', toolCallId: 'p1', args: { type: 'recommend', title: 'A' } }
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

  it('emits a single capped signal with backstop stopReason when the model never stops (varying args)', async () => {
    // Different args each turn so stuck-loop never fires; backstop fires instead.
    let seq = 0
    const streamTurn = async function* (): AsyncIterable<Raw> {
      yield { type: 'tool_call', toolName: 'submit_proposal', args: { type: 'recommend', title: 'x', seq: seq++ } }
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
    expect(capped[0]).toMatchObject({ kind: 'capped', pending: 1, stopReason: 'backstop' })
  })

  it('emits capped with stuck-loop stopReason on 3 consecutive identical calls', async () => {
    const streamTurn = async function* (): AsyncIterable<Raw> {
      yield { type: 'tool_call', toolName: 'submit_proposal', args: { type: 'recommend', title: 'x' } }
    }
    const yields: StreamLoopYield<Raw>[] = []
    for await (const item of streamAppToolLoop<Raw>({
      systemPrompt: 's', userMessage: 'u', streamTurn, ...opts,
      executeToolCall: async () => ({ ok: true, result: {} }),
    })) {
      yields.push(item)
    }
    const capped = yields.filter((y) => y.kind === 'capped')
    expect(capped).toHaveLength(1)
    expect(capped[0]).toMatchObject({ kind: 'capped', stopReason: 'stuck-loop' })
  })

  it('passes a custom labelFor through to the tool_result (e.g. an integration hub path)', async () => {
    const streamTurn = async function* (messages: LoopMessage[]): AsyncIterable<Raw> {
      if (!sawToolResult(messages)) {
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
