#!/usr/bin/env node
/** Read-only operator collector. Never sends a message, drives a turn or approves an effect. */
import { mkdir, lstat, open } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Sandbox } from '@tangle-network/sandbox/core'

const key = process.env.TANGLE_API_KEY
if (!key) throw new Error('Set the operator TANGLE_API_KEY. Never use the agent runtime key for this readback.')
const lineId = process.env.TANGLE_PROOF_LINE_ID ?? 'ln_lNVXAvYe2XbdMnQMCn2c'
if (!/^ln_[A-Za-z0-9_-]+$/.test(lineId)) throw new Error('Invalid line id')
const base = new URL(process.env.SANDBOX_BASE_URL ?? 'https://sandbox.tangle.tools')
if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Use the trusted Sandbox HTTPS origin')
const out = resolve(process.argv[2] ?? 'agent-line-evidence')
await mkdir(out, { recursive: true, mode: 0o700 })
const info = await lstat(out)
if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) {
  throw new Error('Evidence directory must be a real private directory (mode 0700)')
}
const client = new Sandbox({ apiKey: key, baseUrl: base.origin, timeoutMs: 30_000 })
const line = await client.lines.get(lineId)
if (line.id !== lineId) throw new Error('Line readback mismatch')
const members = await client.lines.members(lineId).list()
const threads = await client.lines.threads(lineId).list()
const conversations = []
for (const thread of threads) {
  conversations.push({ thread, messages: await client.lines.threads(lineId).messages(thread.id) })
}
// Credentials are not expected in readback, but never retain an accidentally
// returned literal bearer or password. Secret names and references remain useful.
function redact(value, name = '') {
  if (/^(authorization|cookie|password|token|apiKey|api_key|secret)$/i.test(name)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => redact(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,redact(v,k)]))
  if (typeof value === 'string') return value.replaceAll(key, '[REDACTED_OPERATOR_KEY]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  return value
}
const at = new Date().toISOString()
const snapshot = redact({ collectedAt: at, line, members, conversations,
  completeness: 'SDK current readback only. This snapshot is not a claim that all historical messages or provider receipts are present.',
  liveProof: 'Operator must join actual turn/tool/provider and delivery receipts. A queued or answered row alone does not prove the requested effect.' })
const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const path = join(out, `${at.replaceAll(':', '-')}-${randomUUID()}.json`)
const file = await open(path, 'wx', 0o600)
try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
console.log(JSON.stringify({ collectedAt: at, lineId, path, sha256,
  attachmentId: line.attachment?.id ?? null,
  members: members.length, threads: threads.length,
  messages: conversations.reduce((n,c) => n + c.messages.length, 0),
  writesToPlatform: 0, messagesSent: 0 }))
