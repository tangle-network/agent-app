/**
 * `createAttachmentUploadRoute` — the fleet-primitive durable-store upload
 * route: a two-phase atomic batch (every file is validated before any file is
 * written — a batch never partially lands), a content-sniffed type gate
 * (`checkAttachmentType` over `sniffBinary`'s magic-byte read, not the
 * extension or the browser-reported MIME), per-kind + aggregate byte caps,
 * and sanitized filenames. Storage is fully seamed through the injected
 * `WriteAttachmentFn` (`./attachment-store`) — no default store, the product
 * owns where bytes actually live (vault, object store, …) — and auth/rate
 * limiting is entirely the injected `authorize` seam's job: this factory
 * never invents a 401 or 429 response, it only returns `auth.response`
 * verbatim on failure.
 *
 * Lifted from gtm-agent's `src/routes/api.vault.upload.ts` (the hardening
 * lineage other lifted modules in this vertical cite: gtm#584 binary
 * corruption, gtm#592 sniff gate/caps, gtm#593 batch-atomic writes) and
 * generalized the way `resolve-attachments.ts` generalized gtm's read path —
 * the vault-specific pieces (KV vault paths, frontmatter, per-user rate
 * limiting) are all injected seams here, while the validate-then-write phase
 * split and the type/size gate ordering survive byte-for-byte.
 *
 * @remarks Sibling to, NOT an extension of, `./upload.ts`'s
 * `createUploadRoute` — a different persistence model (durable product store
 * vs. inline-`data:`-or-ephemeral-sandbox-workspace). See that module's doc
 * comment for the up-to-date framing between the two.
 */

import type { ChatAttachmentInput, ChatAttachmentKind } from './wire'
import { attachmentKindForMime } from '../chat-store/parts'
import type { WriteAttachmentFn } from './attachment-store'
import {
  ALLOWED_ATTACHMENT_SNIFFED_MIMES,
  ATTACHMENT_MAX_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_BINARY_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  attachmentSizeErrorMessage,
  attachmentTotalSizeErrorMessage,
  checkAttachmentType,
  sanitizeAttachmentFileName,
} from './attachment-validation'
import { sniffBinary } from './binary-sniff'
import { defaultValidateAttachmentPath, type AttachmentPathCheck } from './resolve-attachments'
import { sniffMimeFromName } from './promote-file-part'

/** Outcome of the injected `authorize` seam: auth + rate limiting +
 *  scope resolution, all in one place so a 429 rides `{ok:false, response}`
 *  exactly like a 401 does — this factory has no rate-limit opinion of its
 *  own. `writeAttachment` lets a single request override the option-level
 *  store (e.g. routing per-tenant), defaulting to `options.writeAttachment`
 *  when absent. */
export type AttachmentUploadAuthorization =
  | { ok: true; scopeId: string; writeAttachment?: WriteAttachmentFn }
  | { ok: false; response: Response }

/** Define options to authorize, write, and limit attachment uploads in a route */
export interface CreateAttachmentUploadRouteOptions {
  /** Authenticate the caller, rate-limit, and resolve the store scope
   *  (workspace/tenant id) — never a query param. */
  authorize(args: { request: Request }): Promise<AttachmentUploadAuthorization>
  /** Default store writer. `authorize` may override it per-request. */
  writeAttachment: WriteAttachmentFn
  /** Overridable caps. Defaults come from `./attachment-validation`. */
  limits?: {
    /** Most files one request may carry. Default {@link ATTACHMENT_MAX_COUNT}. */
    maxCount?: number
    /** Ceiling on a binary file's raw size. Default {@link MAX_BINARY_ATTACHMENT_BYTES}. */
    maxBinaryBytes?: number
    /** Ceiling on a text file's raw size. Default {@link MAX_TEXT_ATTACHMENT_BYTES}. */
    maxTextBytes?: number
    /** Aggregate raw-byte ceiling across the batch. Default {@link MAX_ATTACHMENT_TOTAL_BYTES}. */
    maxTotalBytes?: number
  }
  /** Attachment kinds this route accepts. Default `['image', 'file']`. */
  allowedKinds?: ChatAttachmentKind[]
  /** Sniffed-mime allowlist fed to `checkAttachmentType`. Default
   *  {@link ALLOWED_ATTACHMENT_SNIFFED_MIMES}. */
  allowedSniffedMimes?: ReadonlySet<string>
  /** Sanitized-name → store path. Default identity (the sanitized name IS
   *  the path); gtm passes `vaultFolderForFileName`, a tenant product a
   *  scope prefix. */
  pathFor?: (name: string) => string
  /** Store-path validator. Default {@link defaultValidateAttachmentPath}. */
  validatePath?: (path: string) => AttachmentPathCheck
  /** Last-resort media-type hook for text content the sniffer can't type.
   *  Default {@link sniffMimeFromName}. */
  sniffMime?: (name: string) => string
}

function attachmentUploadError(status: number, code: string, message: string, path?: string): Response {
  return Response.json(
    { error: path === undefined ? { code, message } : { code, message, path } },
    { status },
  )
}

