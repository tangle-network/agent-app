/**
 * `buildDispatchParts` — assemble the `PromptInputPart[]` a turn carrying
 * attachments and/or `@`-mentions dispatches to the sandbox. `parts[0]` is
 * always the full prompt text (typed text plus the attachment + mention pointer
 * blocks); each attachment or mention becomes one media part. An attachment
 * (read from the product store via the injected reader) draws the inline byte
 * budget first; a mention (read from the LIVE box) takes what is left. A file
 * inlines as a `data:` URI when it fits the remaining budget, otherwise demotes
 * to an in-box path part so the whole request stays under the proxy cap. Every
 * media part is deduped by its resolved absolute path. This module only
 * produces the parts array; the caller decides when a turn dispatches parts
 * instead of a plain string.
 *
 * Storage-parameterized port of gtm-agent's `dispatch-parts.ts`: the vault
 * default reader is dropped (`readAttachment` is REQUIRED — the product supplies
 * its store adapter), the `GTM_SANDBOX_VAULT_DIR` prefixing becomes the required
 * `resolveAttachmentPath` seam, the `GTM_MULTIMODAL_FORCE_PATH` env fallback
 * becomes an explicit `forcePath` flag, and every budget cap reads an overridable
 * `./wire` constant. Kept behavior-identical for gtm-agent#618 adoption (the
 * demotion math and emitted part shapes reproduce its dispatched prompt bytes).
 */

import { flattenHistory, type PromptInputPart } from '../sandbox'
import {
  statSandboxFileSize,
  readSandboxBinaryBytes,
  type SandboxExecChannel,
} from '../sandbox/binary-read'
import {
  mediaTypeForMentionPath,
  base64WireLen,
  DISPATCH_REQUEST_MAX_BYTES,
  DISPATCH_STRUCTURAL_RESERVE_BYTES,
  DISPATCH_MAX_PARTS,
} from './wire'
import type { ChatAttachmentPart, ChatMentionPart } from '../chat-store/parts'
import { bytesToBase64 } from './upload'
import type { ReadAttachmentFn } from './attachment-store'

export type { PromptInputPart }

/** Resolve the outcome of dispatching parts with success status and corresponding value or error message */
export type DispatchPartsOutcome =
  | { succeeded: true; value: PromptInputPart[] }
  | { succeeded: false; error: string }

/** One mention file's size (always) and inline bytes (only when the caller
 *  asked for them — a path-only mention never reads its bytes). */
type SandboxMentionReadOutcome =
  | { succeeded: true; value: { size: number; base64?: string } }
  | { succeeded: false; error: string }

/** Resolve sandbox mention details by reading from a specified path with optional byte reading */
export type ReadSandboxMentionFn = (
  box: SandboxExecChannel,
  absolutePath: string,
  options: { readBytes: boolean },
) => Promise<SandboxMentionReadOutcome>

