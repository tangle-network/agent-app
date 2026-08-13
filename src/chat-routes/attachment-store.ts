/**
 * Storage seams for the chat-attachment vertical (`resolveChatAttachments`,
 * `buildDispatchParts`, `promoteAgentFilePart`). Structural function ports in
 * the same style as `upload.ts`'s `SandboxUploadSink`: REQUIRED injection, no
 * default implementation — agent-app owns the size/budget/idempotency
 * mechanism, the product owns where the bytes actually live.
 *
 * One reader, two callers: `resolveChatAttachments` reads only the
 * authoritative `size` (never trusting the client-reported size), while
 * `buildDispatchParts` reads the inline `content` (base64 or raw bytes) to
 * build a `data:` URI. Both fit behind ONE `ReadAttachmentFn` so a product
 * wires a single vault/object-store adapter, not two. gtm's KV vault (stores
 * base64 bodies) and `/object-store`'s `ObjectStore` (hands back raw bytes)
 * both satisfy this shape.
 */

/**
 * The result of reading one stored attachment. `ok:true` MUST carry the
 * authoritative decoded byte `size` (the cap is meaningless against a
 * client-controlled number) and, when the caller needs to inline the file,
 * its content as `base64` and/or raw `bytes`. `mediaType` is the stored
 * content type when the store knows it (used as the fallback when the wire
 * part carried none). `ok:false` carries a human `reason` that SHOULD name the
 * offending path — it is surfaced verbatim in the caller's typed outcome.
 */
export type AttachmentReadResult =
  | {
      ok: true
      /** Authoritative decoded byte length of the stored content. */
      size: number
      /** Inline content as base64 — reused verbatim for a `data:` URI, so a
       *  store holding already-base64 bodies never decodes-and-re-encodes. */
      base64?: string
      /** Inline content as raw bytes — base64-encoded by the caller when a
       *  `data:` URI is needed. Ignored when `base64` is present. */
      bytes?: Uint8Array
      /** Stored content type, when the store tracks one. */
      mediaType?: string
    }
  | { ok: false; reason: string }

/**
 * Read one stored attachment for `scopeId` (the product's workspace/tenant
 * key) at its store-relative `path`. Missing, deleted, or unreadable content
 * MUST resolve to `{ ok: false, reason }`, never throw — a store failure is a
 * per-attachment outcome the caller folds into its own typed result, not a
 * turn-level exception.
 */
export type ReadAttachmentFn = (scopeId: string, path: string) => Promise<AttachmentReadResult>

/** The ownership identity for one attempted write. The upload and promotion
 * routes create a unique path for each attempt, and the product adapter stores
 * this id with it. */
export interface AttachmentWriteOwnership {
  id: string
  path: string
}

/** Public-safe outcome for a storage outage. Backend details belong in logs. */
export const ATTACHMENT_STORAGE_FAILURE_MESSAGE = 'Attachment storage is temporarily unavailable. Please try again.'

/** Add an ownership id to a logical path and return an immutable store key.
 * Ownership ids are path-safe because the key is also returned to clients. */
export function immutableAttachmentPath(logicalPath: string, ownershipId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownershipId)) {
    throw new Error('attachment ownership id must be a path-safe identifier')
  }
  return `${logicalPath}--${ownershipId}`
}

/** Compensation for one attachment write. The adapter MUST compare the stored
 * ownership id before deleting, so an older rollback cannot delete a newer
 * overwrite. */
export interface AttachmentWriteReceipt {
  rollback(): void | Promise<void>
  ownership: AttachmentWriteOwnership
}

/** Outcome of persisting one attachment. Mirrors `AttachmentReadResult`'s
 *  `ok`/`reason` shape and `upload.ts`'s `{ ok }` convention. The upload route
 *  requires a receipt on BOTH outcomes: a store may commit before reporting a
 *  failure, so the caller must always have an ownership-safe cleanup path. */
export type AttachmentWriteResult =
  | { ok: true; receipt: AttachmentWriteReceipt }
  | { ok: false; reason: string; receipt: AttachmentWriteReceipt }

/** Clean up a write whose function threw after the store may have committed.
 * The adapter must delete only the supplied ownership, never the logical path
 * unconditionally. */
export type AbortAttachmentWriteFn = (
  scopeId: string,
  ownership: AttachmentWriteOwnership,
) => void | Promise<void>

/** Options passed to a writer. `ownership` is the route-created identity the
 * adapter must bind to the stored object. */
export interface AttachmentWriteOptions {
  mediaType?: string
  name?: string
  originalName?: string
  size?: number
  ownership: AttachmentWriteOwnership
}

/**
 * Persist `content` for `scopeId` at `path`. `content` is either raw `bytes`
 * or a base64 `string` — a string argument is ALWAYS base64 (never utf8), so
 * a store that speaks base64 (gtm's vault) writes it verbatim and one that
 * speaks bytes decodes once. Like the reader, failures resolve to
 * `{ ok: false, reason }` rather than throwing. If a backend does throw after
 * starting a write, the route invokes its ownership-safe abort seam.
 *
 * `opts` mirrors the vault frontmatter gtm's `writeAttachmentVaultFile`
 * persists alongside the body (promote-file-parts.ts:181-190), so a product
 * reimplementing that vault writer through this seam can reproduce it
 * exactly:
 * - `mediaType` — the resolved MIME type; gtm's frontmatter key `mime`.
 * - `name` — the sanitized (store-path-safe) display filename; gtm passes
 *   this only to shape its oversize message, not into frontmatter.
 * - `originalName` — the filename as the harness/browser reported it, BEFORE
 *   sanitization (`raw.filename ?? filename` — falls back to the sanitized
 *   name when the source carried none); gtm's frontmatter key `originalName`.
 *   This is the one field with no other recovery path once sanitization has
 *   run, so it must ride the write, not be re-derived after the fact.
 * - `size` — the authoritative decoded byte length being written; gtm's
 *   frontmatter key `size`.
 */
export type WriteAttachmentFn = (
  scopeId: string,
  path: string,
  content: Uint8Array | string,
  opts: AttachmentWriteOptions,
) => Promise<AttachmentWriteResult>
