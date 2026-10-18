/**
 * `resolveChatAttachments` — validate a turn body's `attachments` field into
 * persistable {@link ChatAttachmentPart}s. Every path is re-validated (a path
 * off the wire is never trusted to stay inside the store root) and every size
 * is re-derived from the STORED body via the injected {@link ReadAttachmentFn},
 * never the client-reported `size` — the upload path lets a caller rewrite its
 * own frontmatter, so a stored size cannot bound anything and the wire size can
 * be anything. Both the aggregate cap and the size carried on the returned part
 * come from the authoritative read.
 *
 * Storage-parameterized: the frontmatter parsing / base64 sizing that derives
 * the authoritative size lives BEHIND `readAttachment` (a product's vault or
 * object-store adapter), so this module is a pure validator + budget gate with
 * no store knowledge. Lifted from gtm-agent's `resolve-attachments.ts`
 * (workspaceId → scopeId, the vault read → the injected reader) and kept
 * behavior-identical for gtm-agent#618 adoption.
 */

import { attachmentInputToPart, type ChatAttachmentPart } from '../chat-store/parts'
import type { ReadAttachmentFn } from './attachment-store'
import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  attachmentTotalSizeErrorMessage,
  parseChatAttachmentInputs,
  type AttachmentPathCheck,
} from './attachment-validation'

/** Resolve the result of chat attachment processing with success status and corresponding data or error */
export type ResolveChatAttachmentsResult =
  | { succeeded: true; value: ChatAttachmentPart[] }
  | { succeeded: false; error: string }

/** Define options to resolve and validate chat attachments with size, count, and path constraints */
export interface ResolveChatAttachmentsOptions {
  /** The product's workspace/tenant key, passed to `readAttachment`. */
  scopeId: string
  /** Authoritative size + content reader — see {@link ReadAttachmentFn}. */
  readAttachment: ReadAttachmentFn
  /** Most attachments one request may carry. Default {@link ATTACHMENT_MAX_COUNT}. */
  maxCount?: number
  /** Aggregate raw-byte ceiling. Default {@link MAX_ATTACHMENT_TOTAL_BYTES}. */
  maxTotalBytes?: number
  /** Path validator override. Default {@link defaultValidateAttachmentPath}. */
  validatePath?: (path: string) => AttachmentPathCheck
}

/**
 * Validate and resolve a turn body's `attachments` field into persistable
 * parts. Every path is confirmed present (and not deleted) in the caller's own
 * store by `readAttachment` before it is trusted, and size is derived from the
 * authoritative read for both the aggregate cap and the returned part's size.
 */
export async function resolveChatAttachments(
  value: unknown,
  options: ResolveChatAttachmentsOptions,
): Promise<ResolveChatAttachmentsResult> {
  const maxTotalBytes = options.maxTotalBytes ?? MAX_ATTACHMENT_TOTAL_BYTES
  const parsed = parseChatAttachmentInputs(value, options)
  if (!parsed.succeeded) return parsed
  const inputs = parsed.value

  // Advisory only: client-controlled, so a dishonest caller can slip past it —
  // but an honest oversized request should fail before it costs a single store
  // read. The authoritative check runs per-attachment below, against the
  // body-derived size.
  const advisoryTotal = inputs.reduce((sum, input) => sum + input.size, 0)
  if (advisoryTotal > maxTotalBytes) {
    return { succeeded: false, error: attachmentTotalSizeErrorMessage(advisoryTotal, maxTotalBytes) }
  }

  // One attachment is read, sized, and dropped at a time rather than via
  // Promise.all — that would materialize every attachment's body in memory
  // simultaneously (ten truthful 10 MiB references is ~134 MiB of base64, over
  // a Workers heap) before the cap ever gets a chance to reject the request.
  // Sequential reads bound resident bytes to one attachment at a time and bail
  // the moment the running total exceeds the cap, at the cost of up to
  // `maxCount` serial reads instead of one parallel batch.
  let totalStoredBytes = 0
  for (const input of inputs) {
    const read = await options.readAttachment(options.scopeId, input.path)
    if (!read.ok) return { succeeded: false, error: read.reason }
    totalStoredBytes += read.size
    if (totalStoredBytes > maxTotalBytes) {
      return { succeeded: false, error: attachmentTotalSizeErrorMessage(totalStoredBytes, maxTotalBytes) }
    }
    input.size = read.size
  }

  return { succeeded: true, value: inputs.map(attachmentInputToPart) }
}
