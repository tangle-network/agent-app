/**
 * `createAttachmentUploadRoute` — the fleet-primitive durable-store upload
 * route: a two-phase batch (every file is validated before any file is written),
 * with a stable legacy lane and an ownership-safe receipt lane for new callers,
 * a content-sniffed type gate
 * (`checkAttachmentType` over `sniffBinary`'s magic-byte read, not the
 * extension or the browser-reported MIME), binary/text caps with optional
 * per-sniffed-mime overrides, an aggregate byte cap, and sanitized filenames.
 * Storage is fully seamed through the injected
 * `WriteAttachmentFn` or `AtomicAttachmentWriter` (`./attachment-store`) — no
 * default store, the product owns where bytes actually live (vault, object
 * store, …), and auth/rate limiting is entirely the injected `authorize`
 * seam's job: this factory
 * never invents a 401 or 429 response, it only returns `auth.response`
 * verbatim on failure.
 *
 * Two body shapes: a `multipart/form-data` batch, parsed whole, and one raw
 * file body named by the `filename` query parameter. A raw body larger than
 * the sniff head streams to `writeAttachmentStream` when the product supplies
 * one: the Worker never holds the file whole, which is what lets a product
 * admit data files of tens of MB inside a 128 MB isolate.
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

import { formatBytes, type ChatAttachmentInput, type ChatAttachmentKind } from './wire'
import { attachmentKindForMime } from '../chat-store/parts'
import { redactErrorMessage } from '../redact'
import {
  ATTACHMENT_ROLLBACK_FAILURE_CODE,
  ATTACHMENT_ROLLBACK_FAILURE_MESSAGE,
  ATTACHMENT_STORAGE_FAILURE_MESSAGE,
  type AtomicAttachmentWriter,
  immutableAttachmentPath,
  type AttachmentWriteOwnership,
  type AttachmentWriteReceipt,
  type WriteAttachmentFn,
  type WriteAttachmentStreamFn,
} from './attachment-store'
import {
  logAttachmentStorageError,
  inspectAtomicAttachmentWriteResult,
  inspectLegacyAttachmentWriteResult,
} from './attachment-write-safety'
import {
  ALLOWED_ATTACHMENT_SNIFFED_MIMES,
  ATTACHMENT_MAX_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_BINARY_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  attachmentSizeErrorMessage,
  attachmentTotalSizeErrorMessage,
  checkAttachmentType,
  defaultValidateAttachmentPath,
  sanitizeAttachmentFileName,
  sniffedMimeImpliedByName,
  type AttachmentPathCheck,
} from './attachment-validation'
import { createStreamingSniffer, sniffBinary, STREAM_SNIFF_HEAD_BYTES, type SniffResult } from './binary-sniff'
import { sniffMimeFromName } from './promote-file-part'

/** Stable authorization result for the original writer contract. */
export type AttachmentUploadAuthorization =
  | {
      ok: true
      scopeId: string
      writeAttachment?: WriteAttachmentFn
      writeAttachmentStream?: WriteAttachmentStreamFn
    }
  | { ok: false; response: Response }

/** Authorization result for an ownership-safe attachment writer. */
export type AtomicAttachmentUploadAuthorization =
  | {
      ok: true
      scopeId: string
      attachmentWriter?: AtomicAttachmentWriter
    }
  | { ok: false; response: Response }

/** The logger receives only sanitized backend details. The client receives the
 * opaque message below, regardless of the store's failure text. */
export type AttachmentUploadLogger = Pick<Console, 'error'>



