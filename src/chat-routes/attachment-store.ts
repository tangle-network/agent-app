/**
 * Storage seams for the chat-attachment vertical (`resolveChatAttachments`,
 * `buildDispatchParts`, `promoteAgentFilePart`). Structural function ports in
 * the same style as `upload.ts`'s `SandboxUploadSink`: REQUIRED injection, no
 * default implementation — agent-app owns the size/budget/idempotency
 * mechanism, the product owns where the bytes actually live.
 *
 * One reader serves validation, materialization, and dispatch:
 * `resolveChatAttachments` reads only the
 * authoritative `size` (never trusting the client-reported size), while
 * `buildDispatchParts` reads the inline `content` (base64 or raw bytes) to
 * build a `data:` URI. `prepareDispatchAttachments` copies raw bytes when a
 * product opts in. All share `ReadAttachmentFn` so a product
 * wires a single vault/object-store adapter, not two. gtm's KV vault (stores
 * base64 bodies) and `/object-store`'s `ObjectStore` (hands back raw bytes)
 * both satisfy this shape.
 */

import type { ChatAttachmentPart } from '../chat-store/parts'
import { DISPATCH_MAX_MEDIA_PARTS } from './wire'

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

/** Opt-in copy from the product attachment store to its already-authorized box.
 *  Uploads are sequential and their returned byte counts must match the store.
 *  The product retains its missing-content sentence and the surrounding trace span. */
export interface AttachmentMaterialization {
  upload: (absolutePath: string, bytes: Uint8Array) => Promise<{ size: number }>
  missingBytesMessage: (path: string) => string
}

/** Prepare carried files before a product constructs its prompt and dispatch input. */
export interface PrepareDispatchAttachmentsInput {
  attachments: ChatAttachmentPart[]
  historyAttachments?: readonly ChatAttachmentPart[]
  mentionCount?: number
  scopeId: string
  readAttachment: ReadAttachmentFn
  resolveAttachmentPath: (path: string) => string
  materialize?: AttachmentMaterialization
}

/** Select carried files and optionally copy them before constructing a prompt.
 *  Omitted history and materialization preserve the supplied attachment list.
 *  `slice(-0)` intentionally retains the apps' current zero-slot behavior. */
export async function prepareDispatchAttachments(input: PrepareDispatchAttachmentsInput): Promise<ChatAttachmentPart[]> {
  const historyBudget = Math.max(
    0,
    DISPATCH_MAX_MEDIA_PARTS - input.attachments.length - (input.mentionCount ?? 0),
  )
  const attachments = input.historyAttachments === undefined ? input.attachments : [
    ...input.attachments,
    ...input.historyAttachments.slice(-historyBudget),
  ]
  const materialize = input.materialize
  if (!materialize) return attachments
  const written = new Set<string>()
  for (const part of attachments) {
    const target = input.resolveAttachmentPath(part.path)
    if (written.has(target)) continue
    written.add(target)

    const read = await input.readAttachment(input.scopeId, part.path)
    if (!read.ok) throw new Error(read.reason)
    if (!read.bytes) {
      throw new Error(materialize.missingBytesMessage(part.path))
    }
    const result = await materialize.upload(target, read.bytes)
    if (result.size !== read.size) {
      throw new Error(
        `Sandbox attachment size mismatch for ${part.path}: expected ${read.size}, uploaded ${result.size}`,
      )
    }
  }
  return attachments
}

/** The ownership identity for one attempted write. The upload and promotion
 * routes create a unique path for each attempt, and the product adapter stores
 * this id with it. */
export interface AttachmentWriteOwnership {
  readonly id: string
  readonly path: string
}

/** Public-safe outcome for a storage outage. Backend details belong in logs. */
export const ATTACHMENT_STORAGE_FAILURE_MESSAGE = 'Attachment storage is temporarily unavailable. Please try again.'

/** Stable client error code when compensating cleanup did not complete. */
export const ATTACHMENT_ROLLBACK_FAILURE_CODE = 'rollback_failed'

