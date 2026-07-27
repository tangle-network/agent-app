/**
 * NIGHTLY LIVE E2E — the one test that runs a REAL sandbox chat turn against
 * real infrastructure, end to end, on a schedule.
 *
 * Every other test in this repo asserts against a fake, a fixture, or a
 * captured frame. That is why the failures this repo actually shipped were all
 * green in CI: 2,416 passing tests certified a streaming lane that delivered
 * nothing, and a production model substitution ran 27+ hours without a single
 * layer noticing. A suite can only catch what its fixtures already believe.
 * This one asks the platform.
 *
 * Design rule: **the failure has to be readable at 3am from the Actions log
 * alone.** No bare exit codes, no `expected true to be false`. Every step is
 * timed and named as it happens, so an interrupted run says which step it died
 * in, and the report prints the box id, the requested model, whatever model the
 * platform says served the turn, and the last raw events — the exact facts that
 * cost a night of debugging when they were missing.
 *
 * Skipped unless `LIVE_SANDBOX=1` and `SANDBOX_API_KEY` are set. Run by hand:
 *
 *   LIVE_SANDBOX=1 SANDBOX_API_KEY=… SANDBOX_API_URL=https://sandbox.tangle.tools \
 *     LIVE_MODEL=gpt-5-mini pnpm vitest run tests/live/nightly-chat-turn.live.test.ts
 */

import { describe, expect, it } from 'vitest'
import { Sandbox } from '@tangle-network/sandbox'

import {
  createChatTurnRoutes,
  createSandboxChatProducer,
  type ChatTurnMessageStore,
} from '../../src/chat-routes/index'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { openDatabase, workspacesTable } from '../teams/db-helper'

const LIVE = process.env.LIVE_SANDBOX === '1' && Boolean(process.env.SANDBOX_API_KEY)
const REQUESTED_MODEL = process.env.LIVE_MODEL ?? 'gpt-5-mini'
const BASE_URL = process.env.SANDBOX_API_URL ?? 'https://sandbox.tangle.tools'

const tables = createChatTables({ workspaceTable: workspacesTable })

/** One named unit of work. `end`/`fail` are called by the runner, so a step
 *  left `running` when the process dies is itself the diagnosis. */
interface Step {
  name: string
  startedAt: number
  ms?: number
  status: 'running' | 'ok' | 'FAILED'
  detail?: string
}

class Runner {
  readonly steps: Step[] = []
  /** Facts worth printing whether the run passes or fails. */
  readonly facts: Record<string, unknown> = {}