interface AttachmentUploadRouteCommonOptions {
  /** Overridable caps. Defaults come from `./attachment-validation`. */
  limits?: {
    /** Most files one request may carry. Default {@link ATTACHMENT_MAX_COUNT}. */
    maxCount?: number
    /** Ceiling on a binary file's raw size. Default {@link MAX_BINARY_ATTACHMENT_BYTES}. */
    maxBinaryBytes?: number
    /** Optional binary-file ceilings keyed by the content-sniffed mime. */
    maxBytesBySniffedMime?: ReadonlyMap<string, number>
    /** Ceiling on a text file's raw size. Default {@link MAX_TEXT_ATTACHMENT_BYTES}. */
    maxTextBytes?: number
    /** Aggregate raw-byte ceiling. Default {@link MAX_ATTACHMENT_TOTAL_BYTES}. */
    maxTotalBytes?: number
    /** Largest `multipart/form-data` body this route parses. A form body is
     *  held whole while it parses, at about three copies at peak, so a
     *  product that admits files too large for that sets this and takes them
     *  as raw bodies (see {@link createAttachmentUploadRoute}). Default: no
     *  limit beyond the per-file and aggregate caps. */
    maxFormBytes?: number
  }
  /** Attachment kinds this route accepts. Default `['image', 'file']`. */
  allowedKinds?: ChatAttachmentKind[]
  /** Sniffed-mime allowlist fed to `checkAttachmentType`. */
  allowedSniffedMimes?: ReadonlySet<string>
  /** Sanitized-name → logical store path. */
  pathFor?: (name: string) => string
  /** Store-path validator. Default {@link defaultValidateAttachmentPath}. */
  validatePath?: (path: string) => AttachmentPathCheck
  /** Last-resort media-type hook for text content the sniffer cannot type. */
  sniffMime?: (name: string) => string
  /** Unique id source for atomic ownership keys. */
  createWriteId?: () => string
  /** Server-side error sink. Backend text is sanitized before it is logged. */
  logger?: AttachmentUploadLogger
}

/** Stable route options for products using the original writer contract. */
export interface CreateLegacyAttachmentUploadRouteOptions extends AttachmentUploadRouteCommonOptions {
  /** Authenticate the caller, rate-limit, and resolve the store scope
   *  (workspace/tenant id) — never a query param. */
  authorize(args: { request: Request }): Promise<AttachmentUploadAuthorization>
  /** Stable writer. `authorize` may override it per-request. */
  writeAttachment: WriteAttachmentFn
  /** Writer for a raw-body upload larger than {@link STREAM_SNIFF_HEAD_BYTES}:
   *  the route checks the file while it streams to this writer, so the file
   *  is never held whole. Without it, a raw body is read whole and goes
   *  through `writeAttachment` under the same caps. */
  writeAttachmentStream?: WriteAttachmentStreamFn
}

/**
 * The original public route-options interface remains available for consumers
 * that extend it. Ownership-safe callers use the atomic interface below.
 */
export interface CreateAttachmentUploadRouteOptions extends CreateLegacyAttachmentUploadRouteOptions {}

/** Ownership-safe route options for new products. */
export interface CreateAtomicAttachmentUploadRouteOptions extends AttachmentUploadRouteCommonOptions {
  /** Authenticate the caller, rate-limit, and resolve the store scope. */
  authorize(args: { request: Request }): Promise<AtomicAttachmentUploadAuthorization>
  /** Complete writer + ambiguous-write cleanup adapter. */
  attachmentWriter: AtomicAttachmentWriter
}

function attachmentUploadError(status: number, code: string, message: string, path?: string): Response {
  return Response.json(
    { error: path === undefined ? { code, message } : { code, message, path } },
    { status },
  )
}

function atomicAttachmentFailure(path: string, cleanupFailures = 0): Response {
  return attachmentUploadError(
    503,
    cleanupFailures > 0 ? ATTACHMENT_ROLLBACK_FAILURE_CODE : 'attachment_store_unavailable',
    cleanupFailures > 0 ? ATTACHMENT_ROLLBACK_FAILURE_MESSAGE : ATTACHMENT_STORAGE_FAILURE_MESSAGE,
    path,
  )
}

/** Longest raw-upload `filename` accepted. */
const MAX_RAW_FILENAME_LENGTH = 255

type RawUploadTarget =
  | { succeeded: true; filename: string; declaredBytes: number }
  | { succeeded: false; response: Response }

/**
 * A raw upload is one file as the request body, named by the `filename`
 * query parameter, with its size in `Content-Length` or `X-Upload-Length`
 * (the browser's `File.size`), as in `/object-store`'s upload route. Knowing
 * the size up front is what lets a store receive a fixed-length stream.
 */