/** Public-safe outcome when compensating cleanup did not complete. */
export const ATTACHMENT_ROLLBACK_FAILURE_MESSAGE = 'Attachment cleanup failed. Please try again.'

/** Add a path-safe ownership id to a logical path and return an immutable store key. */
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

/** Clean up a write whose function threw after the store may have committed.
 * The adapter must delete only the supplied ownership, never the logical path
 * unconditionally. */
export type AbortAttachmentWriteFn = (
  scopeId: string,
  ownership: AttachmentWriteOwnership,
) => void | Promise<void>

/**
 * The stable writer result from the original attachment-store contract.
 * Existing products may return this shape and keep using the legacy writer
 * lane. New products should use {@link AtomicAttachmentWriteResult}.
 */
export type AttachmentWriteResult = { ok: true } | { ok: false; reason: string }

/** Options from the stable attachment-store contract. */
export interface AttachmentWriteOptions {
  mediaType?: string
  name?: string
  originalName?: string
  size?: number
}

/**
 * The stable writer port. It is intentionally unchanged so products released
 * before the ownership receipt contract continue to compile.
 *
 * The legacy lane does not promise batch rollback. Use
 * {@link createAtomicAttachmentWriter} for ownership-safe writes.
 */
export type WriteAttachmentFn = (
  scopeId: string,
  path: string,
  content: Uint8Array | string,
  opts: AttachmentWriteOptions,
) => Promise<AttachmentWriteResult>

/** Options for a streamed write. `size` is the exact byte count `content`
 *  yields. `mediaType` is decided from the file name and its first bytes,
 *  before the route has read the rest: an archive's central directory sits at
 *  its end, so the route's response, not this value, carries the final type. */
export interface AttachmentStreamWriteOptions extends AttachmentWriteOptions {
  size: number
  mediaType: string
}

/**
 * Streamed writer port for an upload too large to hold in memory. `content`
 * yields exactly `opts.size` bytes. The route checks the file while it
 * streams and withholds the final bytes until the whole file has passed, so
 * on a refusal `content` errors instead of ending. The adapter must make the
 * bytes readable at `path` only when `content` ends cleanly, and must leave
 * whatever was stored at `path` before untouched when it errors. A store put
 * of a fixed-length stream (R2 `put` behind `FixedLengthStream`) does both.
 */
export type WriteAttachmentStreamFn = (
  scopeId: string,
  path: string,
  content: ReadableStream<Uint8Array>,
  opts: AttachmentStreamWriteOptions,
) => Promise<AttachmentWriteResult>

/** Options for an ownership-safe writer. */
export interface AtomicAttachmentWriteOptions extends AttachmentWriteOptions {
  ownership: AttachmentWriteOwnership
}

/** Result for an ownership-safe writer. A receipt is required on both paths. */
export type AtomicAttachmentWriteResult =
  | { ok: true; receipt: AttachmentWriteReceipt }
  | { ok: false; reason: string; receipt: AttachmentWriteReceipt }

/** Ownership-safe writer port used by the atomic upload and promotion lanes. */
export type AtomicWriteAttachmentFn = (
  scopeId: string,
  path: string,
  content: Uint8Array | string,
  opts: AtomicAttachmentWriteOptions,
) => Promise<AtomicAttachmentWriteResult>

/** A complete ownership-safe attachment store adapter. */
export interface AtomicAttachmentWriter {
  write: AtomicWriteAttachmentFn
  abort: AbortAttachmentWriteFn
}

/**
 * Build the explicit atomic adapter used by new routes.
 *
 * Keeping the write and abort functions together prevents a caller from
 * enabling ownership paths while forgetting the ambiguous-write cleanup.
 */
export function createAtomicAttachmentWriter(input: AtomicAttachmentWriter): AtomicAttachmentWriter {
  return {
    write: input.write.bind(input),
    abort: input.abort.bind(input),
  }
}
