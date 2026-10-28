/**
 * The conformance turns, run through the operator API every agent app mounts the same way
 * (docs/operator-api.md), so one runner drives every product. The verdict is the settled turn the app stored.
 *
 *   plain     a reply with text;
 *   computer  a turn only the workspace computer can answer: either the digest of a fresh nonce, which the model
 *             cannot know without running the command, or a file the computer saves that the app then serves back.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createOperatorClient, type OperatorClient } from '../operator/client.js'
import type { OperatorTurn, OperatorWorkspace } from '../operator/contract.js'
import { Failure, type MemberSession } from './session.js'

export type ComputerProof = 'digest' | 'file'

const REQUEST_MS = 30_000
const KEY_LIFETIME_MS = 60 * 60_000

export interface OperatorAccess {
  client: OperatorClient
  workspace: OperatorWorkspace
  /** The app's own account of what the key may do. */
  scopes: readonly string[]
}

/** An expiring key for the signed-in member, through the route every app's API access page uses. */
export async function mintKey(session: MemberSession): Promise<{ id: string; key: string }> {
  const response = await session.fetch('/api/keys', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(REQUEST_MS),
    body: JSON.stringify({
      name: `conformance ${new Date().toISOString()}`, scopes: ['operator:read', 'operator:run'],
      expiresAt: new Date(Date.now() + KEY_LIFETIME_MS).toISOString(), workspaceIds: [],
    }),
  })
  if (response.status === 404) {
    throw new Failure('the app has no key route (POST /api/keys answered 404), so a conformance turn has no credential; give it an operator key')
  }
  const body = await response.json().catch(() => null) as { id?: unknown; key?: unknown; error?: unknown } | null
  if (!response.ok || typeof body?.id !== 'string' || typeof body.key !== 'string') {
    throw new Failure(`POST /api/keys answered ${response.status}: ${typeof body?.error === 'string' ? body.error.slice(0, 160) : 'no key in the response'}`)
  }
  return { id: body.id, key: body.key }
}

/** Revokes a key this run created. Apps accept the id in the path, or in the body of the collection route. */
export async function revokeKey(session: MemberSession, id: string): Promise<void> {
  const byPath = await session.fetch(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(REQUEST_MS) })
  if (byPath.ok) return
  const byBody = await session.fetch('/api/keys', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(REQUEST_MS),
  })
  if (byBody.ok) return
  throw new Failure(`the minted key ${id} was not revoked: DELETE /api/keys/:id answered ${byPath.status}, DELETE /api/keys ${byBody.status} (it expires within the hour)`)
}

/**
 * Opens the operator API with `key` and picks the workspace the turns run in: `workspace` is its id or exact name,
 * and omitted, the key must reach exactly one. `requestMs` bounds any one request, a held turn read included.
 */
export async function openOperatorAccess(
  { origin, key, workspace, requestMs }: { origin: string; key: string; workspace: string | undefined; requestMs: number },
): Promise<OperatorAccess> {
  const client = createOperatorClient({
    origin,
    getApiKey: () => key,
    fetchImpl: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(requestMs)]) : AbortSignal.timeout(requestMs) }),
  })
  const described = await client.describe()
  if (!described.succeeded) throw new Failure(`GET /api/operator/v1 answered ${described.status} ${described.code}: ${described.error.slice(0, 160)}`)
  const scopes = described.value.principal.scopes
  const missing = ['operator:read', 'operator:run'].filter(scope => !scopes.includes(scope) && !scopes.includes('*'))
  if (missing.length) throw new Failure(`the operator key lacks ${missing.join(' and ')}`)
  const listed = await client.listWorkspaces()
  if (!listed.succeeded) throw new Failure(`GET /api/operator/v1/workspaces answered ${listed.status} ${listed.code}: ${listed.error.slice(0, 160)}`)
  const chosen = workspace
    ? listed.value.filter(candidate => candidate.id === workspace || candidate.name === workspace)
    : listed.value.length === 1 ? listed.value : []
  if (chosen.length !== 1) {
    const names = listed.value.slice(0, 12).map(candidate => `${candidate.name} (${candidate.id.slice(0, 8)})`).join(', ')
    throw new Failure(workspace
      ? `${chosen.length} of the key's ${listed.value.length} workspaces match "${workspace}": ${names}`
      : `the key reaches ${listed.value.length} workspaces; name the canary workspace: ${names}`)
  }
  return { client, workspace: chosen[0]!, scopes }
}

