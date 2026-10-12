/**
 * LIVE proof that a gpt-6 turn through the engine streams its reasoning
 * summary to the chat route delta by delta, and persists it in the shared
 * reasoning part shape.
 *
 * OpenAI models return reasoning only as Responses API summaries;
 * `runRouterTurn` takes the Responses turn for an OpenAI model asked to reason.
 * This drives that path end to end through `createRouterTurnProducer`, the
 * producer behind `createChatTurnRoutes`, and records when each reasoning delta
 * arrived, so "streamed" is a measurement, not an assumption.
 *
 * Skipped unless `LIVE_ROUTER=1` and `TANGLE_ROUTER_API_KEY` are set:
 *
 *   LIVE_ROUTER=1 TANGLE_ROUTER_API_KEY=… \
 *     pnpm vitest run tests/chat-routes/router-reasoning.live.test.ts
 *
 * `LIVE_REASONING_MODELS` (comma-separated, default `gpt-6-luna`) picks the
 * models; `LIVE_PROOF_OUT` names a file for the JSON record of each turn.
 */
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { createRouterTurnProducer } from '../../src/chat-routes/index'
import { chatReasoningFromParts } from '../../src/web-react/chat-stream'

const KEY = process.env.TANGLE_ROUTER_API_KEY ?? ''
const LIVE = process.env.LIVE_ROUTER === '1' && KEY.length > 0
const MODELS = (process.env.LIVE_REASONING_MODELS ?? 'gpt-6-luna').split(',').map(model => model.trim()).filter(Boolean)
const PROMPT = 'A hotel has 12 rooms. 5 are occupied, 2 are being cleaned, and 1 failed inspection. ' +
  'How many rooms can take a guest tonight? Think it through, then answer in one sentence.'

describe.skipIf(!LIVE)('live: gpt-6 reasoning streams through the engine', () => {
  const records: unknown[] = []

  for (const model of MODELS) {
    it(`streams ${model}'s reasoning summary delta by delta before the answer, and persists it timed`, async () => {
      const started = Date.now()
      const producer = createRouterTurnProducer({
        apiKey: KEY, model, reasoningEffort: 'medium', maxCompletionTokens: 2_000,
        systemPrompt: 'You are a concise operations assistant.', userMessage: PROMPT,
      })
      const arrivals: Array<{ type: string; atMs: number; chars: number }> = []
      for await (const event of producer.stream) {
        const chars = 'text' in event && typeof event.text === 'string' ? event.text.length : 0
        arrivals.push({ type: event.type, atMs: Date.now() - started, chars })
      }
      const reasoning = arrivals.filter(event => event.type === 'reasoning')
      const firstText = arrivals.find(event => event.type === 'text')
      const parts = producer.assistantParts!()
      const saved = chatReasoningFromParts(parts)
      const record = {
        model,
        servedModel: producer.model,
        reasoningDeltas: reasoning.length,
        reasoningChars: reasoning.reduce((sum, event) => sum + event.chars, 0),
        firstReasoningMs: reasoning[0]?.atMs ?? null,
        lastReasoningMs: reasoning.at(-1)?.atMs ?? null,
        distinctReasoningArrivalMs: new Set(reasoning.map(event => event.atMs)).size,
        reasoningArrivalMs: reasoning.map(event => event.atMs),
        firstTextMs: firstText?.atMs ?? null,
        totalMs: Date.now() - started,
        usage: producer.usage!(),
        savedReasoning: saved ? { chars: saved.text.length, thoughtMs: saved.endedAt! - saved.startedAt!, thinking: saved.thinking } : null,
        persistedReasoningParts: parts.filter(part => part.type === 'reasoning').map(part => ({ chars: String(part.text).length, time: part.time })),
        answer: producer.finalText(),
      }
      records.push(record)
      if (process.env.LIVE_PROOF_OUT) writeFileSync(process.env.LIVE_PROOF_OUT, `${JSON.stringify(records, null, 2)}\n`)

      expect(arrivals.find(event => event.type === 'error')).toBeUndefined()
      // Streamed: several deltas, arriving at different moments, all before the answer's first word.
      expect(reasoning.length).toBeGreaterThan(1)
      expect(record.distinctReasoningArrivalMs).toBeGreaterThan(1)
      expect(firstText).toBeDefined()
      expect(record.lastReasoningMs!).toBeLessThanOrEqual(firstText!.atMs)
      // Persisted in the shared shape, read back settled with how long the model thought.
      expect(parts[0]).toMatchObject({ type: 'reasoning', time: { start: expect.any(Number), end: expect.any(Number) } })
      expect(saved).toMatchObject({ thinking: false, startedAt: expect.any(Number), endedAt: expect.any(Number) })
      expect(saved!.endedAt!).toBeGreaterThan(saved!.startedAt!)
    }, 120_000)
  }
})
