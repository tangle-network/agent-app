#!/usr/bin/env node
// The release canary. `pnpm deploy` runs it after `wrangler deploy`; `pnpm canary` runs it again.
//
// It signs in as the canary member and runs two turns on the deployed app, one after the other, each on a new thread:
//   answer    a plain reply from the model;
//   computer  a command only the workspace computer can run: it hashes a fresh nonce, so the digest
//             proves the box ran it. The turn passes only when its `sandbox_run` call completed with
//             that digest and the transcript carries no computer failure.
// It reads each verdict from the persisted transcript, the record a member and an operator read, and
// exits 1 naming the cause when either turn fails, with the computer step's recorded diagnostic.
//
// CANARY_URL       the deployed origin, e.g. https://my-agent.example.workers.dev (required)
// CANARY_EMAIL     the canary member's email (required); the first release signs the member up
// CANARY_PASSWORD  its password (required)
// CANARY_TURN_MS   the budget for each turn, including a cold box (default 300000)

import { createHash, randomBytes, randomUUID } from 'node:crypto'

const base = process.env.CANARY_URL?.trim().replace(/\/+$/, '')
const email = process.env.CANARY_EMAIL?.trim()
const password = process.env.CANARY_PASSWORD
const turnMs = Number(process.env.CANARY_TURN_MS || 300_000)

function refuse(message) {
  console.error(`canary: ${message}`)
  process.exit(1)
}

if (!base || !email || !password) {
  refuse('set CANARY_URL, CANARY_EMAIL and CANARY_PASSWORD; a release with no canary is unverified')
}

async function signIn() {
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body),
  })
  let response = await post('/api/auth/sign-in/email', { email, password })
  // The first release creates the canary member; every later one signs it in.
  if (response.status === 401) response = await post('/api/auth/sign-up/email', { email, password, name: 'Release canary' })
  if (!response.ok) refuse(`sign-in answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  if (!cookie) refuse('sign-in returned no session cookie')
  return cookie
}

async function json(response, what) {
  if (!response.ok) throw new Error(`${what} answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
  return response.json()
}

/** One turn on a new thread, read back from the persisted transcript. */
async function turn(cookie, title, content) {
  const headers = { cookie, 'content-type': 'application/json' }
  const signal = AbortSignal.timeout(turnMs)
  const { thread } = await json(await fetch(`${base}/api/threads`, {
    method: 'POST', headers, body: JSON.stringify({ title }), signal,
  }), 'thread creation')
  const reply = await fetch(`${base}/api/chat`, {
    method: 'POST', headers, body: JSON.stringify({ threadId: thread.id, turnId: randomUUID(), content }), signal,
  })
  if (!reply.ok) throw new Error(`the turn answered ${reply.status}: ${(await reply.text()).slice(0, 300)}`)
  await reply.text()
  // The final assistant row lands as the turn settles, when the user row is marked backendTerminal (src/chat.ts).
  // A computer step that could not be confirmed leaves it unmarked; its row is read after the window anyway.
  const settleBy = Date.now() + 15_000
  for (;;) {
    const { messages } = await json(await fetch(`${base}/api/threads/${encodeURIComponent(thread.id)}/messages`, {
      headers: { cookie }, signal: AbortSignal.timeout(30_000),
    }), 'transcript read')
    const user = messages.filter(message => message.role === 'user').at(-1)
    const assistant = messages.filter(message => message.role === 'assistant').at(-1)
    const late = Date.now() > settleBy
    if (assistant && (user?.backendTerminal || late)) {
      return { threadId: thread.id, assistant, parts: Array.isArray(assistant.parts) ? assistant.parts : [] }
    }
    if (late) throw new Error('no assistant reply was persisted within 15 s of the turn')
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
}

const failureNotice = parts => parts.find(part => part.type === 'notice'
  && (part.noticeKind === 'error' || String(part.code ?? '').startsWith('sandbox_')))

function judgeAnswer({ assistant, parts }) {
  const notice = failureNotice(parts)
  if (notice) return `${notice.code ?? notice.noticeKind}: ${notice.detail ?? notice.text}`
  if (!String(assistant.content ?? '').trim()) return 'the reply is empty'
  return null
}

function judgeComputer({ assistant, parts }, digest) {
  const notice = failureNotice(parts)
  const call = parts.find(part => part.type === 'tool' && part.tool === 'sandbox_run')
  if (notice) return `the computer step failed (${notice.code ?? notice.noticeKind}): ${notice.detail ?? notice.text}`
  if (!call) return `the model answered without a computer step: ${String(assistant.content ?? '').slice(0, 200)}`
  if (call.state?.status !== 'completed') return `the computer step ended ${call.state?.status}: ${call.state?.error ?? ''}`
  if (!JSON.stringify(call.state.output ?? '').includes(digest)) return 'the computer step completed without the command\'s digest'
  return null
}

const nonce = `canary-${randomBytes(16).toString('hex')}`
const digest = createHash('sha256').update(nonce).digest('hex')
const checks = [
  { name: 'answer', title: 'Release canary: answer', judge: judgeAnswer,
    content: 'Release check: reply with one short sentence confirming you can answer.' },
  { name: 'computer', title: 'Release canary: computer', judge: result => judgeComputer(result, digest),
    content: 'Release check: run this exact shell command on the workspace computer with sandbox_run, then reply ' +
      `with only the 64-character hex digest it prints:\nprintf %s '${nonce}' | sha256sum` },
]

const cookie = await signIn()
let failed = false
// One turn at a time: the member's workspace admits one turn, so a second would be refused while the first runs.
for (const check of checks) {
  const started = Date.now()
  let failure
  let threadId
  try {
    const result = await turn(cookie, check.title, check.content)
    threadId = result.threadId
    failure = check.judge(result)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  const ms = Date.now() - started
  const where = threadId ? ` thread=${threadId}` : ''
  console.log(failure ? `canary ${check.name} FAIL ${ms}ms${where}: ${failure}` : `canary ${check.name} PASS ${ms}ms${where}`)
  failed ||= Boolean(failure)
}
process.exit(failed ? 1 : 0)