function rawUploadTarget(request: Request): RawUploadTarget {
  const filename = new URL(request.url).searchParams.get('filename')
  if (!filename || filename.length > MAX_RAW_FILENAME_LENGTH) {
    return {
      succeeded: false,
      response: attachmentUploadError(
        400,
        'invalid_upload',
        'Expected a multipart/form-data body with file fields, or one raw file body named by the filename query parameter',
      ),
    }
  }
  const uploadLength = request.headers.get('X-Upload-Length')
  const transportLength = request.headers.get('Content-Length')
  if (uploadLength !== null && transportLength !== null && uploadLength !== transportLength) {
    return { succeeded: false, response: attachmentUploadError(400, 'invalid_length', 'Conflicting upload lengths') }
  }
  const declared = uploadLength ?? transportLength
  if (declared === null) {
    return {
      succeeded: false,
      response: attachmentUploadError(411, 'length_required', 'A raw upload declares its size in Content-Length or X-Upload-Length'),
    }
  }
  const declaredBytes = Number(declared)
  if (!/^(0|[1-9]\d*)$/.test(declared) || !Number.isSafeInteger(declaredBytes)) {
    return { succeeded: false, response: attachmentUploadError(400, 'invalid_length', 'Invalid upload length') }
  }
  return { succeeded: true, filename, declaredBytes }
}

const LENGTH_MISMATCH_MESSAGE = 'Upload length does not match the file body'

/** Read a small raw body whole, refusing one longer or shorter than declared. */
async function readRawBody(
  request: Request,
  declaredBytes: number,
): Promise<{ succeeded: true; value: Uint8Array<ArrayBuffer> } | { succeeded: false; response: Response }> {
  const mismatch = { succeeded: false as const, response: attachmentUploadError(400, 'invalid_length', LENGTH_MISMATCH_MESSAGE) }
  const bytes = new Uint8Array(declaredBytes)
  if (!request.body) return declaredBytes === 0 ? { succeeded: true, value: bytes } : mismatch
  const reader = request.body.getReader()
  let offset = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.length > declaredBytes) {
        await reader.cancel().catch(() => undefined)
        return mismatch
      }
      bytes.set(value, offset)
      offset += value.length
    }
  } catch {
    return { succeeded: false, response: attachmentUploadError(400, 'invalid_upload', 'The upload body ended early') }
  }
  return offset === declaredBytes ? { succeeded: true, value: bytes } : mismatch
}

/** Read a body of at most `maxBytes`, refusing a longer one as soon as it
 *  passes the cap. A declared `Content-Length` over the cap is refused before
 *  any byte is read. */
async function readBodyUpTo(
  request: Request,
  maxBytes: number,
): Promise<{ succeeded: true; value: Uint8Array<ArrayBuffer> } | { succeeded: false; tooLarge: boolean }> {
  const declared = Number(request.headers.get('Content-Length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) return { succeeded: false, tooLarge: true }
  if (!request.body) return { succeeded: true, value: new Uint8Array(0) }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { succeeded: false, tooLarge: true }
      }
      chunks.push(value)
    }
  } catch {
    return { succeeded: false, tooLarge: false }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { succeeded: true, value: bytes }
}

/** The media type a streamed write records before the whole file is read.
 *  The head decides every family except a zip container, whose Office
 *  subtype lives in the central directory at the end; for that, the
 *  extension's implied type stands in, and the route's response carries the
 *  final one. */
function provisionalMediaType(name: string, head: SniffResult, sniffMime: (name: string) => string): string {
  if (!head.binary) return sniffMime(name)
  if (head.mime === 'application/zip') return sniffedMimeImpliedByName(name) ?? head.mime
  return head.mime ?? 'application/octet-stream'
}

interface SuccessfulAttachmentWrite {
  path: string
  ownership: AttachmentWriteOwnership
  receipt: AttachmentWriteReceipt
}

/** Run every available compensation, from the newest write to the oldest. The
 * receipt owns the compare-and-delete operation; this route never deletes a
 * logical path itself. */
