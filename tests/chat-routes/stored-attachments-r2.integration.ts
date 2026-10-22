/** Standalone real R2 integration, run through a consuming app's declared Wrangler dependency.
 * AGENT_APP_R2_CONSUMER_ROOT=<installed app checkout> <app's tsx> <this file>
 * It is outside the framework's default test glob: no test-only runtime dependency is added here.
 * Cloudflare reference: https://developers.cloudflare.com/workers/testing/miniflare/storage/r2/
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createR2ObjectStore, type ObjectStore, type R2LikeBucket } from '../../src/object-store'
import { createStoredChatAttachments } from '../../src/chat-routes/stored-attachments'

const consumerRoot = process.env.AGENT_APP_R2_CONSUMER_ROOT
if (!consumerRoot) throw new Error('Set AGENT_APP_R2_CONSUMER_ROOT to an installed consuming app with a declared Wrangler dependency')
const consumer = createRequire(resolve(consumerRoot, 'package.json'))
const appPackage = consumer('./package.json') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
assert(appPackage.dependencies?.wrangler ?? appPackage.devDependencies?.wrangler, 'Consumer must declare Wrangler')
const wrangler = createRequire(consumer.resolve('wrangler/package.json'))
const miniflareEntry = realpathSync(wrangler.resolve('miniflare'))
let dependencyDirectory = dirname(miniflareEntry)
let miniflareVersion: string | undefined
while (dependencyDirectory !== dirname(dependencyDirectory)) {
  const manifest = resolve(dependencyDirectory, 'package.json')
  if (existsSync(manifest)) {
    const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string }
    if (metadata.name === 'miniflare') { miniflareVersion = metadata.version; break }
  }
  dependencyDirectory = dirname(dependencyDirectory)
}
assert(miniflareVersion, 'Resolved Miniflare dependency has no package version')
const compatibilityDate = readFileSync(resolve(consumerRoot, 'wrangler.toml'), 'utf8').match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1]
assert(compatibilityDate, 'Consumer Wrangler config must name its compatibility date')
const consumerRevision = execFileSync('git', ['-C', consumerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const consumerLockSha256 = createHash('sha256').update(readFileSync(resolve(consumerRoot, 'pnpm-lock.yaml'))).digest('hex')
const { Miniflare, convertV4MiniflareOptions } = wrangler('miniflare') as { convertV4MiniflareOptions: (options: Record<string, unknown>) => Record<string, unknown>; Miniflare: new (options: Record<string, unknown>) => {
  getR2Bucket(name: string, workerName?: string): Promise<R2LikeBucket & { list(): Promise<{ objects: { key: string }[] }> }>
  dispose(): Promise<void>
} }
const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'attachments', modules: true, compatibilityDate,
  script: 'export default { fetch() { return new Response("ready") } }', r2Buckets: ['ATTACHMENTS'] }] }))
try {
  let binding: ObjectStore | undefined
  const attachments = createStoredChatAttachments({ store: () => {
    if (!binding) throw new Error('ATTACHMENTS R2 binding not initialized')
    return binding
  } })
  assert.deepEqual(await attachments.readAttachment('workspace-a', 'uploads/fixture.bin'), {
    ok: false, reason: 'Attachment read failed for uploads/fixture.bin: ATTACHMENTS R2 binding not initialized',
  })
  const bucket = await runtime.getR2Bucket('ATTACHMENTS', 'attachments')
  binding = createR2ObjectStore({ bucket })
  const bytes = new Uint8Array([0, 1, 127, 128, 255])
  assert.deepEqual(await attachments.writeAttachment('workspace-a', 'uploads/fixture.bin', bytes,
    { size: bytes.length, mediaType: 'application/octet-stream' }), { ok: true })
  const read = await attachments.readAttachment('workspace-a', 'uploads/fixture.bin')
  assert(read.ok)
  assert.equal(read.size, bytes.length)
  assert.deepEqual(read.bytes, bytes)
  assert.equal(read.mediaType, 'application/octet-stream')
  const object = await attachments.getAttachmentObject('workspace-a', 'uploads/fixture.bin')
  assert(object)
  assert.deepEqual(new Uint8Array(await new Response(object.stream()).arrayBuffer()), bytes)
  assert.deepEqual(await attachments.readAttachment('workspace-b', 'uploads/fixture.bin'), {
    ok: false, reason: 'Attachment not found: uploads/fixture.bin',
  })
  assert.deepEqual(await attachments.writeAttachment('workspace-a', 'uploads/wrong-size.bin', bytes, { size: 99 }), {
    ok: false, reason: 'Attachment size mismatch for uploads/wrong-size.bin: expected 99, received 5',
  })
  assert.equal(await bucket.head('workspace-a/uploads/wrong-size.bin'), null)
  const base64 = btoa(String.fromCharCode(...bytes))
  assert.deepEqual(await attachments.writeAttachment('workspace-a', 'uploads/base64.bin', base64, { size: bytes.length }), { ok: true })
  const decoded = await attachments.readAttachment('workspace-a', 'uploads/base64.bin')
  assert(decoded.ok)
  assert.deepEqual(decoded.bytes, bytes)
  for (const [scope, path] of [['../workspace-b', 'uploads/fixture.bin'], ['workspace-a', '../escape.bin'],
    ['workspace-a', '/absolute.bin'], ['workspace-a', 'uploads/.hidden.bin']]) {
    const result = await attachments.writeAttachment(scope!, path!, bytes, {})
    assert(!result.ok, `Unsafe object key accepted: ${scope}/${path}`)
  }
  const malformed = await attachments.writeAttachment('workspace-a', 'uploads/corrupt.bin', '%invalid-base64%', {})
  assert(!malformed.ok)
  assert.deepEqual((await bucket.list()).objects.map(object => object.key).sort(), [
    'workspace-a/uploads/base64.bin', 'workspace-a/uploads/fixture.bin',
  ])
  console.log(JSON.stringify({ consumerRoot, consumerRevision, consumerLockSha256, compatibilityDate, miniflareEntry, miniflareVersion, r2Objects: 2, byteExact: true, lazyBinding: true,
    crossWorkspaceMiss: true, unsafeKeysRefused: 4, sizeMismatchRefused: true, corruptBase64Refused: true }))
} finally {
  await runtime.dispose()
}