/** Resolve an attachment upload route handler with customizable limits and validation options */
export function createAttachmentUploadRoute(
  options: CreateAttachmentUploadRouteOptions,
): (request: Request) => Promise<Response> {
  const maxCount = options.limits?.maxCount ?? ATTACHMENT_MAX_COUNT
  const maxBinaryBytes = options.limits?.maxBinaryBytes ?? MAX_BINARY_ATTACHMENT_BYTES
  const maxTextBytes = options.limits?.maxTextBytes ?? MAX_TEXT_ATTACHMENT_BYTES
  const maxTotalBytes = options.limits?.maxTotalBytes ?? MAX_ATTACHMENT_TOTAL_BYTES
  const allowedKinds: ChatAttachmentKind[] = options.allowedKinds ?? ['image', 'file']
  const allowedSniffedMimes = options.allowedSniffedMimes ?? ALLOWED_ATTACHMENT_SNIFFED_MIMES
  const pathFor = options.pathFor ?? ((name: string) => name)
  const validatePath = options.validatePath ?? defaultValidateAttachmentPath
  const sniffMime = options.sniffMime ?? sniffMimeFromName

  return async function attachmentUpload(request: Request): Promise<Response> {
    const auth = await options.authorize({ request })
    if (!auth.ok) return auth.response
    const write = auth.writeAttachment ?? options.writeAttachment

    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return attachmentUploadError(400, 'invalid_upload', 'Expected a multipart/form-data body with file fields')
    }
    // Collect every File value regardless of field name — the client may
    // send one field per file or a single repeated field.
    const files: File[] = []
    form.forEach((value) => {
      if (value instanceof File) files.push(value)
    })
    if (files.length === 0) {
      return attachmentUploadError(400, 'invalid_upload', 'No files in the upload body')
    }

    if (files.length > maxCount) {
      return attachmentUploadError(
        400,
        'attachment_count_exceeded',
        `Too many files — the ${maxCount}-file limit was exceeded`,
      )
    }

    // Advisory only: client-controlled `file.size`, so a dishonest caller can
    // slip past it — but an honest oversized batch should fail before a
    // single byte is read. The authoritative aggregate check (against the
    // sniffed/decoded byte length) runs per-file in phase 1, below.
    const advisoryTotal = files.reduce((sum, file) => sum + file.size, 0)
    if (advisoryTotal > maxTotalBytes) {
      return attachmentUploadError(
        413,
        'attachments_total_too_large',
        attachmentTotalSizeErrorMessage(advisoryTotal, maxTotalBytes),
      )
    }

    interface PreparedWrite {
      path: string
      name: string
      bytes: Uint8Array
      originalName: string
      size: number
      mediaType: string
      kind: ChatAttachmentKind
    }

    // Phase 1: validate every file and prepare its write input WITHOUT
    // writing anything. A batch fails atomically — any file's validation
    // error must reject the whole request before an earlier file in the
    // same batch is persisted.
    const prepared: PreparedWrite[] = []
    const seenPaths = new Set<string>()
    let totalBytes = 0

    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const sniff = sniffBinary(bytes)
      // Attachment paths double as store keys, so the stored name must fit
      // the store charset; the as-uploaded name survives as `originalName`.
      const name = sanitizeAttachmentFileName(file.name)

      const typeCheck = checkAttachmentType(name, sniff, allowedSniffedMimes)
      if (!typeCheck.succeeded) {
        return attachmentUploadError(
          typeCheck.code === 'attachment_type_mismatch' ? 400 : 415,
          typeCheck.code,
          typeCheck.message,
        )
      }

      const kind = attachmentKindForMime(sniff.mime ?? '')
      if (!allowedKinds.includes(kind)) {
        return attachmentUploadError(
          415,
          'attachment_kind_not_allowed',
          `${name} is a "${kind}" attachment, which this upload route does not accept`,
        )
      }

      const limit = sniff.binary ? maxBinaryBytes : maxTextBytes
      if (bytes.length > limit) {
        return attachmentUploadError(
          413,
          'attachment_too_large',
          attachmentSizeErrorMessage(name, bytes.length, limit),
        )
      }

      const path = pathFor(name)
      const pathCheck = validatePath(path)
      if (!pathCheck.succeeded) {
        return attachmentUploadError(400, 'invalid_attachment_path', pathCheck.error, path)
      }
      // Small hardening over gtm: a batch whose sanitized names collide onto
      // the same store path (e.g. two variously-cased "Report.PDF" uploads)
      // would otherwise silently overwrite one with the other in phase 2.
      if (seenPaths.has(path)) {
        return attachmentUploadError(
          400,
          'attachment_duplicate_path',
          `attachments must not repeat a path within one upload: ${path}`,
          path,
        )
      }
      seenPaths.add(path)

      // Authoritative aggregate check, against the actual decoded byte
      // length rather than the client-reported `file.size` checked above.
      totalBytes += bytes.length
      if (totalBytes > maxTotalBytes) {
        return attachmentUploadError(
          413,
          'attachments_total_too_large',
          attachmentTotalSizeErrorMessage(totalBytes, maxTotalBytes),
        )
      }

      const mediaType = sniff.mime ?? sniffMime(name)
      prepared.push({ path, name, bytes, originalName: file.name, size: bytes.length, mediaType, kind })
    }

    // Phase 2: every file in the batch passed validation — write them all.
    const uploaded: ChatAttachmentInput[] = []
    for (const input of prepared) {
      const written = await write(auth.scopeId, input.path, input.bytes, {
        mediaType: input.mediaType,
        name: input.name,
        originalName: input.originalName,
        size: input.size,
      })
      if (!written.ok) {
        return attachmentUploadError(413, 'attachment_write_failed', written.reason, input.path)
      }
      uploaded.push({
        path: input.path,
        name: input.name,
        size: input.size,
        mediaType: input.mediaType,
        kind: input.kind,
      })
    }

    return Response.json({ files: uploaded })
  }
}
