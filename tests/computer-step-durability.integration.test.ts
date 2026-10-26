import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, it } from 'vitest'
import { createTestHarness } from 'wrangler'
import { createSidecarRuntimePeer, type RuntimeRun } from './helpers/sidecar-runtime-peer'

/**
 * Real local workerd running agent-app's computer step, which keeps no ledger
 * of its own, against the box runtime's protocol over real HTTP
 * (`helpers/sidecar-runtime-peer`). The runtime's detached admission, replay
 * and completed turns are all the durability the step has; each case breaks
 * when the step stops using one of them.
 */
const disk = mkdtempSync(join(tmpdir(), 'computer-step-durability-'))
const root = join(disk, 'vault')
mkdirSync(join(root, 'proof'), { recursive: true })
let mode: 'held' | 'question' = 'held'
const held: Array<() => void> = []
const runtime = createSidecarRuntimePeer({ disk, onRun: (run: RuntimeRun, peer) => {
  const write = (name: string) => {
    const path = join(root, 'proof', `${name}.md`)
    writeFileSync(path, `written by ${run.executionId.slice(0, 12)}\n`)
    return `Saved ${path}`
  }
  if (mode === 'held') held.push(() => peer.finish(run, write(`note-${run.executionId.slice(0, 8)}`)))
  if (mode === 'question') {
    peer.ask(run, { id: `ask-${run.executionId.slice(0, 8)}`, kind: 'question', title: 'Which tone do you prefer?',
      answerSpec: { fields: [{ type: 'select', name: 'q0', label: 'Which tone do you prefer?', required: true, multi: false,
        options: [{ value: 'Formal', label: 'Formal' }, { value: 'Casual', label: 'Casual' }] }] } },
    data => peer.finish(run, `The member chose ${String(data?.q0 ?? 'nothing')}. ${write('tone')}`))
  }
} })
let origin = ''
const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    const url = new URL(request.url!, 'http://peer.local')
    const json = (value: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    if (url.pathname === '/v1/sandboxes/durable-box') return json({ id: 'durable-box', status: 'running', filesystemIncarnationId: 'durable-incarnation',
      filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready', connection: { runtimeUrl: `${origin}/v1/sandboxes/durable-box/runtime` } })
    if (url.pathname === '/v1/backends') return json({ backends: [{ type: 'opencode', capabilities: { interactions: ['question'] } }] })
    const prefix = '/v1/sandboxes/durable-box/runtime'
    if (url.pathname.startsWith(prefix) && runtime.handle(request, response, url.pathname.slice(prefix.length), url, body)) return
    runtime.unknown.push(`${request.method} ${url.pathname}`)
    json({ error: `no local route for ${request.method} ${url.pathname}` }, 404)
  })
})

let worker: ReturnType<typeof createTestHarness>
let base = ''
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  worker = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./workers/computer-step.wrangler.toml', import.meta.url)) }] })
  base = (await worker.listen()).url.toString()
  assert.equal((await fetch(new URL('/proof/seed', base), { method: 'POST', body: JSON.stringify({ peer: origin, root }) })).status, 204)
}, 120_000)
afterAll(async () => {
  for (const release of held.splice(0)) release()
  await (worker as { dispose?(): Promise<void> } | undefined)?.dispose?.()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(disk, { recursive: true, force: true })
})

type StepResult = { answer?: string; error?: { code: unknown; message: string }; emitted: Array<{ kind: string; data?: unknown }> }
const step = async (body: Record<string, unknown>): Promise<StepResult> =>
  (await fetch(new URL('/step', base), { method: 'POST', body: JSON.stringify(body) })).json() as Promise<StepResult>
const vault = async () => (await fetch(new URL('/proof/vault', base))).json() as Promise<Array<{ path: string; content: string }>>
async function until<T>(read: () => T | Promise<T>, label: string, ms = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}; unrouted requests: ${runtime.unknown.join(', ') || 'none'}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

it('keeps a step running after its request was lost, and the reattached call reads its answer without sending again', async () => {
  mode = 'held'
  const live = step({ callId: 'dropped-call', task: 'Write a short note under proof/.' })
  await until(() => held.length, 'the box agent working')
  const run = [...runtime.runs.values()].at(-1)!
  assert.equal((await fetch(new URL('/proof/drop', base), { method: 'POST', body: JSON.stringify({ callId: 'dropped-call' }) })).status, 204)
  const dropped = await live
  assert.ok(dropped.error, `the dropped request must not report an answer: ${JSON.stringify(dropped)}`)
  assert.equal(run.terminal, null, 'the run outlives the request that sent it')
  const sends = runtime.sends.length

  held.shift()!()
  assert.equal(run.terminal, 'completed')
  const reattached = await step({ callId: 'dropped-call', task: 'Write a short note under proof/.' })
  assert.match(reattached.answer ?? JSON.stringify(reattached), /Saved .*proof\/note-.*\.md/)
  assert.match(reattached.answer ?? '', /Workspace vault: the app saved proof\/note-/)
  assert.equal(runtime.sends.length, sends, 'the reattached call sent nothing')
  assert.ok((await vault()).some(file => file.path.startsWith('proof/note-')), 'the reattached call copied the run’s file into the Vault')
}, 90_000)

it('answers a call repeated in flight and after its end from the one run, never sending it twice', async () => {
  mode = 'held'
  const first = step({ callId: 'repeated-call', task: 'Write a short note under proof/.' })
  await until(() => held.length, 'the first send')
  const sends = runtime.sends.length
  const runs = runtime.runs.size
  const second = step({ callId: 'repeated-call', task: 'Write a short note under proof/.' })
  await new Promise(resolve => setTimeout(resolve, 1_500))
  held.shift()!()
  const [a, b] = await Promise.all([first, second])
  assert.ok(a.answer, JSON.stringify(a))
  assert.equal(b.answer, a.answer, JSON.stringify(b))
  const after = await step({ callId: 'repeated-call', task: 'Write a short note under proof/.' })
  assert.equal(after.answer, a.answer)
  assert.equal(runtime.runs.size, runs, 'one run for the one call')
  assert.equal(runtime.sends.length, sends, 'a repeated call, in flight or settled, sends nothing')
}, 90_000)

it('relays the box agent’s question to the member and finishes with the member’s answer', async () => {
  mode = 'question'
  const live = step({ callId: 'question-call', questions: true, task: 'Ask the member which tone to use, then note it.' })
  const asking = await until(() => [...runtime.runs.values()].find(run => run.question), 'the box agent asking')
  const question = asking.question!
  const listed = await (await fetch(new URL('/interactions', base))).json() as { interactions: Array<{ id: string }> }
  assert.deepEqual(listed.interactions.map(value => value.id), [question.id])
  const answered = await fetch(new URL('/interactions', base), { method: 'POST',
    body: JSON.stringify({ id: question.id, outcome: 'accepted', data: { q0: 'Casual' } }) })
  assert.equal(answered.status, 200, await answered.clone().text())
  const result = await live
  assert.match(result.answer ?? JSON.stringify(result), /The member chose Casual/)
  const relayed = result.emitted.find(event => event.kind === 'computer_interaction') as { data?: { data?: { request?: { id?: string } } } } | undefined
  assert.ok(relayed, `the question must stream to the turn: ${JSON.stringify(result.emitted)}`)
  assert.equal(relayed.data?.data?.request?.id, question.id)
}, 90_000)
