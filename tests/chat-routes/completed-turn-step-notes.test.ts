/**
 * A box turn that worked in steps stores its answer as the reply, not the notes it wrote between tool calls.
 *
 * Recorded turn: GTM Agent's research follow-up in thread 5341310c on 2026-11-23 (turn fbf47919, production
 * `turn_events`). Its box message ran 13 tool-only steps, then a step that wrote a note before its next tool call,
 * then the answer after the last tool call. The reply GTM stored began with that note: "All 17 new providers
 * verified ... Building the 42-row merge now." then the answer (2,843 characters). The parts and texts below are
 * that message's, in its order, shortened to two tool-only steps and the answer's first two paragraphs. The box is
 * stood in at the Sandbox SDK boundary (the turn cache and the session's messages), as the other completed-turn
 * cases do; the reading itself is agent-app's.
 */
import { describe, expect, it } from 'vitest'

import {
  readCompletedSandboxTurn,
  type CompletedSandboxTurnSource,
} from '../../src/chat-routes/index'
import { recoverSandboxAssistantMessage } from '../../src/chat-routes/completed-sandbox-turn'

const NOTE = "All 17 new providers verified against their own pages \u2014 and re-verification caught two more wrong figures in the partial (Namespace's shape mapping and Agent37's Shape B). Building the 42-row merge now."
const ANSWER = "Saved and read back: **research/sandbox-provider-price-table.md** (revision `19285469\u2026`) \u2014 **42 providers priced** at both shapes, sorted by hourly price, every row carrying its own-page source and read date (the 17 new rows all read 2026-11-23 this pass).\n\n**Rows added (17):** boat $0.036, Agent37 $0.017, Beam $0.088, machine0 $0.104, Northflank $0.13, Docker Sandboxes $0.28, DO Harness Runtime $0.252, Upstash Box $0.20, Microsandbox $0.2185, Novita $0.2333, Freestyle $0.2645, Hopx $0.3355, Fly Sprites $0.3563, Namespace, Tensorlake $0.408, Blaxel $0.3312, Baseten $0.4308. Fargate now cites AWS's own page alongside the Price List API. Northflank and Blaxel moved off the unpriceable list \u2014 you were right on both: Northflank publishes exact-shape plans ($96/mo for 4 vCPU/8 GB) plus its $0.00833/GB-h memory rate, and Blaxel is priced at blaxel.ai (the 502 was the wrong domain)."
const turnId = 'gtm-follow-up-7eafbcff896e3b4d270c09a46158bf4733294401113c3a0ff99560f21fa982c0'
const sessionId = '5341310c681f806a85b00190de11e120'

const tool = (n: number, command: string) => ({ id: `prt_tool_${n}`, type: 'tool', tool: 'bash', callID: `call_${n}`,
  state: { status: 'completed', input: { command }, output: 'ok\n' } })
const step = (n: number, ...parts: Record<string, unknown>[]) => [{ id: `prt_start_${n}`, type: 'step-start' }, ...parts,
  { id: `prt_finish_${n}`, type: 'step-finish', tokens: { input: 1000, output: 50, reasoning: 0, cache: { read: 64000, write: 0 } }, cost: 0 }]

const message = {
  id: 'msg_recorded_follow_up', role: 'assistant', timestamp: '2026-11-23T01:28:40.000Z',
  metadata: { turnId, status: 'completed', completed: true },
  parts: [
    { id: 'prt_text_empty', type: 'text', text: '' },
    ...step(1, tool(1, 'ls /tmp/prices/build_table.py && gtm vault read drafts/partial/5341310c.md')),
    ...step(2, tool(2, 'cd /tmp/prices && curl -sL https://docs.boat.dev/pricing.md -o boat.md')),
    ...step(3, { id: 'prt_text_note', type: 'text', text: NOTE }, tool(3, "cd /tmp/prices && python3 build_table2.py")),
    ...step(4, { id: 'prt_text_answer', type: 'text', text: ANSWER }),
  ],
}

function box(response: string): CompletedSandboxTurnSource {
  return {
    findCompletedTurn: async () => ({ turnId, sessionId, completedAt: '2026-11-23T01:28:43.272Z', result: { response } }),
    session: () => ({ messages: async () => [message] }),
  } as unknown as CompletedSandboxTurnSource
}

const reply = 'answer-after-last-tool' as const

describe('a completed box turn that worked in steps', () => {
  it('stores the answer after its last tool call as the reply, and keeps the earlier note as a step note', async () => {
    // The runtime's cached result holds every step's text, as the stored reply did.
    const read = await readCompletedSandboxTurn(box(`${NOTE}\n\n${ANSWER}`), { turnId, sessionId, reply })
    expect(read?.text).toBe(ANSWER)
    expect(read?.text).not.toContain('Building the 42-row merge now.')
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
    // The shape the lead named: the whole answer, a tool call that saves it, then a closing line.
    const closing = 'Saved it to the Vault as well.'
    const closed = { ...message, parts: [...message.parts.slice(0, -3),
      ...step(5, { id: 'prt_text_whole_answer', type: 'text', text: ANSWER }, tool(5, 'gtm vault write research/table.md')),
      ...step(6, { id: 'prt_text_closing', type: 'text', text: closing })] }
    const recovered = recoverSandboxAssistantMessage(closed as never, reply)
    expect(recovered.text).toContain(ANSWER)
    expect(recovered.text).toContain(closing)
    expect(recovered.parts?.filter((part) => part.type === 'reasoning')).toEqual([])
  })

  it('keeps an unfinished run whose last text is a cut-off note as it was', () => {
    // Recorded 9c3a63c1 (2026-11-22): 2,212 characters of notes, then 185 after the last tool call, cut off mid-word.
    const notes = 'Strong reads: Modal sandbox rate per physical core, Fly per-machine prices, Railway per vCPU-second. '.repeat(4)
    const cutOff = "Runloop's full rate card confirmed ($0.108/CPU-hr, $0.0252/GB-hr). Railway plans confirmed ($5 Hobby / $20 Pro minimums with usage credits"
    const unfinished = { ...message, parts: [...step(1, { id: 'prt_notes', type: 'text', text: notes }, tool(1, 'rg -N rates render.txt')),
      ...step(2, { id: 'prt_cut', type: 'text', text: cutOff })] }
    const recovered = recoverSandboxAssistantMessage(unfinished as never, reply)
    expect(recovered.text).toBe(`${notes}${cutOff}`)
  })

  it('leaves a turn with no tool call, or nothing after its last one, as it was', async () => {
    const plain = { ...message, parts: [{ id: 'prt_only', type: 'text', text: ANSWER }] }
    const onlyText = await readCompletedSandboxTurn({
      findCompletedTurn: async () => ({ turnId, sessionId, completedAt: '2026-11-23T01:28:43.272Z', result: { response: ANSWER } }),
      session: () => ({ messages: async () => [plain] }),
    } as unknown as CompletedSandboxTurnSource, { turnId, sessionId })
    expect(onlyText?.text).toBe(ANSWER)
    const endsOnTool = { ...message, parts: message.parts.slice(0, -3) }
    const unfinished = recoverSandboxAssistantMessage(endsOnTool as never)
    expect(unfinished.text).toBe(NOTE)
  })
})
