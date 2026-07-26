/**
 * LIVE PROBE (not an assertion): ask a real box to run a one-word turn on each
 * candidate model and print the VERBATIM terminal event, plus how
 * `isUpstreamUnavailable` classifies it.
 *
 * This is the ground-truth step that keeps the failover tests honest — the
 * payload shapes they assert against are captured here, never invented, and it
 * re-answers "which models are actually dead right now" instead of trusting a
 * list that was true yesterday.
 *
 *   LIVE_SANDBOX=1 SANDBOX_API_KEY=… LIVE_BOX_ID=sandbox-… \
 *     pnpm vitest run tests/chat-routes/model-probe.live.test.ts
 */

import { describe, it } from 'vitest'
import { SandboxClient } from '@tangle-network/sandbox'

import { isUpstreamUnavailable } from '../../src/model-resolution/failover'
import { classifyTerminalFailure } from '../../src/chat-routes/model-failover-stream'

const LIVE = process.env.LIVE_SANDBOX === '1' && Boolean(process.env.SANDBOX_API_KEY)
const CANDIDATES = (
  process.env.LIVE_PROBE_MODELS ??
  'claude-sonnet-4-6,claude-opus-4-8,claude-haiku-4-5,gemini-2.5-pro,gemini-2.5-flash,gpt-5,gpt-5-mini,minimax-m3,deepseek-chat'
).split(',')

describe.skipIf(!LIVE)('LIVE PROBE: per-model terminal event shapes', () => {
  it(
    'prints the verbatim terminal event and its classification for each candidate',
    async () => {
      const client = new SandboxClient({
        apiKey: process.env.SANDBOX_API_KEY!,
        baseUrl: process.env.SANDBOX_API_URL ?? 'https://sandbox.tangle.tools',
      })
      const reuseId = process.env.LIVE_BOX_ID
      const box = reuseId
        ? (await client.get(reuseId))!
        : await client.create({ name: `agent-app-probe-${Date.now()}`.slice(0, 63) })
      console.log(`[probe] box ${box.id}`)

      for (const model of CANDIDATES) {
        let terminal: unknown
        let text = ''
        let threw: string | undefined
        try {
          const stream = box.streamPrompt('Reply with the single word: ok', {
            model,
            sessionId: `probe-${model.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}`,
          }) as AsyncIterable<unknown>
          for await (const ev of stream) {
            const e = ev as { type?: string; data?: Record<string, unknown> }
            if (e.type === 'error' || e.type === 'session.run.failed') terminal = ev
            if (e.type === 'message.part.updated') {
              const part = (e.data?.part ?? {}) as { type?: string; text?: string }
              if (part.type === 'text' && part.text) text = part.text
            }
          }
        } catch (err) {
          threw = err instanceof Error ? err.message : String(err)
        }

        const classified = terminal ? classifyTerminalFailure(terminal) : null
        console.log(
          `\n[probe] ${model}\n` +
            `  answered : ${JSON.stringify(text.slice(0, 60))}\n` +
            `  threw    : ${threw ? JSON.stringify(threw.slice(0, 200)) : '-'}\n` +
            `  terminal : ${terminal ? JSON.stringify(terminal).slice(0, 500) : '-'}\n` +
            `  outage?  : ${classified ? classified.outage : threw ? isUpstreamUnavailable(new Error(threw)) : '-'}`,
        )
      }
    },
    900_000,
  )
})