async function rollbackSuccessfulWrites(
  writes: readonly SuccessfulAttachmentWrite[],
  scopeId: string,
  writer: AtomicAttachmentWriter,
  logger: AttachmentUploadLogger,
): Promise<number> {
  let failures = 0
  for (let index = writes.length - 1;index >= 0;index -= 1) {
    const write = writes[index]!
    try {
      await write.receipt.rollback()
    } catch (error) {
      failures += 1
      logAttachmentStorageError(logger, '[attachment-upload] cleanup failed', {
        path: write.path,
        ownershipId: write.ownership.id,
        error: redactErrorMessage(error),
      })
      failures += await abortOwnership(writer, scopeId, write.ownership, logger)
    }
  }
  return failures
}

async function abortOwnership(
  writer: AtomicAttachmentWriter,
  scopeId: string,
  ownership: AttachmentWriteOwnership,
  logger: AttachmentUploadLogger,
): Promise<number> {
  try {
    await writer.abort(scopeId, ownership)
    return 0
  } catch (error) {
    logAttachmentStorageError(logger, '[attachment-upload] ambiguous write cleanup failed', {
      path: ownership.path,
      ownershipId: ownership.id,
      error: redactErrorMessage(error),
    })
    return 1
  }
}

function isAtomicRouteOptions(
  options: CreateAttachmentUploadRouteOptions | CreateAtomicAttachmentUploadRouteOptions,
): options is CreateAtomicAttachmentUploadRouteOptions {
  return 'attachmentWriter' in options
}

