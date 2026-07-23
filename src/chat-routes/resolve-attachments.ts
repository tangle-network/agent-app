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

import type { ChatAttachmentInput, ChatAttachmentKind } from './wire'
import { attachmentInputToPart, type ChatAttachmentPart } from '../chat-store/parts'
import type { ReadAttachmentFn } from './attachment-store'
import { ATTACHMENT_MAX_COUNT, MAX_ATTACHMENT_TOTAL_BYTES, attachmentTotalSizeErrorMessage } from './attachment-validation'

export type ResolveChatAttachmentsResult =
  | { succeeded: true; value: ChatAttachmentPart[] }
  | { succeeded: false; error: string }

/** Verdict of a path check: OK, or a rejection naming why. Mirrors
 *  `SandboxMentionPathCheck` in `./wire`. */
export type AttachmentPathCheck =
  | { succeeded: true }
  | { succeeded: false; error: string }

/** Longest attachment display name accepted — bounds what gets echoed into the
 *  prompt block and rendered as a chip label. */
const MAX_ATTACHMENT_NAME_LENGTH = 256

function isAttachmentKind(value: unknown): value is ChatAttachmentKind {
  return value === 'image' || value === 'file'
}

/** C0 control characters (0x00–0x1F) plus DEL (0x7F) — covers `\n`/`\r`/`\t`.
 *  A `name` or `path` carrying one of these has no legitimate use here and
 *  everything to gain from an attacker: {@link buildAttachmentPromptBlock} in
 *  `/chat-store` renders both fields verbatim into the dispatched agent
 *  prompt, so an embedded newline fabricates new prompt lines (a
 *  prompt-injection vector) rather than naming a file. Rejected at this
 *  boundary — not merely neutralized downstream — so the wire never accepts
 *  the input in the first place; a legitimate name/path never contains one. */
const CONTROL_CHARS = /[\x00-\x1F\x7F]/

/**
 * Default path validator when a caller supplies none. Rejects the ways a path
 * picked in a client can escape the store root — traversal (`..` segment),
 * absolute (leading `/`), backslashes, null bytes, control characters (see
 * {@link CONTROL_CHARS} — a path also feeds {@link buildAttachmentPromptBlock}'s
 * `(vault: ${path})` pointer, so it is exposed to the same injection surface as
 * `name`) — plus a dotfile/hidden segment (a leading `.` on any segment).
 * Generalized from gtm's `validateVaultFilePath`, in the spirit of
 * `validateSandboxMentionPath` (`/chat-routes`'s wire mention-path validator) —
 * but the dotfile rejection here is INTENTIONALLY stricter than that sibling:
 * an uploaded attachment path is sanitized store-relative storage the product
 * itself assigned, whereas a mention path points at a file that already exists
 * in the sandbox and may legitimately live under a dotfile segment. A caller
 * that needs gtm's exact (looser) rule can supply `validatePath` to override
 * this default entirely.
 */
export function defaultValidateAttachmentPath(path: string): AttachmentPathCheck {
  if (path.includes('\0')) return { succeeded: false, error: 'attachment path must not contain null bytes' }
  if (path.includes('\\')) return { succeeded: false, error: 'attachment path must not contain backslashes' }
  if (CONTROL_CHARS.test(path)) return { succeeded: false, error: 'attachment path must not contain control characters' }
  if (path.startsWith('/')) return { succeeded: false, error: 'attachment path must be store-relative, not absolute' }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '..')) {
    return { succeeded: false, error: 'attachment path must not contain ".." segments' }
  }
  if (segments.some((segment) => segment.startsWith('.'))) {
    return { succeeded: false, error: 'attachment path must not contain a hidden (dotfile) segment' }
  }
  return { succeeded: true }
}

function parseAttachmentInput(
  value: unknown,
  index: number,
  validatePath: (path: string) => AttachmentPathCheck,
): { succeeded: true; value: ChatAttachmentInput } | { succeeded: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { succeeded: false, error: `attachments[${index}] must be an object` }
  }
  const record = value as Record<string, unknown>

  const path = record.path
  if (typeof path !== 'string' || !path) {
    return { succeeded: false, error: `attachments[${index}].path must be a non-empty string` }
  }
  const name = record.name
  if (typeof name !== 'string' || !name.trim()) {
    return { succeeded: false, error: `attachments[${index}].name must be a non-empty string` }
  }
  if (name.length > MAX_ATTACHMENT_NAME_LENGTH) {
    return { succeeded: false, error: `attachments[${index}].name must not exceed ${MAX_ATTACHMENT_NAME_LENGTH} characters` }
  }
  if (CONTROL_CHARS.test(name)) {
    return { succeeded: false, error: `attachments[${index}].name must not contain control characters` }
  }
  const size = record.size
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return { succeeded: false, error: `attachments[${index}].size must be a finite number` }
  }
  if (size < 0) {
    return { succeeded: false, error: `attachments[${index}].size must not be negative` }
  }
  const mediaType = record.mediaType
  if (typeof mediaType !== 'string') {
    return { succeeded: false, error: `attachments[${index}].mediaType must be a string` }
  }
  const kind = record.kind
  if (!isAttachmentKind(kind)) {
    return { succeeded: false, error: `attachments[${index}].kind must be "image" or "file"` }
  }

  const pathCheck = validatePath(path)
  if (!pathCheck.succeeded) return { succeeded: false, error: pathCheck.error }

  return { succeeded: true, value: { path, name, size, mediaType, kind } }
}

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
  const maxCount = options.maxCount ?? ATTACHMENT_MAX_COUNT
  const maxTotalBytes = options.maxTotalBytes ?? MAX_ATTACHMENT_TOTAL_BYTES
  const validatePath = options.validatePath ?? defaultValidateAttachmentPath

  if (value === undefined || value === null) return { succeeded: true, value: [] }
  if (!Array.isArray(value)) return { succeeded: false, error: 'attachments must be an array' }
  if (value.length > maxCount) {
    return { succeeded: false, error: `attachments must not exceed ${maxCount} entries` }
  }

  const inputs: ChatAttachmentInput[] = []
  const seenPaths = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseAttachmentInput(value[index], index, validatePath)
    if (!parsed.succeeded) return parsed
    if (seenPaths.has(parsed.value.path)) {
      return { succeeded: false, error: `attachments must not repeat a path: ${parsed.value.path}` }
    }
    seenPaths.add(parsed.value.path)
    inputs.push(parsed.value)
  }

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
