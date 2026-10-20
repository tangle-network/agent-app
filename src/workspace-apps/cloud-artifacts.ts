/**
 * Cloud artifacts: a page, dashboard or small app an agent made, copied out of
 * the box into object storage when it is produced, so it opens from a link
 * while the box is asleep and its owner can share it.
 *
 * Three kinds, the smallest that covers each case:
 *  - `static`: HTML, CSS, JS and media with no server code, served from storage.
 *  - `worker`: a static bundle plus `_worker.js`. A request that matches no
 *    file runs in a Worker Loader isolate with no network and only the
 *    bindings the product grants (`./cloud-artifact-origin`).
 *  - `openui`: a declarative OpenUI view that the product renders itself.
 * A live dev server on a box port stays a {@link WorkspaceAppRecord} preview.
 *
 * The product owns records, authorization and the routes that mint links.
 * This module owns the bundle contract, the storage layout and the link tokens.
 * Agent HTML is served only from a separate origin (`./cloud-artifact-origin`),
 * never from the product's origin, where it could act with a session.
 */
import { constantTimeEqual, hmacSha256Base64Url } from '../crypto/web-token'
import type { ObjectStore } from '../object-store'
import { createExpiringCapabilityToken, verifyExpiringCapabilityToken } from '../tools/capability'
import type { WorkspaceRole } from '../teams/roles'

export type CloudArtifactKind = 'static' | 'worker' | 'openui'

/** One stored file of a version. Bytes live at {@link cloudArtifactObjectKey}. */
export interface CloudArtifactFile {
  /** Relative to the bundle root, such as `index.html` or `images/hero.png`. */
  path: string
  contentType: string
  size: number
  /** Hex SHA-256 of the bytes; identical files share one stored object. */
  sha256: string
}

/** An immutable snapshot. Its id changes when any path, type or byte changes. */
export interface CloudArtifactVersion {
  id: string
  kind: CloudArtifactKind
  /** The file a link opens: HTML for `static` and `worker`, JSON for `openui`. */
  entry: string
  files: CloudArtifactFile[]
  createdAt: string
}

/** What the origin needs from the product's record. Products persist more. */
export interface CloudArtifactRecord {
  id: string
  workspaceId: string
  title: string
  version: CloudArtifactVersion
}

/** Who a view link was minted for: a workspace member, or a public share. */
export type CloudArtifactGrant = { type: 'member' } | { type: 'share'; shareId: string }

/** Opening an artifact needs `viewer`; creating or revoking a public link needs this role. */
export const CLOUD_ARTIFACT_SHARE_ROLE: WorkspaceRole = 'editor'

/** The module a `worker` bundle runs, at the bundle root (the Cloudflare Pages name). */
export const CLOUD_ARTIFACT_WORKER_MODULE = '_worker.js'
export const CLOUD_ARTIFACT_MAX_FILES = 200
export const CLOUD_ARTIFACT_MAX_FILE_BYTES = 10 * 1024 * 1024
export const CLOUD_ARTIFACT_MAX_BYTES = 50 * 1024 * 1024
/** Member view links are re-minted on every page load, so they can be short. */
export const CLOUD_ARTIFACT_VIEW_TTL_MS = 30 * 60 * 1000

export type CloudArtifactErrorCode =
  | 'invalid_path'
  | 'duplicate_path'
  | 'unsupported_type'
  | 'too_large'
  | 'too_many_files'
  | 'missing_entry'
  | 'invalid_entry'

export class CloudArtifactError extends Error {
  constructor(readonly code: CloudArtifactErrorCode, message: string) {
    super(message)
    this.name = 'CloudArtifactError'
  }
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
}

/** The served type for a path, or null when cloud artifacts do not serve it. */
export function cloudArtifactContentType(path: string): string | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot < path.lastIndexOf('/')) return null
  return TYPES[path.slice(dot + 1).toLowerCase()] ?? null
}

const SEGMENT = /^[^\u0000-\u001f\u007f/\\?#%]{1,120}$/

/** A bundle path: relative, no `.` or `..` segments, no control or URL-special characters. */
export function isCloudArtifactPath(path: string): boolean {
  if (typeof path !== 'string' || path.length > 240) return false
  return path.split('/').every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..'
    && segment.trim() === segment)
}

function mediaType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase()
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
}

export interface CloudArtifactInputFile {
  path: string
  body: Uint8Array | string
}