/** Resolve an attachment upload route handler with customizable limits and validation options. */
export function createAttachmentUploadRoute(
  options: CreateAttachmentUploadRouteOptions | CreateAtomicAttachmentUploadRouteOptions,
): (request: Request) => Promise<Response> {
  const atomic = isAtomicRouteOptions(options)
  const maxCount = options.limits?.maxCount ?? ATTACHMENT_MAX_COUNT
  const maxBinaryBytes = options.limits?.maxBinaryBytes ?? MAX_BINARY_ATTACHMENT_BYTES
  const maxBytesBySniffedMime = options.limits?.maxBytesBySniffedMime
  const maxTextBytes = options.limits?.maxTextBytes ?? MAX_TEXT_ATTACHMENT_BYTES
  const maxTotalBytes = options.limits?.maxTotalBytes ?? MAX_ATTACHMENT_TOTAL_BYTES
  const allowedKinds: ChatAttachmentKind[] = options.allowedKinds ?? ['image', 'file']
  const allowedSniffedMimes = options.allowedSniffedMimes ?? ALLOWED_ATTACHMENT_SNIFFED_MIMES
  const pathFor = options.pathFor ?? ((name: string) => name)
  const validatePath = options.validatePath ?? defaultValidateAttachmentPath
  const sniffMime = options.sniffMime ?? sniffMimeFromName
  const createWriteId = atomic
    ? options.createWriteId ?? (() => {
        if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
          throw new Error('attachment upload requires crypto.randomUUID')
        }
        return crypto.randomUUID()
      })
    : undefined
  const logger = options.logger ?? console
  const maxFormBytes = options.limits?.maxFormBytes
  const streamWriter = atomic ? undefined : options.writeAttachmentStream
  const limitFor = (sniff: SniffResult): number => {
    if (!sniff.binary) return maxTextBytes
    return sniff.mime === null ? maxBinaryBytes : maxBytesBySniffedMime?.get(sniff.mime) ?? maxBinaryBytes
  }
  // The most any admitted type may weigh, checked against a raw upload's
  // declared size before a byte is read; the type's own cap is checked once
  // the content is known.
  const largestFileBytes = Math.max(maxTextBytes, maxBinaryBytes, ...(maxBytesBySniffedMime?.values() ?? []))

  /**
   * The streamed lane: one raw body larger than the sniff head, written as it
   * arrives. The sniffer keeps only the head and tail, and the last chunk is
   * withheld until the whole file passes the type, kind and size gates, so a
   * refused file never reaches the store in full and its write fails.
   */
  const { streamRawUpload } = createRawUploadStream(sniffMime, allowedSniffedMimes, allowedKinds, limitFor, logger)

  return async function attachmentUpload(request: Request): Promise<Response> {
    const auth = await options.authorize({ request })
    if (!auth.ok) return auth.response
    const atomicWriter = atomic
      ? (auth as Extract<AtomicAttachmentUploadAuthorization, { ok: true }>).attachmentWriter ?? options.attachmentWriter
      : undefined
    const legacyWriter = atomic
      ? undefined
      : (auth as Extract<AttachmentUploadAuthorization, { ok: true }>).writeAttachment ?? options.writeAttachment
    if (atomic && !atomicWriter) {
      return attachmentUploadError(503, 'attachment_store_unavailable', ATTACHMENT_STORAGE_FAILURE_MESSAGE)
    }

    const files: File[] = []
    const contentType = request.headers.get('Content-Type')?.toLowerCase() ?? ''
    if (!contentType.startsWith('multipart/form-data')) {
      const target = rawUploadTarget(request)
      if (!target.succeeded) return target.response
      const { filename, declaredBytes } = target
      const name = sanitizeAttachmentFileName(filename)
      if (declaredBytes > largestFileBytes) {
        return attachmentUploadError(413, 'attachment_too_large', attachmentSizeErrorMessage(name, declaredBytes, largestFileBytes))
      }
      if (declaredBytes > maxTotalBytes) {
        return attachmentUploadError(413, 'attachments_total_too_large', attachmentTotalSizeErrorMessage(declaredBytes, maxTotalBytes))
      }
      if (streamWriter && declaredBytes > STREAM_SNIFF_HEAD_BYTES) {
        const path = pathFor(name)
        const pathCheck = validatePath(path)
        if (!pathCheck.succeeded) return attachmentUploadError(400, 'invalid_attachment_path', pathCheck.error, path)
        const writer = (auth as Extract<AttachmentUploadAuthorization, { ok: true }>).writeAttachmentStream ?? streamWriter
        return streamRawUpload({ request, scopeId: auth.scopeId, writer, filename, name, path, declaredBytes })
      }
      // A small raw body takes the batch path below as a one-file batch.
      const body = await readRawBody(request, declaredBytes)
      if (!body.succeeded) return body.response
      files.push(new File([body.value], filename))
    } else {
      let formSource: Request | Response = request
      if (maxFormBytes !== undefined) {
        // Read at most the cap before parsing, whether or not the client sent
        // a Content-Length, so an oversized form is refused while small.
        const bounded = await readBodyUpTo(request, maxFormBytes)
        if (!bounded.succeeded && !bounded.tooLarge) {
          return attachmentUploadError(400, 'invalid_upload', 'The upload body ended early')
        }
        if (!bounded.succeeded) {
          return attachmentUploadError(
            413,
            'form_upload_too_large',
            `Form uploads are limited to ${formatBytes(maxFormBytes)}; send a larger file as a raw request body named by the filename query parameter`,
          )
        }
        formSource = new Response(bounded.value, { headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' } })
      }
      let form: FormData
      try {
        form = await formSource.formData()
      } catch {
        return attachmentUploadError(400, 'invalid_upload', 'Expected a multipart/form-data body with file fields')
      }
      // Collect every File value regardless of field name — the client may
      // send one field per file or a single repeated field.
      form.forEach((value) => {
        if (value instanceof File) files.push(value)
      })
    }
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

    const preparedBatch = await prepareUploadBatch(files, allowedSniffedMimes, allowedKinds, limitFor, pathFor, atomic, createWriteId, logger, validatePath, maxTotalBytes, sniffMime)
    if (preparedBatch instanceof Response) return preparedBatch
    const { prepared } = preparedBatch

    return await commitUploadBatch(prepared, legacyWriter, auth, atomicWriter, atomic, logger)
  }
}

interface PreparedWrite {
  path: string
  ownershipId?: string
  name: string
  bytes: Uint8Array
  originalName: string
  size: number
  mediaType: string
  kind: ChatAttachmentKind
}


function createRawUploadStream(
  sniffMime: (name: string) => string,
  allowedSniffedMimes: ReadonlySet<string>,
  allowedKinds: ChatAttachmentKind[],
  limitFor: (sniff: SniffResult) => number,
  logger: AttachmentUploadLogger,
) {
  async function streamRawUpload(input: {
    request: Request
    scopeId: string
    writer: WriteAttachmentStreamFn
    filename: string
    name: string
    path: string
    declaredBytes: number
  }): Promise<Response> {
    const { request, declaredBytes, name, path } = input
    if (!request.body) return attachmentUploadError(400, 'invalid_length', LENGTH_MISMATCH_MESSAGE)
    const reader = request.body.getReader()
    const sniffer = createStreamingSniffer()
    const head: Uint8Array[] = []
    let refusal: Response | undefined
    const tooLong = () => attachmentUploadError(400, 'invalid_length', LENGTH_MISMATCH_MESSAGE)

    try {
      while (sniffer.size < STREAM_SNIFF_HEAD_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        if (sniffer.size + value.length > declaredBytes) {
          await reader.cancel().catch(() => undefined)
          return tooLong()
        }
        sniffer.push(value)
        head.push(value)
      }
    } catch {
      return attachmentUploadError(400, 'invalid_upload', 'The upload body ended early')
    }
    const mediaTypeBeforeEnd = provisionalMediaType(name, sniffBinary(sniffer.head()), sniffMime)

    let held = head.pop()
    let finalSniff: SniffResult | undefined
    const refuse = (controller: ReadableStreamDefaultController<Uint8Array>, response: Response) => {
      refusal = response
      controller.error(new Error('attachment upload refused'))
    }
    const content = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of head) controller.enqueue(chunk)
      },
      async pull(controller) {
        let next: ReadableStreamReadResult<Uint8Array>
        try {
          next = await reader.read()
        } catch {
          refuse(controller, attachmentUploadError(400, 'invalid_upload', 'The upload body ended early'))
          return
        }
        if (!next.done) {
          if (sniffer.size + next.value.length > declaredBytes) {
            await reader.cancel().catch(() => undefined)
            refuse(controller, tooLong())
            return
          }
          sniffer.push(next.value)
          if (held) controller.enqueue(held)
          held = next.value
          return
        }
        if (sniffer.size !== declaredBytes) {
          refuse(controller, tooLong())
          return
        }
        const sniff = sniffer.finish()
        const typeCheck = checkAttachmentType(name, sniff, allowedSniffedMimes)
        if (!typeCheck.succeeded) {
          refuse(controller, attachmentUploadError(
            typeCheck.code === 'attachment_type_mismatch' ? 400 : 415,
            typeCheck.code,
            typeCheck.message,
          ))
          return
        }
        const kind = attachmentKindForMime(sniff.mime ?? '')
        if (!allowedKinds.includes(kind)) {
          refuse(controller, attachmentUploadError(
            415,
            'attachment_kind_not_allowed',
            `${name} is a "${kind}" attachment, which this upload route does not accept`,
          ))
          return
        }
        const limit = limitFor(sniff)
        if (declaredBytes > limit) {
          refuse(controller, attachmentUploadError(413, 'attachment_too_large', attachmentSizeErrorMessage(name, declaredBytes, limit)))
          return
        }
        finalSniff = sniff
        if (held) controller.enqueue(held)
        held = undefined
        controller.close()
      },
      cancel(reason) {
        return reader.cancel(reason).catch(() => undefined)
      },
    }, { highWaterMark: 0 })

    let written: unknown
    try {
      written = await input.writer(input.scopeId, path, content, {
        mediaType: mediaTypeBeforeEnd,
        name,
        originalName: input.filename,
        size: declaredBytes,
      })
    } catch (error) {
      if (!finalSniff) await reader.cancel().catch(() => undefined)
      if (refusal) return refusal
      logAttachmentStorageError(logger, '[attachment-upload] stream writer failed', { path, error: redactErrorMessage(error) })
      return attachmentUploadError(503, 'attachment_store_unavailable', ATTACHMENT_STORAGE_FAILURE_MESSAGE, path)
    }
    if (!finalSniff) await reader.cancel().catch(() => undefined)
    if (refusal) return refusal
    const result = inspectLegacyAttachmentWriteResult(written)
    if (!result || (result.ok && !finalSniff)) {
      // A writer that reports success without reading the file to its end
      // stored something the route never checked.
      logAttachmentStorageError(logger, '[attachment-upload] stream writer returned without a checked file', { path })
      return attachmentUploadError(503, 'attachment_store_unavailable', ATTACHMENT_STORAGE_FAILURE_MESSAGE, path)
    }
    if (!result.ok) {
      const reason = redactErrorMessage(result.reason)
      logAttachmentStorageError(logger, '[attachment-upload] stream write rejected', { path, error: reason })
      return attachmentUploadError(413, 'attachment_write_failed', reason, path)
    }
    const sniff = finalSniff!
    const uploaded: ChatAttachmentInput = {
      path,
      name,
      size: declaredBytes,
      mediaType: sniff.mime ?? sniffMime(name),
      kind: attachmentKindForMime(sniff.mime ?? ''),
    }
    return Response.json({ files: [uploaded] })
  }
  return { streamRawUpload }
}