const reply = (turn: OperatorTurn) => (turn.reply?.content ?? '').trim()

/** One turn on a new thread, followed until it settles. */
async function runTurn(access: OperatorAccess, title: string, content: string, turnMs: number, model?: string): Promise<{ turn: OperatorTurn; where: string }> {
  const turnId = randomUUID()
  const started = await access.client.startTurn(access.workspace.id, { turnId, content, title, ...(model ? { model } : {}) })
  if (!started.succeeded) throw new Failure(`the turn was refused: ${started.status} ${started.code}: ${started.error.slice(0, 200)}`)
  const where = `thread ${started.value.threadId}`
  const settled = await access.client.waitForTurn(access.workspace.id, started.value.threadId, started.value.turnId, { timeoutMs: turnMs })
  if (!settled.succeeded) throw new Failure(`reading the turn answered ${settled.status} ${settled.code}: ${settled.error.slice(0, 160)} (${where})`)
  const turn = settled.value
  if (turn.state === 'failed') throw new Failure(`the turn failed${turn.failure?.code ? ` (${turn.failure.code})` : ''}: ${(turn.failure?.message ?? 'no message').slice(0, 300)} (${where})`)
  if (turn.state === 'input-required' || turn.approvals.length > 0) throw new Failure(`the turn is waiting on a decision, which no one can answer in a conformance run (${where})`)
  if (turn.state !== 'succeeded') throw new Failure(`the turn had not settled after ${Math.round(turnMs / 1000)} s (state ${turn.state}; ${where})`)
  return { turn, where }
}

export async function plainTurn(access: OperatorAccess, turnMs: number): Promise<string> {
  const { turn, where } = await runTurn(access, 'Conformance: plain turn',
    'Conformance check: reply with one short sentence confirming you can answer.', turnMs)
  if (!reply(turn)) throw new Failure(`the turn succeeded with an empty reply (${where})`)
  return `${reply(turn).length} characters from ${turn.model ?? 'an unreported model'} (${where})`
}

export async function computerTurn(access: OperatorAccess, turnMs: number, proof: ComputerProof, fileDir: string, model: string): Promise<string> {
  const nonce = `conformance-${randomBytes(12).toString('hex')}`
  if (proof === 'digest') {
    const digest = createHash('sha256').update(nonce).digest('hex')
    const { turn, where } = await runTurn(access, 'Conformance: computer turn',
      'Conformance check: run this exact shell command on the workspace computer (sandbox_run when you have it), then reply with only '
      + `the 64-character hex digest it prints:\nprintf %s '${nonce}' | sha256sum`, turnMs, model)
    if (!reply(turn).includes(digest)) {
      throw new Failure(`the reply does not hold the digest of the fresh nonce, so the computer did not run the command: "${reply(turn).slice(0, 160)}" (${where})`)
    }
    return `the reply carries the digest ${digest.slice(0, 12)}… (${where})`
  }
  const path = `${fileDir.replace(/\/+$/, '')}/${nonce}.md`
  const { where } = await runTurn(access, 'Conformance: computer turn',
    `Conformance check: use the workspace computer to save a file at ${path} whose whole content is this one line, then reply with the word saved:\n${nonce}`, turnMs, model)
  const read = await access.client.readFile(access.workspace.id, path)
  if (!read.succeeded) throw new Failure(`the turn succeeded, but the app does not serve ${path}: ${read.status} ${read.code} (${where})`)
  if (read.value.content.trim() !== nonce) {
    throw new Failure(`${path} holds ${JSON.stringify(read.value.content.slice(0, 80))}, not the nonce (${where})`)
  }
  return `the app serves ${path} with the nonce (${where})`
}