export interface PreparedCloudArtifact {
  version: CloudArtifactVersion
  /** Bytes to store, by SHA-256. Carried files are already stored and absent here. */
  bodies: ReadonlyMap<string, Uint8Array>
}

/**
 * Validate and hash a bundle. `carry` keeps files of an earlier version that
 * the new source could not supply, such as images that existed only on a box
 * that has since been recycled; their bytes are already stored.
 */
export async function prepareCloudArtifact(input: {
  files: readonly CloudArtifactInputFile[]
  entry: string
  /** Set for a declarative OpenUI view; otherwise `_worker.js` makes it `worker`. */
  openui?: boolean
  carry?: readonly CloudArtifactFile[]
  createdAt?: string
}): Promise<PreparedCloudArtifact> {
  const files = new Map<string, CloudArtifactFile>()
  const bodies = new Map<string, Uint8Array>()
  let total = 0
  for (const file of input.files) {
    if (!isCloudArtifactPath(file.path)) throw new CloudArtifactError('invalid_path', `Invalid artifact path: ${file.path}`)
    if (files.has(file.path)) throw new CloudArtifactError('duplicate_path', `Duplicate artifact path: ${file.path}`)
    const contentType = cloudArtifactContentType(file.path)
    if (!contentType) throw new CloudArtifactError('unsupported_type', `Cloud artifacts do not serve ${file.path}`)
    const bytes = typeof file.body === 'string' ? new TextEncoder().encode(file.body) : file.body
    if (bytes.byteLength > CLOUD_ARTIFACT_MAX_FILE_BYTES) {
      throw new CloudArtifactError('too_large', `${file.path} is larger than ${CLOUD_ARTIFACT_MAX_FILE_BYTES} bytes`)
    }
    total += bytes.byteLength
    const digest = await sha256(bytes)
    bodies.set(digest, bytes)
    files.set(file.path, { path: file.path, contentType, size: bytes.byteLength, sha256: digest })
  }
  for (const file of input.carry ?? []) {
    if (files.has(file.path) || !isCloudArtifactPath(file.path) || !/^[0-9a-f]{64}$/.test(file.sha256)) continue
    total += file.size
    files.set(file.path, file)
  }
  if (files.size > CLOUD_ARTIFACT_MAX_FILES) {
    throw new CloudArtifactError('too_many_files', `An artifact holds at most ${CLOUD_ARTIFACT_MAX_FILES} files`)
  }
  if (total > CLOUD_ARTIFACT_MAX_BYTES) {
    throw new CloudArtifactError('too_large', `An artifact holds at most ${CLOUD_ARTIFACT_MAX_BYTES} bytes`)
  }
  const entry = files.get(input.entry)
  if (!entry) throw new CloudArtifactError('missing_entry', `The bundle has no ${input.entry}`)
  const kind: CloudArtifactKind = input.openui ? 'openui' : files.has(CLOUD_ARTIFACT_WORKER_MODULE) ? 'worker' : 'static'
  if (mediaType(entry.contentType) !== (kind === 'openui' ? 'application/json' : 'text/html')) {
    throw new CloudArtifactError('invalid_entry', `A ${kind} artifact cannot open ${input.entry}`)
  }
  const sorted = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const manifest = JSON.stringify([kind, input.entry, sorted.map((file) => [file.path, file.contentType, file.sha256])])
  const id = (await sha256(new TextEncoder().encode(manifest))).slice(0, 32)
  return {
    version: { id, kind, entry: input.entry, files: sorted, createdAt: input.createdAt ?? new Date().toISOString() },
    bodies,
  }
}

/** Content-addressed per workspace, so erasing a workspace deletes one prefix. */
export function cloudArtifactObjectKey(workspaceId: string, sha256Hex: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId) || !/^[0-9a-f]{64}$/.test(sha256Hex)) {
    throw new Error('Invalid cloud artifact object key')
  }
  return `cloud-artifacts/${workspaceId}/${sha256Hex}`
}

/** The prefix holding every stored byte of a workspace's artifacts. */
export function cloudArtifactWorkspacePrefix(workspaceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw new Error('Invalid workspace id')
  return `cloud-artifacts/${workspaceId}/`
}

