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

/** Outcome of persisting one attachment. Mirrors `AttachmentReadResult`'s
 *  `ok`/`reason` shape and `upload.ts`'s `{ ok }` convention. */
export type AttachmentWriteResult = { ok: true } | { ok: false; reason: string }

/**
 * Persist `content` for `scopeId` at `path`. `content` is either raw `bytes`
 * or a base64 `string` — a string argument is ALWAYS base64 (never utf8), so
 * a store that speaks base64 (gtm's vault) writes it verbatim and one that
 * speaks bytes decodes once. Like the reader, failures resolve to
 * `{ ok: false, reason }` rather than throwing.
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
  opts: { mediaType?: string; name?: string; originalName?: string; size?: number },
) => Promise<AttachmentWriteResult>