  async step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const step: Step = { name, startedAt: Date.now(), status: 'running' }
    this.steps.push(step)
    console.log(`[nightly] ▶ ${name}`)
    try {
      const value = await fn()
      step.ms = Date.now() - step.startedAt
      step.status = 'ok'
      console.log(`[nightly] ✔ ${name} (${step.ms}ms)`)
      return value
    } catch (err) {
      step.ms = Date.now() - step.startedAt
      step.status = 'FAILED'
      step.detail = err instanceof Error ? err.message : String(err)
      console.log(`[nightly] ✖ ${name} (${step.ms}ms): ${step.detail}`)
      throw err
    }
  }

  report(): string {
    const rows = this.steps
      .map((s) => {
        const status = s.status === 'ok' ? 'ok    ' : s.status === 'running' ? 'RUNNING' : 'FAILED'
        const ms = s.ms === undefined ? '   —' : `${s.ms}ms`
        return `  ${status}  ${ms.padStart(8)}  ${s.name}${s.detail ? `\n            ${s.detail}` : ''}`
      })
      .join('\n')
    const facts = Object.entries(this.facts)
      .map(([k, v]) => `  ${k.padEnd(18)} ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n')
    return `\n=== nightly live e2e ===\nfacts:\n${facts}\nsteps:\n${rows}\n`
  }
}

/**
 * Deep-scan an event for any field that names a model. The platform's receipt
 * shape is not a contract this repo owns, and the model-substitution incident
 * was invisible precisely because nobody was reading it — so this looks
 * everywhere rather than at one guessed path, and reports what it found.
 */
function collectModelStrings(value: unknown, into = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || value === null || typeof value !== 'object') return into
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(model|model_?id|modelName|served_?model|providerModel)$/i.test(key) && typeof child === 'string' && child) {
      into.add(child)
    }
    collectModelStrings(child, into, depth + 1)
  }
  return into
}

/** Model ids are spelled differently by layer (`gpt-5-mini`, `openai/gpt-5-mini`,
 *  `gpt-5-mini-2026-01-01`). Compare on the last path segment's stem so a
 *  legitimate qualifier is not reported as a substitution. */
function sameModelFamily(a: string, b: string): boolean {
  const stem = (m: string) => m.toLowerCase().split('/').pop()!.replace(/[@:].*$/, '')
  const [x, y] = [stem(a), stem(b)]
  return x === y || x.startsWith(y) || y.startsWith(x)
}

describe.skipIf(!LIVE)('NIGHTLY LIVE E2E: one real sandbox chat turn', () => {
  it(
    'provisions a real box, streams a real turn through the real chat vertical, and persists a real answer',
    async () => {
      const runner = new Runner()
      runner.facts.baseUrl = BASE_URL
      runner.facts.requestedModel = REQUESTED_MODEL
      runner.facts.startedAt = new Date().toISOString()

      const rawEvents: unknown[] = []
      let box: Awaited<ReturnType<Sandbox['create']>> | undefined

      try {
        const client = await runner.step('connect sandbox client', () => {
          return new Sandbox({ apiKey: process.env.SANDBOX_API_KEY!, baseUrl: BASE_URL })
        })

        box = await runner.step('provision box (or reuse LIVE_BOX_ID)', async () => {
          const reuseId = process.env.LIVE_BOX_ID
          if (reuseId) {
            const existing = await client.get(reuseId)
            if (!existing) throw new Error(`LIVE_BOX_ID ${reuseId} not found on ${BASE_URL}`)
            return existing
          }
          return client.create({ name: `agent-app-nightly-${Date.now()}`.slice(0, 63) })
        })
        runner.facts.boxId = box.id
        runner.facts.boxStatus = String(box.status)
        runner.facts.boxReused = Boolean(process.env.LIVE_BOX_ID)

        const { store, threadId } = await runner.step('open durable chat store', async () => {
          const db = openDatabase([
            workspacesTable,
            tables.threads,
            tables.messages,
          ]) as unknown as ChatDatabase
          await db.insert(workspacesTable).values([{ id: 'ws1', organizationId: 'org1', name: 'WS' }])
          const s = createChatStore(db, tables)
          const thread = await s.createThread({ workspaceId: 'ws1', title: 'nightly' })
          return { store: s, threadId: thread.id }
        })

        const pending: Promise<unknown>[] = []
        let producer: ReturnType<typeof createSandboxChatProducer> | undefined
        const routes = createChatTurnRoutes({
          projectId: 'agent-app-nightly',
          authorize: async () => ({ ok: true, tenantId: 'ws1', userId: 'u1', context: undefined }),
          store: store as unknown as ChatTurnMessageStore,
          turnStore: createMemoryTurnEventStore(),
          produce: () => {
            const source = box!.streamPrompt(
              'Reply with exactly this sentence and nothing else: The nightly end-to-end check is alive.',
              { model: REQUESTED_MODEL, sessionId: threadId },
            ) as AsyncIterable<unknown>
            producer = createSandboxChatProducer({
              events: (async function* tap() {
                for await (const ev of source) {
                  // Bounded tail: enough to diagnose, small enough to read.
                  rawEvents.push(ev)
                  if (rawEvents.length > 400) rawEvents.shift()
                  yield ev
                }
              })(),
              model: REQUESTED_MODEL,
            })
            return producer
          },
          log: () => {},
        })

        const body = await runner.step('stream one real turn to completion', async () => {
          const res = await routes.turn(
            new Request('http://live.test/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ threadId, content: 'nightly liveness check' }),
            }),
            { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
          )
          if (!res.body) throw new Error(`turn route returned no body (status ${res.status})`)
          const text = await new Response(res.body).text()
          await Promise.all(pending)
          return text
        })
        runner.facts.ndjsonBytes = body.length
        runner.facts.rawEventCount = rawEvents.length

        const served = [...collectModelStrings(rawEvents)]
        runner.facts.servedModelsSeen = served.length > 0 ? served : 'NOT REPORTED BY PLATFORM'

        const answer = await runner.step('read the persisted assistant row', async () => {
          const rows = (await store.listMessages(threadId)) as unknown as Array<{
            role: string
            content: string
            model: string | null
          }>
          const assistant = rows.find((r) => r.role === 'assistant')
          if (!assistant) {
            throw new Error(
              `no assistant row persisted — the turn produced ${rawEvents.length} raw events and ${body.length} NDJSON bytes`,
            )
          }
          return assistant
        })
        runner.facts.answerChars = answer.content.length
        runner.facts.answerPreview = answer.content.slice(0, 200)
        runner.facts.rowModel = answer.model ?? '(none)'

        await runner.step('assert the turn actually answered', () => {
          if (answer.content.trim().length === 0) {
            throw new Error(
              'the turn completed with an EMPTY answer — this is the silent-failure class: ' +
                `${rawEvents.length} raw events arrived and none carried text. ` +
                `Last event: ${JSON.stringify(rawEvents.at(-1)).slice(0, 600)}`,
            )
          }
        })

        await runner.step('assert the model that served matches the model requested', () => {
          if (served.length === 0) {
            // Measured, not assumed: a full key-walk over a real turn's events
            // (9 event types, 47 distinct keys) found no model or provider
            // field anywhere. Positive verification is therefore impossible on
            // this lane, which is why the negative control below exists.
            console.log(
              `[nightly] NOTE: no model field found in ${rawEvents.length} raw events — ` +
                'positive served-model verification is UNAVAILABLE on this lane. ' +
                'The impossible-model control below is what covers it.',
            )
            return
          }
          const mismatched = served.filter((m) => !sameModelFamily(m, REQUESTED_MODEL))
          if (mismatched.length > 0) {
            throw new Error(
              `MODEL SUBSTITUTION: requested ${REQUESTED_MODEL} but the platform reported ${JSON.stringify(mismatched)} ` +
                `(all model strings seen: ${JSON.stringify(served)}). ` +
                'A box that silently serves a different model than the one asked for invalidates every downstream quality number.',
            )
          }
        })

        // NEGATIVE CONTROL — the only model check available when the turn
        // stream names no model.
        //
        // Ask the SAME box for a model id that cannot exist. Exactly one of two
        // things may happen for the box to be trustworthy: the run fails, or it
        // produces no answer. If instead it cheerfully answers, the box is not
        // honoring the `model` parameter at all — and then every model
        // attribution the product records, every A/B between models, and every
        // per-model quality number is fiction.
        //
        // This is not hypothetical. Run on production 2026-07-27, requesting
        // `totally-not-a-real-model-xyz123` returned the exact expected
        // sentence in 12.5s across 72 events with no error of any kind.
        const control = await runner.step('negative control: request an impossible model id', async () => {
          const impossible = `nightly-control-no-such-model-${Date.now()}`
          let text = ''
          let errored: string | undefined
          try {
            const stream = box!.streamPrompt(
              'Reply with exactly this sentence and nothing else: The nightly end-to-end check is alive.',
              { model: impossible, sessionId: `${threadId}-control` },
            ) as AsyncIterable<unknown>
            for await (const ev of stream) {
              const e = ev as { type?: string; data?: Record<string, unknown> }
              if (e.type === 'error' || e.type === 'session.run.failed') {
                errored = JSON.stringify(e).slice(0, 300)
              }
              if (e.type === 'message.part.updated') {
                const part = (e.data?.part ?? {}) as { type?: string; text?: string }
                if (part.type === 'text' && part.text) text = part.text
              }
            }
          } catch (err) {
            errored = err instanceof Error ? err.message : String(err)
          }
          return { impossible, text, errored }
        })
        runner.facts.controlAnswered = control.text.length > 0
        runner.facts.controlError = control.errored ?? '(none)'

        await runner.step('assert the box honors the requested model', () => {
          if (control.text.trim().length > 0 && !control.errored) {
            throw new Error(
              `MODEL PASSTHROUGH BROKEN: the box answered a request for "${control.impossible}", ` +
                `a model id that cannot exist, with ${control.text.length} characters and no error. ` +
                `Answer: ${JSON.stringify(control.text.slice(0, 120))}. ` +
                'The box is serving some other model and reporting nothing, so no model attribution from this platform ' +
                `can be trusted — including the "${REQUESTED_MODEL}" recorded on this run's durable row.`,
            )
          }
        })

        console.log(runner.report())
      } catch (err) {
        // The report is the artifact. Print it BEFORE rethrowing so it survives
        // even when vitest truncates the assertion output.
        console.log(runner.report())
        console.log(
          `[nightly] last raw events:\n${rawEvents
            .slice(-6)
            .map((e, i) => `  [-${rawEvents.slice(-6).length - i}] ${JSON.stringify(e).slice(0, 400)}`)
            .join('\n')}`,
        )
        throw err
      } finally {
        if (box && !process.env.LIVE_BOX_ID) await box.delete().catch(() => {})
      }

      expect(runner.steps.every((s) => s.status === 'ok')).toBe(true)
    },
    900_000,
  )
})