function byteLen(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Default mention reader: stats the in-box file (which also proves it still
 * exists — a since-deleted mention fails loud here), then reads its bytes only
 * when the caller wants to inline it. Both hops cross the sandbox exec channel
 * via the substrate's binary-read helpers.
 */
async function readSandboxMention(
  box: SandboxExecChannel,
  absolutePath: string,
  options: { readBytes: boolean },
): Promise<SandboxMentionReadOutcome> {
  const stat = await statSandboxFileSize(box, absolutePath)
  if (!stat.succeeded) {
    return { succeeded: false, error: `mentioned sandbox file missing or unreadable: ${absolutePath} — ${stat.error}` }
  }
  if (!options.readBytes) return { succeeded: true, value: { size: stat.value } }

  const read = await readSandboxBinaryBytes(box, absolutePath, stat.value)
  if (!read.succeeded) {
    return { succeeded: false, error: `mentioned sandbox file read failed: ${absolutePath} — ${read.error}` }
  }
  return { succeeded: true, value: { size: stat.value, base64: bytesToBase64(read.value.bytes) } }
}

/** HARD INVARIANT: a media part (`image`/`file`) must carry exactly one of a
 *  non-empty `data:` URL or a non-empty absolute path — never both, never
 *  neither. The OpenCode adapter falls back to `part.url || part.path || ""`,
 *  so a part violating this silently degrades to an empty target instead of
 *  failing loud. */
function violatesUrlPathXor(part: PromptInputPart): boolean {
  if (part.type === 'text') return false
  const hasUrl = typeof part.url === 'string' && part.url.startsWith('data:')
  const hasPath = typeof part.path === 'string' && part.path.startsWith('/')
  return hasUrl === hasPath
}

/** Build input parameters for dispatching chat message parts including text, attachments, mentions, and history */
export interface BuildDispatchPartsInput {
  text: string
  attachments: ChatAttachmentPart[]
  mentions?: ChatMentionPart[]
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  systemPrompt: string
  /** Serialized size of the backend profile the SDK inlines into the same
   *  prompt request body — a large, non-negotiable rider that must come out of
   *  the inline budget or near-cap attachments 413 at the proxy instead of
   *  demoting to path parts. */
  profileWireBytes: number
  /** The product's workspace/tenant key, passed to `readAttachment`. */
  scopeId: string
  /** Maps an attachment's store-relative path to the in-box absolute path a
   *  path-based part references (same seam style as `fileMentionsToParts`'s
   *  `resolvePath`). */
  resolveAttachmentPath: (path: string) => string
  /** Maps a mention's workspace-relative path to its in-box absolute path.
   *  Default: {@link BuildDispatchPartsInput.resolveAttachmentPath} — in gtm the
   *  vault mount roots both; a product that mounts them apart overrides this. */
  resolveMentionPath?: (path: string) => string
  /** The turn's already-ensured box — required when `mentions` is non-empty
   *  (mention bytes are read from the live box, not the store). */
  box?: SandboxExecChannel
  /** Force every media part to a path reference, skipping all inlining. */
  forcePath?: boolean
  /** REQUIRED store reader for attachment content — no default (the product
   *  owns its store; see {@link ReadAttachmentFn}). */
  readAttachment: ReadAttachmentFn
  readSandboxMention?: ReadSandboxMentionFn
  /** Whole-request proxy cap. Default {@link DISPATCH_REQUEST_MAX_BYTES}. */
  requestMaxBytes?: number
  /** JSON-envelope reserve off the top of the request cap. Default
   *  {@link DISPATCH_STRUCTURAL_RESERVE_BYTES}. */
  structuralReserveBytes?: number
  /** Sidecar per-request parts-array cap. Default {@link DISPATCH_MAX_PARTS}. */
  maxParts?: number
}

/** Content of one attachment read, normalized to the base64 a `data:` URI
 *  needs — `base64` reused verbatim, else `bytes` encoded once. */
function readResultToBase64(read: { base64?: string; bytes?: Uint8Array }): string | undefined {
  if (typeof read.base64 === 'string') return read.base64
  if (read.bytes) return bytesToBase64(read.bytes)
  return undefined
}

/** Build dispatch parts from input by resolving mentions, paths, and applying size constraints asynchronously */
export async function buildDispatchParts(input: BuildDispatchPartsInput): Promise<DispatchPartsOutcome> {
  const readMention = input.readSandboxMention ?? readSandboxMention
  const resolveMentionPath = input.resolveMentionPath ?? input.resolveAttachmentPath
  const forcePath = input.forcePath ?? false
  const mentions = input.mentions ?? []
  const requestMaxBytes = input.requestMaxBytes ?? DISPATCH_REQUEST_MAX_BYTES
  const structuralReserveBytes = input.structuralReserveBytes ?? DISPATCH_STRUCTURAL_RESERVE_BYTES
  const maxParts = input.maxParts ?? DISPATCH_MAX_PARTS

  const parts: PromptInputPart[] = [{ type: 'text', text: input.text }]
  // Absolute in-box paths already emitted — a file both attached and mentioned
  // (or mentioned twice) rides as a single media part.
  const emittedAbsPaths = new Set<string>()

  const flattenedForSizing = flattenHistory(input.text, input.history)
  // May go negative when history/systemPrompt alone are large — every
  // attachment then fails the `runningInline + cost <= inlineBudget` check
  // below and demotes to a path part, which is correct behavior (path parts
  // don't draw on this budget), not a failure.
  const inlineBudget =
    requestMaxBytes
    - base64WireLen(byteLen(flattenedForSizing))
    - byteLen(JSON.stringify(input.systemPrompt))
    - input.profileWireBytes
    - structuralReserveBytes

  let runningInline = 0

  // Stable input order: attachments dispatch in the order the user attached
  // them, and the pointer block in `input.text` already names them in that
  // same order.
  for (const attachment of input.attachments) {
    if (!attachment.path) {
      return { succeeded: false, error: `attachment path must be non-empty: ${attachment.name}` }
    }

    // The reader crosses an external boundary (store/coordinator) — a rejection
    // there must land in the typed outcome, not escape as a thrown error the
    // caller would misattribute to stream init.
    let read: Awaited<ReturnType<ReadAttachmentFn>>
    try {
      read = await input.readAttachment(input.scopeId, attachment.path)
    } catch (err) {
      return {
        succeeded: false,
        error: `attachment store read failed: ${attachment.path} — ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (!read.ok) return { succeeded: false, error: read.reason }

    const base64 = readResultToBase64(read)
    if (base64 === undefined) {
      return { succeeded: false, error: `attachment store read produced no content: ${attachment.path}` }
    }

    const mediaType = attachment.mediaType ?? read.mediaType
    if (attachment.type === 'image' && !mediaType) {
      return { succeeded: false, error: `attachment is missing a mediaType required for an image data URI: ${attachment.path}` }
    }

    const absPath = input.resolveAttachmentPath(attachment.path)
    emittedAbsPaths.add(absPath)

    if (attachment.type === 'image') {
      const inlinePart: PromptInputPart = {
        type: 'image',
        filename: attachment.name,
        mediaType,
        url: `data:${mediaType};base64,${base64}`,
      }
      const cost = byteLen(JSON.stringify(inlinePart))
      if (!forcePath && runningInline + cost <= inlineBudget) {
        parts.push(inlinePart)
        runningInline += cost
      } else {
        parts.push({ type: 'image', filename: attachment.name, mediaType, path: absPath })
      }
      continue
    }

    // File part. Sidecar's file-part zod union is tried [Legacy: {path
    // required, content?} strips mediaType/filename] then [AISDK: {filename
    // required, url required, mediaType?}] — so an inline file part must carry
    // `filename` + `url` and no `path` key at all, while a path-based file part
    // must carry only `path` (mediaType/filename would be stripped by the
    // Legacy branch anyway).
    const fileMediaType = mediaType ?? 'application/octet-stream'
    const inlinePart: PromptInputPart = {
      type: 'file',
      filename: attachment.name,
      mediaType: fileMediaType,
      url: `data:${fileMediaType};base64,${base64}`,
    }
    const cost = byteLen(JSON.stringify(inlinePart))
    if (!forcePath && runningInline + cost <= inlineBudget) {
      parts.push(inlinePart)
      runningInline += cost
    } else {
      parts.push({ type: 'file', path: absPath })
    }
  }

  if (mentions.length > 0 && !input.box) {
    return { succeeded: false, error: 'internal error: sandbox mentions require a box to read from' }
  }
  for (const mention of mentions) {
    if (!mention.path) {
      return { succeeded: false, error: `mention path must be non-empty: ${mention.name}` }
    }
    const absPath = resolveMentionPath(mention.path)
    if (emittedAbsPaths.has(absPath)) continue
    emittedAbsPaths.add(absPath)

    const isImage = mention.mentionKind === 'image'
    const mediaType = isImage ? mediaTypeForMentionPath(mention.path) : undefined

    // Every mention is stat'd first: it proves the file still exists (a deleted
    // mention fails the turn loud) and gives the size for the inline budget
    // decision without pulling bytes across the exec channel.
    let stat: SandboxMentionReadOutcome
    try {
      stat = await readMention(input.box!, absPath, { readBytes: false })
    } catch (err) {
      return { succeeded: false, error: `mention read failed: ${absPath} — ${err instanceof Error ? err.message : String(err)}` }
    }
    if (!stat.succeeded) return { succeeded: false, error: stat.error }

    // Only an image that projects within the remaining budget reads its bytes
    // to inline; every other mention (and a budget-exceeding image) ships
    // path-only, so a large file is never base64'd just to be demoted.
    const projectedInlineCost = base64WireLen(stat.value.size)
      + byteLen(JSON.stringify({ type: 'image', filename: mention.name, mediaType: mediaType ?? '', url: '' }))
    if (isImage && mediaType && !forcePath && runningInline + projectedInlineCost <= inlineBudget) {
      let read: SandboxMentionReadOutcome
      try {
        read = await readMention(input.box!, absPath, { readBytes: true })
      } catch (err) {
        return { succeeded: false, error: `mention read failed: ${absPath} — ${err instanceof Error ? err.message : String(err)}` }
      }
      if (!read.succeeded) return { succeeded: false, error: read.error }
      if (!read.value.base64) return { succeeded: false, error: `mentioned image produced no bytes: ${absPath}` }
      const inlinePart: PromptInputPart = {
        type: 'image',
        filename: mention.name,
        mediaType,
        url: `data:${mediaType};base64,${read.value.base64}`,
      }
      const cost = byteLen(JSON.stringify(inlinePart))
      // Re-check against the actual serialized cost — the projection can
      // undershoot; a real overshoot demotes to a path part rather than 413ing.
      if (runningInline + cost <= inlineBudget) {
        parts.push(inlinePart)
        runningInline += cost
        continue
      }
    }

    // Path-only mention: an image keeps its `mediaType`, everything else is a
    // bare `file` path (the sidecar's Legacy file-part branch strips extra keys).
    parts.push(
      isImage && mediaType
        ? { type: 'image', filename: mention.name, mediaType, path: absPath }
        : { type: 'file', path: absPath },
    )
  }

  for (const part of parts) {
    if (violatesUrlPathXor(part)) {
      return { succeeded: false, error: 'internal error: emitted media part violates the url/path exclusivity invariant' }
    }
  }

  // Final whole-request check sized against what actually crosses the wire: the
  // history-merged text part (the substrate folds `history` into `parts[0]`
  // before dispatch), the media parts, the system prompt, and the inlined
  // backend profile riding the same body — the same terms `inlineBudget` was
  // derived from.
  const textPartSize = base64WireLen(byteLen(flattenedForSizing))
  const mediaPartsSize = parts.slice(1).reduce((total, part) => total + byteLen(JSON.stringify(part)), 0)
  const systemPromptSize = byteLen(JSON.stringify(input.systemPrompt))
  if (textPartSize + mediaPartsSize + systemPromptSize + input.profileWireBytes + structuralReserveBytes > requestMaxBytes) {
    return { succeeded: false, error: 'dispatch parts exceed the sandbox proxy request cap even after path demotion' }
  }

  // The sidecar rejects the whole request past its parts-array cap; the caller
  // selects which media ride natively, so overflow here is a caller bug
  // surfaced loudly rather than a truncation.
  if (parts.length > maxParts) {
    return { succeeded: false, error: `dispatch parts exceed the sidecar per-request cap of ${maxParts}` }
  }

  return { succeeded: true, value: parts }
}
