/**
 * `/object-store` — a portable, secure object store for durable large
 * attachments (uploaded PDFs, images, exports) that are too big to ride a chat
 * turn body or live in KV.
 *
 * SECURITY POSTURE (this module guards a legal privilege wall). Every object key
 * carries an operator segment and a customer segment, and access is by a
 * short-lived HMAC-signed URL whose signature covers the EXACT key (operator +
 * customer + upload id + filename) AND the expiry. A tampered key, a swapped
 * customer segment, or a replayed-after-expiry URL all fail the signature or the
 * expiry check and are refused. The signing secret is a PARAMETER on every call
 * — this module reads NOTHING global (no `process.env`, no ambient config); if a
 * product forgets to bind the secret, {@link verifyObjectUrl} fails closed and
 * {@link signObjectUrl} throws rather than minting an unsigned URL.
 *
 * PURE MECHANISM behind two seams: an {@link ObjectStore} port (the R2 impl maps
 * 1:1 to a bucket held behind the structural {@link R2LikeBucket} — so
 * `@cloudflare/workers-types` never leaks into this package's public `.d.ts`)
 * and the signing `secret`. Reads and writes STREAM: {@link createR2ObjectStore}
 * returns the R2 object's `.body` stream directly and never calls
 * `.text()`/`.arrayBuffer()`, so a 15 MB PDF flows through the worker without
 * buffering the whole file into the isolate's heap.
 *
 * RECONCILIATION with the sandbox `storage` seam (`../sandbox` →
 * `SandboxRuntimeConfig.storage`): that is BYOS3/R2 *snapshot* storage — it
 * checkpoints and restores a sandbox box's filesystem for durable session
 * execution. This is a DIFFERENT concern: a content-addressed store for
 * user-facing attachments gated by a signed-URL privilege wall. They are not
 * interchangeable and must not be merged: one persists agent runtime state, the
 * other serves per-operator/per-customer documents to browsers. Do not route
 * artifact downloads through the snapshot bucket, or vice versa.
 */

import { constantTimeEqual, hmacSha256Base64Url } from '../crypto/web-token'

// ── The store port + R2 impl ────────────────────────────────────────────────

/** Options for a single {@link ObjectStore.put}. Both fields are optional; a
 *  store that needs a fixed content length (e.g. R2 with a `ReadableStream`
 *  body) uses `contentLength` when present. */
export interface PutObjectOptions {
  /** MIME type recorded with the object (returned by `get`/`head`). Advisory:
   *  the proxied download route always serves `application/octet-stream`. */
  contentType?: string
  /** Byte length of `body`, when known. Some backends require it for a
   *  streamed body; the R2 impl passes a known length through when supplied. */
  contentLength?: number
}

/** A retrieved object. `stream()` is the ONLY way to read the bytes — there is
 *  deliberately no `text()`/`arrayBuffer()`, so a large object never buffers
 *  into the isolate heap. */
export interface ObjectBody {
  /** The object's bytes as a `ReadableStream` (backed by R2's `.body`). */
  stream(): ReadableStream
  /** Size in bytes. */
  size: number
  /** Recorded MIME type, if any. */
  contentType?: string
}

/**
 * Portable object-store port. `get`/`head` return `null` on a miss and NEVER
 * throw for a missing key (a miss is a normal control-flow outcome, not an
 * error); `delete` is idempotent.
 */
export interface ObjectStore {
  put(key: string, body: ReadableStream | Uint8Array, opts?: PutObjectOptions): Promise<void>
  /** `null` on a miss — never throws for a missing key. */
  get(key: string): Promise<ObjectBody | null>
  /** `null` on a miss — never throws for a missing key. */
  head(key: string): Promise<{ size: number; contentType?: string } | null>
  delete(key: string): Promise<void>
}

/** Head/metadata shape of a stored object (structural match of R2's `R2Object`). */
export interface R2LikeObjectHead {
  size: number
  httpMetadata?: { contentType?: string }
}

/** Body shape of a retrieved object (structural match of R2's `R2ObjectBody`).
 *  `body` is the streamed content — the impl reads this, never `.text()`. */
export interface R2LikeObjectBody extends R2LikeObjectHead {
  body: ReadableStream
}

/**
 * The minimal slice of Cloudflare's `R2Bucket` this module calls. A real
 * `R2Bucket` satisfies it structurally, so the consumer passes its binding
 * without this package ever importing `@cloudflare/workers-types` (which would
 * otherwise leak into the public `.d.ts`).
 */