async function prepareUploadBatch(
  files: File[],
  allowedSniffedMimes: ReadonlySet<string>,
  allowedKinds: ChatAttachmentKind[],
  limitFor: (sniff: SniffResult) => number,
  pathFor: (name: string) => string,
  atomic: boolean,
  createWriteId: (() => string) | undefined,
  logger: AttachmentUploadLogger,
  validatePath: (path: string) => AttachmentPathCheck,
  maxTotalBytes: number,
  sniffMime: (name: string) => string,
) {
  // Phase 1: validate every file and prepare its write input WITHOUT
  // writing anything. A batch fails atomically — any file's validation
  // error must reject the whole request before an earlier file in the
  // same batch is persisted.
  const prepared: PreparedWrite[] = []
  const seenLogicalPaths = new Set<string>()
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

    const limit = limitFor(sniff)
    if (bytes.length > limit) {
      return attachmentUploadError(
        413,
        'attachment_too_large',
        attachmentSizeErrorMessage(name, bytes.length, limit),
      )
    }

    const logicalPath = pathFor(name)
    let ownershipId: string | undefined
    let path = logicalPath
    if (atomic) {
      try {
        ownershipId = createWriteId!()
        path = immutableAttachmentPath(logicalPath, ownershipId)
      } catch (error) {
        logAttachmentStorageError(logger, '[attachment-upload] could not allocate ownership key', {
          path: logicalPath,
          error: redactErrorMessage(error),
        })
        return attachmentUploadError(
          503,
          'attachment_store_unavailable',
          ATTACHMENT_STORAGE_FAILURE_MESSAGE,
          logicalPath,
        )
      }
    }
    const pathCheck = validatePath(path)
    if (!pathCheck.succeeded) {
      return attachmentUploadError(400, 'invalid_attachment_path', pathCheck.error, path)
    }
    // Small hardening over gtm: a batch whose sanitized names collide onto
    // the same store path (e.g. two variously-cased "Report.PDF" uploads)
    // would otherwise silently overwrite one with the other in phase 2.
    const duplicatePath = atomic ? logicalPath : path
    if (seenLogicalPaths.has(duplicatePath)) {
      return attachmentUploadError(
        400,
        'attachment_duplicate_path',
        `attachments must not repeat a path within one upload: ${duplicatePath}`,
        path,
      )
    }
    seenLogicalPaths.add(duplicatePath)

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
    prepared.push({ path, ownershipId, name, bytes, originalName: file.name, size: bytes.length, mediaType, kind })
  }
  return { prepared }
}

