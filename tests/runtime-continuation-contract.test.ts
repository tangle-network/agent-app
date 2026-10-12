import { describe, expect, it } from 'vitest'
import { streamToolLoop, type ToolLoopMessage } from '@tangle-network/agent-runtime/tool-loop'

// Exercise the installed Runtime artifact, not a replacement loop. Router turns
// depend on both contracts; merely exporting the subpath did not make 0.317 safe.
const history: ToolLoopMessage[] = [
  { role: 'user', content: 'Save one record' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function',
    function: { name: 'save', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call-1', content: 'Saved' },
]
const toolContract = {
  extractText: (text: string) => text,
  extractToolCall: () => null,
  isExecutableTool: () => false,
  executeToolCall: async () => { throw new Error('A settled tool must never run again') },
}

describe('published Runtime continuation contract', () => {
  it('returns the exact settled conversation when the hop deadline has passed', async () => {
    const events = []
    for await (const event of streamToolLoop({ ...toolContract, systemPrompt: 'system',
      priorMessages: history, deadlineMs: Date.now() - 1,
      streamTurn: async function* () { throw new Error('A capped hop must not call a model'); yield '' },
    })) events.push(event)
    expect(events).toEqual([{ kind: 'capped', pending: 0, stopReason: 'deadline', messages: history }])
  })

  it('resumes without appending another user message or replaying the settled tool', async () => {
    const sent: ToolLoopMessage[][] = []
    for await (const _event of streamToolLoop({ ...toolContract, systemPrompt: 'system', priorMessages: history,
      streamTurn: async function* (messages) { sent.push(messages); yield 'Finished' },
    })) { /* the real loop drains its turn */ }
    expect(sent).toEqual([[{ role: 'system', content: 'system' }, ...history]])
  })
})
