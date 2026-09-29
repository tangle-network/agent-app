import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Sandbox } from '@tangle-network/sandbox/core'

const required = name => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
const keyPath = required('TANGLE_API_KEY_FILE')
const keyStat = await stat(keyPath)
if (!keyStat.isFile() || (process.platform !== 'win32' && (keyStat.mode & 0o077)))
  throw new Error('The owner key must be a private regular file')
const base = new URL(required('SANDBOX_URL'))
if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
  throw new Error('SANDBOX_URL must be a trusted HTTPS origin')
const lineId = required('LINE_ID')
if (!/^ln_[A-Za-z0-9_-]+$/.test(lineId)) throw new Error('LINE_ID must name one dedicated test line')
const destination = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Pass a private evidence directory')
const client = new Sandbox({ apiKey: (await readFile(keyPath, 'utf8')).trim(), baseUrl: base.origin, timeoutMs: 30_000 })
const sha256 = value => createHash('sha256').update(value).digest('hex')
await mkdir(destination, { mode: 0o700 })
const line = await client.lines.get(lineId)
const threads = await client.lines.threads(lineId).list()
const evidence = []
for (const thread of threads) {
  for (const item of await client.lines.threads(lineId).messages(thread.id)) {
    evidence.push({
      id: item.id, threadId: thread.id, memberId: item.memberId, direction: item.direction,
      kind: item.kind, status: item.status, createdAt: item.createdAt,
      textSha256: item.text === null ? null : sha256(item.text),
      applicationExecutionId: item.timeline?.applicationExecutionId ?? null,
      applicationResultSha256: item.timeline?.applicationResultSha256 ?? null,
      replyRecordedAt: item.timeline?.replyRecordedAt ?? null,
      errorCode: item.errorCode,
    })
  }
}
const report = {
  schema: 'application-line-inspection-v1', observedAt: new Date().toISOString(), origin: base.origin,
  line: { id: line.id, transport: line.transport, status: line.status,
    attachmentId: line.attachment?.id ?? null, applicationBound: !!line.attachment?.respond.application },
  threads: threads.map(thread => ({ id: thread.id, memberId: thread.memberId, sandboxId: thread.sandboxId })),
  messages: evidence, effectsPerformed: [], handsetDelivery: 'not_observed', applicationCompletion: 'not_independently_checked',
}
await writeFile(resolve(destination, 'line.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify({ directory: destination, messagesObserved: evidence.length, writesToServices: 0 }))