/** Store a prepared version's new bytes; objects already present are not rewritten. */
export async function storeCloudArtifact(
  store: ObjectStore,
  workspaceId: string,
  prepared: PreparedCloudArtifact,
): Promise<CloudArtifactVersion> {
  for (const file of prepared.version.files) {
    const bytes = prepared.bodies.get(file.sha256)
    if (!bytes) continue
    const key = cloudArtifactObjectKey(workspaceId, file.sha256)
    if (await store.head(key)) continue
    await store.put(key, bytes, { contentType: file.contentType, contentLength: bytes.byteLength })
  }
  return prepared.version
}

// ── Collecting a bundle from a source ───────────────────────────────────────

const ATTRIBUTE_REFERENCE = /\s(?:src|href|poster|data-src|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const SRCSET = /\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi
const JS_IMPORT = /(?:\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*[\w*{}\s,$]+\s*from\s*|\bimport\s*\(\s*)["']([^"']+)["']/g
const JS_FETCH = /\bfetch\s*\(\s*["']([^"']+)["']/g

function dirname(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/** Resolve a document-relative reference to a bundle path, or null when it is not a local file. */
export function resolveCloudArtifactReference(reference: string, documentPath: string): string | null {
  const raw = reference.trim()
  if (!raw || raw.startsWith('#') || raw.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return null
  let path = raw.split(/[?#]/)[0]!
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  const parts = dirname(documentPath) ? dirname(documentPath).split('/') : []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(segment)
  }
  const resolved = parts.join('/')
  return resolved && isCloudArtifactPath(resolved) && cloudArtifactContentType(resolved) ? resolved : null
}

function matches(pattern: RegExp, text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(pattern)) {
    const value = match.slice(1).find((group) => group !== undefined)
    if (value) found.push(value)
  }
  return found
}

/** Local files an HTML, CSS or JavaScript document refers to, as bundle paths. */
export function cloudArtifactReferences(text: string, documentPath: string): string[] {
  const type = mediaType(cloudArtifactContentType(documentPath) ?? '')
  const references: string[] = []
  if (type === 'text/html') {
    references.push(...matches(ATTRIBUTE_REFERENCE, text))
    for (const set of matches(SRCSET, text)) {
      references.push(...set.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? ''))
    }
    references.push(...matches(CSS_URL, text), ...matches(CSS_IMPORT, text))
    for (const script of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      references.push(...matches(JS_IMPORT, script[1] ?? ''), ...matches(JS_FETCH, script[1] ?? ''))
    }
  } else if (type === 'text/css') {
    references.push(...matches(CSS_URL, text), ...matches(CSS_IMPORT, text))
  } else if (type === 'text/javascript') {
    references.push(...matches(JS_IMPORT, text), ...matches(JS_FETCH, text))
  }
  const resolved = new Set<string>()
  for (const reference of references) {
    const path = resolveCloudArtifactReference(reference, documentPath)
    if (path && path !== documentPath) resolved.add(path)
  }
  return [...resolved]
}

/**
 * Gather an entry and every local file it refers to, transitively, plus
 * `_worker.js` and its imports when the root has one. `readMany` returns the
 * bytes of the paths it found (paths are bundle-relative); missing files are
 * reported, not fatal, so a page with one broken image still publishes.
 */
export async function collectCloudArtifactBundle(input: {
  entry: string
  readMany(paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>>
  maxFiles?: number
  maxBytes?: number
}): Promise<{ files: CloudArtifactInputFile[]; missing: string[] }> {
  const maxFiles = input.maxFiles ?? CLOUD_ARTIFACT_MAX_FILES
  const maxBytes = input.maxBytes ?? CLOUD_ARTIFACT_MAX_BYTES
  const files = new Map<string, Uint8Array>()
  const missing: string[] = []
  const seen = new Set<string>()
  let total = 0
  let frontier = [input.entry, CLOUD_ARTIFACT_WORKER_MODULE].filter((path) => isCloudArtifactPath(path))
  const decoder = new TextDecoder()
  while (frontier.length > 0 && files.size < maxFiles) {
    const batch = frontier.filter((path) => !seen.has(path)).slice(0, maxFiles - files.size)
    batch.forEach((path) => seen.add(path))
    if (batch.length === 0) break
    const read = await input.readMany(batch)
    const next: string[] = []
    for (const path of batch) {
      const bytes = read.get(path)
      if (!bytes) {
        if (path !== CLOUD_ARTIFACT_WORKER_MODULE) missing.push(path)
        continue
      }
      if (bytes.byteLength > CLOUD_ARTIFACT_MAX_FILE_BYTES || total + bytes.byteLength > maxBytes) {
        missing.push(path)
        continue
      }
      total += bytes.byteLength
      files.set(path, bytes)
      const type = mediaType(cloudArtifactContentType(path) ?? '')
      if (type === 'text/html' || type === 'text/css' || type === 'text/javascript') {
        next.push(...cloudArtifactReferences(decoder.decode(bytes), path))
      }
    }
    frontier = next
  }
  return { files: [...files].map(([path, body]) => ({ path, body })), missing }
}

// ── Links ───────────────────────────────────────────────────────────────────

const ID = /^[0-9a-f]{32}$/
const VIEW_PREFIX = 'cav_'

function grantSegment(grant: CloudArtifactGrant): string {
  if (grant.type === 'member') return 'm'
  if (!ID.test(grant.shareId)) throw new Error('Invalid cloud artifact share id')
  return grant.shareId
}

function viewSubject(artifactId: string, segment: string): string {
  return `cloud-artifact-view:${artifactId}:${segment}`
}

/** A random 32-hex id for an artifact or a share. */
export function createCloudArtifactId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer)
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * A short-lived URL on the artifact origin for one artifact and one grant.
 * Every file of the bundle sits under the same prefix, so relative links work.
 * The product mints it only after it has authorized the viewer.
 */
export async function createCloudArtifactViewUrl(input: {
  origin: string
  secret: string
  artifactId: string
  grant: CloudArtifactGrant
  path: string
  ttlMs?: number
  now?: () => number
}): Promise<string> {
  if (!ID.test(input.artifactId)) throw new Error('Invalid cloud artifact id')
  if (!isCloudArtifactPath(input.path)) throw new Error('Invalid cloud artifact path')
  const segment = grantSegment(input.grant)
  const token = await createExpiringCapabilityToken(viewSubject(input.artifactId, segment), {
    secret: input.secret,
    prefix: VIEW_PREFIX,
    expiresInMs: input.ttlMs ?? CLOUD_ARTIFACT_VIEW_TTL_MS,
    now: input.now,
  })
  if (!token) throw new Error('Cloud artifact links need a signing secret')
  return `${new URL(input.origin).origin}/${input.artifactId}/${segment}/${token}/${encodePath(input.path)}`
}

export interface CloudArtifactView {
  artifactId: string
  grant: CloudArtifactGrant
  /** Decoded bundle path; empty when the URL names the root. */
  path: string
}

/** Read and verify a view URL on the artifact origin; null for anything forged, expired or malformed. */
export async function readCloudArtifactViewUrl(
  url: URL,
  options: { secret: string; now?: () => number },
): Promise<CloudArtifactView | null> {
  const [, artifactId, segment, token, ...rest] = url.pathname.split('/')
  if (!artifactId || !ID.test(artifactId) || !segment || !token) return null
  if (segment !== 'm' && !ID.test(segment)) return null
  const valid = await verifyExpiringCapabilityToken(viewSubject(artifactId, segment), token, {
    secret: options.secret,
    prefix: VIEW_PREFIX,
    now: options.now,
  })
  if (!valid) return null
  let path: string
  try {
    path = rest.map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  if (path !== '' && !isCloudArtifactPath(path)) return null
  return { artifactId, grant: segment === 'm' ? { type: 'member' } : { type: 'share', shareId: segment }, path }
}

function shareSubject(shareId: string): string {
  return `cloud-artifact-share:${shareId}`
}

/**
 * The secret part of a public link: `<shareId>.<HMAC>`. It is derived, so the
 * product stores only the share id and can show the link again; revoking the
 * share row turns the link off at once.
 */
export async function createCloudArtifactShareToken(shareId: string, secret: string): Promise<string> {
  if (!ID.test(shareId)) throw new Error('Invalid cloud artifact share id')
  if (!secret.trim()) throw new Error('Cloud artifact links need a signing secret')
  return `${shareId}.${await hmacSha256Base64Url(shareSubject(shareId), secret.trim())}`
}

/** The share id a public link names, or null when its signature does not verify. */
export async function readCloudArtifactShareToken(token: string, secret: string): Promise<string | null> {
  const [shareId, signature, extra] = token.split('.')
  if (extra !== undefined || !shareId || !signature || !ID.test(shareId) || !secret.trim()) return null
  const expected = await hmacSha256Base64Url(shareSubject(shareId), secret.trim())
  return constantTimeEqual(signature, expected) ? shareId : null
}
