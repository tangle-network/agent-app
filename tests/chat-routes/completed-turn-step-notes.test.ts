/**
 * A box turn that worked in steps: tool-only steps, a step that writes a short note before its next tool call, then
 * the answer after the last tool call. Under `reply: 'answer-after-last-tool'` the stored reply is the answer and the
 * note stays in the message as a step note; by default the reply reads as before. The box is stood in at the Sandbox
 * SDK boundary (the turn cache and the session's messages), as the other completed-turn cases do.
 */
import { describe, expect, it } from 'vitest'

import {
  readCompletedSandboxTurn,
  type CompletedSandboxTurnSource,
} from '../../src/chat-routes/index'
import { recoverSandboxAssistantMessage } from '../../src/chat-routes/completed-sandbox-turn'

const NOTE = 'Checked the remaining rows against their sources and found two figures to correct in the earlier draft (a size mapping and a monthly total). Building the merged table now.'
const ANSWER = [
  'Saved and read back: **reports/price-table.md** (revision `a1b2c3d4…`) with 42 rows priced at both sizes, sorted by hourly price, every row carrying its source link and read date.',
  '**Rows added (17):** Provider A $0.036, Provider B $0.017, Provider C $0.088, Provider D $0.104, Provider E $0.13, Provider F $0.28, Provider G $0.252, Provider H $0.20. Two providers moved off the unpriced list once their own pages were read: one publishes exact plan prices, the other was on another domain.',
].join('\n\n')
const turnId = 'turn-fixture-follow-up'
const sessionId = 'session-fixture'

const tool = (n: number, command: string) => ({ id: `prt_tool_${n}`, type: 'tool', tool: 'bash', callID: `call_${n}`,
  state: { status: 'completed', input: { command }, output: 'ok\n' } })
const step = (n: number, ...parts: Record<string, unknown>[]) => [{ id: `prt_start_${n}`, type: 'step-start' }, ...parts,
  { id: `prt_finish_${n}`, type: 'step-finish', tokens: { input: 1000, output: 50, reasoning: 0, cache: { read: 4000, write: 0 } }, cost: 0 }]

const message = {
  id: 'msg_fixture_follow_up', role: 'assistant', timestamp: '2026-01-01T00:00:00.000Z',
  metadata: { turnId, status: 'completed', completed: true },
  parts: [
    { id: 'prt_text_empty', type: 'text', text: '' },
    ...step(1, tool(1, 'cat drafts/partial.md')),
    ...step(2, tool(2, 'curl -sL https://example.test/pricing -o pricing.html')),
    ...step(3, { id: 'prt_text_note', type: 'text', text: NOTE }, tool(3, 'python3 build_table.py')),
    ...step(4, { id: 'prt_text_answer', type: 'text', text: ANSWER }),
  ],
}

function box(response: string): CompletedSandboxTurnSource {
  return {
    findCompletedTurn: async () => ({ turnId, sessionId, completedAt: '2026-01-01T00:00:01.000Z', result: { response } }),
    session: () => ({ messages: async () => [message] }),
  } as unknown as CompletedSandboxTurnSource
}

const reply = 'answer-after-last-tool' as const

describe('a completed box turn that worked in steps', () => {
  it('stores the answer after its last tool call as the reply, and keeps the earlier note as a step note', async () => {
    // The runtime's cached result holds every step's text.
    const read = await readCompletedSandboxTurn(box(`${NOTE}\n\n${ANSWER}`), { turnId, sessionId, reply })
    expect(read?.text).toBe(ANSWER)
    expect(read?.text).not.toContain('Building the merged table now.')
    const texts = read?.parts?.filter((part) => part.type === 'text').map((part) => part.text)
    expect(texts).toEqual([ANSWER])
    expect(read?.parts?.filter((part) => part.type === 'reasoning').map((part) => part.text)).toEqual([NOTE])
    expect(read?.parts?.filter((part) => part.type === 'tool')).toHaveLength(3)
  })

  it('recovers the same answer from the message alone', () => {
    const recovered = recoverSandboxAssistantMessage(message as never, reply)
    expect(recovered.text).toBe(ANSWER)
  })

  it('reads as before unless the consumer turns the rule on', async () => {
    const read = await readCompletedSandboxTurn(box(`${NOTE}\n\n${ANSWER}`), { turnId, sessionId })
    expect(read?.text).toBe(`${NOTE}\n\n${ANSWER}`)
    expect(recoverSandboxAssistantMessage(message as never).text).toContain(NOTE)
  })

  it('keeps the answer when a short closing line follows one more tool call', () => {
    // The whole answer, a tool call that saves it, then a closing line.
    const closing = 'Saved it as a file as well.'
    const closed = { ...message, parts: [...message.parts.slice(0, -3),
      ...step(5, { id: 'prt_text_whole_answer', type: 'text', text: ANSWER }, tool(5, 'cp table.md reports/table.md')),
      ...step(6, { id: 'prt_text_closing', type: 'text', text: closing })] }
    const recovered = recoverSandboxAssistantMessage(closed as never, reply)
    expect(recovered.text).toContain(ANSWER)
    expect(recovered.text).toContain(closing)
    expect(recovered.parts?.filter((part) => part.type === 'reasoning')).toEqual([])
  })

  it('keeps an unfinished run whose last text is a cut-off note as it was', () => {
    // Long progress notes, then a short note after the last tool call that stops mid-sentence.
    const notes = 'Strong reads: one provider rates per physical core, another per machine, a third per vCPU-second. '.repeat(4)
    const cutOff = 'Provider J rate card confirmed ($0.108/CPU-hr, $0.0252/GB-hr). Provider K plans confirmed ($5 and $20 minimums with usage credits'
    const unfinished = { ...message, parts: [...step(1, { id: 'prt_notes', type: 'text', text: notes }, tool(1, 'grep -n rates pricing.txt')),
      ...step(2, { id: 'prt_cut', type: 'text', text: cutOff })] }
    const recovered = recoverSandboxAssistantMessage(unfinished as never, reply)
    expect(recovered.text).toBe(`${notes}${cutOff}`)
  })

  it('leaves a turn with no tool call, or nothing after its last one, as it was', async () => {
    const plain = { ...message, parts: [{ id: 'prt_only', type: 'text', text: ANSWER }] }
    const onlyText = await readCompletedSandboxTurn({
      findCompletedTurn: async () => ({ turnId, sessionId, completedAt: '2026-01-01T00:00:01.000Z', result: { response: ANSWER } }),
      session: () => ({ messages: async () => [plain] }),
    } as unknown as CompletedSandboxTurnSource, { turnId, sessionId })
    expect(onlyText?.text).toBe(ANSWER)
    const endsOnTool = { ...message, parts: message.parts.slice(0, -3) }
    const unfinished = recoverSandboxAssistantMessage(endsOnTool as never)
    expect(unfinished.text).toBe(NOTE)
  })
})