async function commitUploadBatch(
  prepared: PreparedWrite[],
  legacyWriter: WriteAttachmentFn | undefined,
  auth: { ok: true; scopeId: string; writeAttachment?: WriteAttachmentFn; writeAttachmentStream?: WriteAttachmentStreamFn } | { ok: true; scopeId: string; attachmentWriter?: AtomicAttachmentWriter },
  atomicWriter: AtomicAttachmentWriter | undefined,
  atomic: boolean,
  logger: AttachmentUploadLogger,
) {
  // Phase 2: every file in the batch passed validation — write them all.
  const uploaded: ChatAttachmentInput[] = []
  const successfulWrites: SuccessfulAttachmentWrite[] = []
  for (const input of prepared) {
    if (!atomic) {
      let written: unknown
      try {
        written = await legacyWriter!(auth.scopeId, input.path, input.bytes, {
          mediaType: input.mediaType,
          name: input.name,
          originalName: input.originalName,
          size: input.size,
        })
      } catch (error) {
        logAttachmentStorageError(logger, '[attachment-upload] legacy writer failed', {
          path: input.path,
          error: redactErrorMessage(error),
        })
        return attachmentUploadError(
          503,
          'attachment_store_unavailable',
          ATTACHMENT_STORAGE_FAILURE_MESSAGE,
          input.path,
        )
      }
      const result = inspectLegacyAttachmentWriteResult(written)
      if (!result) {
        logAttachmentStorageError(logger, '[attachment-upload] legacy writer returned an invalid result', {
          path: input.path,
        })
        return attachmentUploadError(
          503,
          'attachment_store_unavailable',
          ATTACHMENT_STORAGE_FAILURE_MESSAGE,
          input.path,
        )
      }
      if (!result.ok) {
        const reason = redactErrorMessage(result.reason)
        logAttachmentStorageError(logger, '[attachment-upload] legacy write rejected', {
          path: input.path,
          error: reason,
        })
        return attachmentUploadError(413, 'attachment_write_failed', reason, input.path)
      }
      uploaded.push({
        path: input.path,
        name: input.name,
        size: input.size,
        mediaType: input.mediaType,
        kind: input.kind,
      })
      continue
    }

    const ownershipId = input.ownershipId
    if (!ownershipId) {
      return attachmentUploadError(503, 'attachment_store_unavailable', ATTACHMENT_STORAGE_FAILURE_MESSAGE, input.path)
    }
    const ownership: AttachmentWriteOwnership = Object.freeze({ id: ownershipId, path: input.path })
    let written: Awaited<ReturnType<AtomicAttachmentWriter['write']>>
    try {
      written = await atomicWriter!.write(auth.scopeId, input.path, input.bytes, {
        mediaType: input.mediaType,
        name: input.name,
        originalName: input.originalName,
        size: input.size,
        ownership,
      })
    } catch (error) {
      const cleanupFailures = (await abortOwnership(atomicWriter!, auth.scopeId, ownership, logger)) +
        await rollbackSuccessfulWrites(successfulWrites, auth.scopeId, atomicWriter!, logger)
      logAttachmentStorageError(logger, '[attachment-upload] write failed', {
        path: input.path,
        ownershipId: ownership.id,
        cleanupFailures,
        error: redactErrorMessage(error),
      })
      return atomicAttachmentFailure(input.path, cleanupFailures)
    }
    const result = inspectAtomicAttachmentWriteResult(written, ownership)
    if (!result) {
      const cleanupFailures = (await abortOwnership(atomicWriter!, auth.scopeId, ownership, logger)) +
        await rollbackSuccessfulWrites(successfulWrites, auth.scopeId, atomicWriter!, logger)
      logAttachmentStorageError(logger, '[attachment-upload] writer returned a mismatched ownership receipt', {
        path: input.path,
        ownershipId: ownership.id,
        cleanupFailures,
      })
      return atomicAttachmentFailure(input.path, cleanupFailures)
    }
    if (!result.ok) {
      const cleanupFailures = (await rollbackSuccessfulWrites([
        { path: input.path, ownership, receipt: result.receipt },
      ], auth.scopeId, atomicWriter!, logger)) + await rollbackSuccessfulWrites(
        successfulWrites,
        auth.scopeId,
        atomicWriter!,
        logger,
      )
      logAttachmentStorageError(logger, '[attachment-upload] write rejected', {
        path: input.path,
        ownershipId: ownership.id,
        cleanupFailures,
        error: redactErrorMessage(result.reason),
      })
      return atomicAttachmentFailure(input.path, cleanupFailures)
    }
    successfulWrites.push({ path: input.path, ownership, receipt: result.receipt })
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