export interface R2LikeBucket {
  put(
    key: string,
    value: ReadableStream | Uint8Array | ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>
  get(key: string): Promise<R2LikeObjectBody | null>
  head(key: string): Promise<R2LikeObjectHead | null>
  delete(key: string): Promise<void>
}

/**
 * Map the {@link ObjectStore} port onto an R2 bucket 1:1. `get` STREAMS: it
 * returns the R2 object's `.body` behind `ObjectBody.stream()` and never calls
 * `.text()`/`.arrayBuffer()`, so a large file flows through the worker rather
 * than buffering into the isolate.
 */
export function createR2ObjectStore({ bucket }: { bucket: R2LikeBucket }): ObjectStore {
  return {
    async put(key, body, opts) {
      const options = opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : undefined
      await bucket.put(key, body, options)
    },
    async get(key) {
      const obj = await bucket.get(key)
      if (!obj) return null
      return {
        stream: () => obj.body,
        size: obj.size,
        contentType: obj.httpMetadata?.contentType,
      }
    },
    async head(key) {
      const obj = await bucket.head(key)
      if (!obj) return null
      return { size: obj.size, contentType: obj.httpMetadata?.contentType }
    },
    async delete(key) {
      await bucket.delete(key)
    },
  }
}

// ── Key construction + safety ───────────────────────────────────────────────

/**
 * Assert a single object-key path SEGMENT (an operator id, customer id, or
 * upload id) is safe to interpolate into a key, and return it. Throws on the
 * traversal / injection shapes: `..` anywhere, a leading `/`, a backslash, or an
 * empty segment. Consumers should call this on caller-supplied identifiers
 * BEFORE any `get`/`put` so an attacker-controlled id can never widen the key
 * beyond its own operator+customer prefix.
 */
export function assertSafeKeySegment(s: string): string {
  if (s.length === 0) throw new Error('object-store: empty key segment')
  if (s.includes('..')) throw new Error(`object-store: unsafe key segment (contains "..") — ${s}`)
  if (s.startsWith('/')) throw new Error(`object-store: unsafe key segment (leading "/") — ${s}`)
  if (s.includes('\\')) throw new Error(`object-store: unsafe key segment (backslash) — ${s}`)
  return s
}

/** Strip a filename down to a safe leaf: drop any path, keep only
 *  `[A-Za-z0-9._-]`, and remove leading dots so a `..`/`.hidden`/dot-only name
 *  can neither traverse nor vanish. Never returns an empty string. */
function sanitizeFilename(filename: string): string {
  const leaf = filename.split(/[/\\]/).pop() ?? ''
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  return cleaned.length > 0 ? cleaned : 'file'
}

/** Inputs to {@link objectKey}. `customerId` is optional — an unattributed
 *  upload lands under the reserved `_unattributed` customer segment. */
export interface ObjectKeyParts {
  operatorId: string
  /** Optional — omitted/undefined groups the upload under `_unattributed`. */
  customerId?: string
  uploadId: string
  filename: string
}

/**
 * Build the canonical object key: `operator/customer/upload-filename`. The
 * operator, customer, and upload segments are asserted safe (throwing on
 * traversal); the filename is sanitized to a safe leaf. The customer segment
 * falls back to `_unattributed` when no customer is attributed. Because a signed
 * URL binds the EXACT key, the operator and customer segments are part of the
 * privilege wall — a caller cannot later swap them without breaking the
 * signature.
 */
export function objectKey({ operatorId, customerId, uploadId, filename }: ObjectKeyParts): string {
  const operator = assertSafeKeySegment(operatorId)
  const customer = customerId == null ? '_unattributed' : assertSafeKeySegment(customerId)
  const upload = assertSafeKeySegment(uploadId)
  return `${operator}/${customer}/${upload}-${sanitizeFilename(filename)}`
}

/**
 * Decode a key ONCE and assert every `/`-delimited segment is safe. Slash- and
 * percent-encoded forms of the same key canonicalize identically (`a/b` and
 * `a%2Fb` both → `a/b`), so a signature binds the key's MEANING, not its
 * on-the-wire spelling. Throws on malformed percent-encoding or an unsafe
 * segment. Our own keys never contain `%`, so the single decode is idempotent.
 */
function canonicalizeObjectKey(raw: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    throw new Error('object-store: malformed key encoding')
  }
  for (const segment of decoded.split('/')) assertSafeKeySegment(segment)
  return decoded
}

// ── Signed URLs ─────────────────────────────────────────────────────────────

/** The exact string the signature covers: a versioned JSON of the canonical key
 *  and the expiry. JSON escaping makes it delimiter-injection-proof (a key
 *  cannot forge the `exp` field). Both sign and verify build it identically. */
function signingMessage(canonicalKey: string, exp: number): string {
  return JSON.stringify({ v: 1, exp, key: canonicalKey })
}

/** Arguments to {@link signObjectUrl}. */
export interface SignObjectUrlArgs {
  /** The exact object key to authorize (from {@link objectKey}). */
  key: string
  /** Absolute expiry in epoch MILLISECONDS (e.g. `Date.now() + 5 * 60_000` for a
   *  ~5-minute TTL — the recommended default; keep it short). */
  exp: number
  /** HMAC signing secret. Must be non-empty — signing fails closed otherwise. */
  secret: string
}

/**
 * Mint a signed query string (`?key=…&exp=…&sig=…`) authorizing a download of
 * `key` until `exp`. The product appends it to its artifact route path
 * (`` `/artifacts${await signObjectUrl(...)}` ``); {@link createProxiedArtifactRoute}
 * / {@link verifyObjectUrl} read it straight off the request URL, so the route's
 * own mount path never matters.
 *
 * FAIL-CLOSED: throws if `secret` is empty (never mints an unsigned URL) and if
 * `key` is unsafe (traversal). Async because the HMAC primitive is WebCrypto.
 *
 * TTL: `exp` is caller-supplied on purpose (the caller knows the sensitivity);
 * keep it SHORT — ~5 minutes is the recommended default for a privilege-walled
 * document.
 */
export async function signObjectUrl({ key, exp, secret }: SignObjectUrlArgs): Promise<string> {
  if (!secret) throw new Error('object-store: signObjectUrl requires a non-empty secret (fail-closed)')
  const canonical = canonicalizeObjectKey(key)
  const sig = await hmacSha256Base64Url(signingMessage(canonical, exp), secret)
  const params = new URLSearchParams({ key: canonical, exp: String(exp), sig })
  return `?${params.toString()}`
}

/** Result of {@link verifyObjectUrl}: the canonical key on success, nothing
 *  distinguishing on failure (so a rejection leaks no detail). */
export type VerifyObjectUrlResult = { ok: true; key: string } | { ok: false }

/**
 * Verify a signed download request. Reads `key`/`exp`/`sig` off the request URL,
 * canonicalizes the key identically to the signer, recomputes the HMAC and
 * constant-time-compares it, and checks the expiry. Returns the canonical key on
 * success.
 *
 * FAIL-CLOSED everywhere: an empty `secret`, a missing/ malformed parameter, a
 * non-finite expiry, a signature mismatch, or an expired URL all return
 * `{ ok: false }` — and the mismatch path uses a constant-time compare so a
 * near-correct signature is not distinguishable by timing. Async because the
 * HMAC primitive is WebCrypto.
 */
export async function verifyObjectUrl(
  request: Request,
  { secret }: { secret: string },
): Promise<VerifyObjectUrlResult> {
  if (!secret) return { ok: false }
  const url = new URL(request.url)
  const rawKey = url.searchParams.get('key')
  const expRaw = url.searchParams.get('exp')
  const sig = url.searchParams.get('sig')
  if (!rawKey || !expRaw || !sig) return { ok: false }

  let key: string
  try {
    key = canonicalizeObjectKey(rawKey)
  } catch {
    return { ok: false }
  }

  const exp = Number(expRaw)
  if (!Number.isFinite(exp)) return { ok: false }

  const expected = await hmacSha256Base64Url(signingMessage(key, exp), secret)
  if (!constantTimeEqual(expected, sig)) return { ok: false }
  // Signature is valid; enforce expiry last so the constant-time compare always
  // runs (an expired-but-otherwise-valid URL is refused just the same).
  if (Date.now() > exp) return { ok: false }
  return { ok: true, key }
}

// ── Proxied download route ──────────────────────────────────────────────────

/**
 * Build a download handler that verifies a signed request and STREAMS the object
 * back with a conservative, non-executable content type. Status contract:
 *
 * - `400` — the `key` is missing or malformed (bad encoding / traversal). This
 *   is an unauthenticated client error and leaks NOTHING about object existence.
 * - `403` — the signature is missing, wrong, or expired.
 * - `404` — the signature was valid but no object exists at that key (existence
 *   is only ever revealed to a validly-signed request).
 * - `200` — streams the bytes with `Content-Disposition: attachment`,
 *   `Content-Type: application/octet-stream`, and `X-Content-Type-Options:
 *   nosniff`, so the worker never serves active/inline content.
 */
export function createProxiedArtifactRoute({
  store,
  secret,
}: {
  store: ObjectStore
  secret: string
}): (request: Request) => Promise<Response> {
  return async (request) => {
    // 1. Malformed/missing key → 400, decided BEFORE auth so it leaks no
    //    existence signal (a malformed key can never carry a valid signature).
    const rawKey = new URL(request.url).searchParams.get('key')
    if (!rawKey) return new Response('Missing key', { status: 400 })
    try {
      canonicalizeObjectKey(rawKey)
    } catch {
      return new Response('Malformed key', { status: 400 })
    }

    // 2. Bad / expired signature → 403.
    const verified = await verifyObjectUrl(request, { secret })
    if (!verified.ok) return new Response('Forbidden', { status: 403 })

    // 3. Fetch by the VERIFIED canonical key. Miss → 404 (only reachable behind
    //    a valid signature). Hit → stream with a conservative content type.
    const obj = await store.get(verified.key)
    if (!obj) return new Response('Not found', { status: 404 })

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      'X-Content-Type-Options': 'nosniff',
    }
    if (Number.isFinite(obj.size) && obj.size >= 0) headers['Content-Length'] = String(obj.size)
    return new Response(obj.stream(), { status: 200, headers })
  }
}
