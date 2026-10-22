import { assertSafeKeySegment, type ObjectBody, type ObjectStore } from '../object-store'
import type { ReadAttachmentFn, WriteAttachmentFn } from './attachment-store'
import { defaultValidateAttachmentPath } from './attachment-validation'

/** A product supplies its private object store after its request bindings are ready. */
export interface StoredChatAttachmentsOptions {
  store: ObjectStore | (() => ObjectStore)
}

/** Scoped stored bytes behind the existing chat attachment reader and writer ports.
 * Authorization remains in the product's routes; these functions validate storage keys.
 * The writer preserves the stable non-atomic port and does not promise batch rollback.
 */
export interface StoredChatAttachments {
  readAttachment: ReadAttachmentFn
  writeAttachment: WriteAttachmentFn
  getAttachmentObject(scopeId: string, path: string): Promise<ObjectBody | null>
  attachmentObjectKey(scopeId: string, path: string): string
}

function decodeAttachmentBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

/** Bind durable object storage without capturing an uninitialized request binding. */
export function createStoredChatAttachments(options: StoredChatAttachmentsOptions): StoredChatAttachments {
  const store = (): ObjectStore => typeof options.store === 'function' ? options.store() : options.store
  const attachmentObjectKey = (scopeId: string, path: string): string => {
    const scope = assertSafeKeySegment(scopeId)
    const checked = defaultValidateAttachmentPath(path)
    if (!checked.succeeded) throw new Error(checked.error)
    return `${scope}/${path}`
  }
  const getAttachmentObject = async (scopeId: string, path: string): Promise<ObjectBody | null> =>
    store().get(attachmentObjectKey(scopeId, path))

  const writeAttachment: WriteAttachmentFn = async (scopeId, path, content, opts) => {
    try {
      const bytes = typeof content === 'string' ? decodeAttachmentBase64(content) : content
      if (opts.size !== undefined && opts.size !== bytes.byteLength) {
        return { ok: false, reason: `Attachment size mismatch for ${path}: expected ${opts.size}, received ${bytes.byteLength}` }
      }
      await store().put(attachmentObjectKey(scopeId, path), bytes, {
        ...(opts.mediaType ? { contentType: opts.mediaType } : {}),
        contentLength: bytes.byteLength,
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `Attachment write failed for ${path}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const readAttachment: ReadAttachmentFn = async (scopeId, path) => {
    try {
      const object = await getAttachmentObject(scopeId, path)
      if (!object) return { ok: false, reason: `Attachment not found: ${path}` }
      const bytes = new Uint8Array(await new Response(object.stream()).arrayBuffer())
      if (bytes.byteLength !== object.size) {
        return { ok: false, reason: `Attachment size mismatch for ${path}: metadata ${object.size}, body ${bytes.byteLength}` }
      }
      return {
        ok: true,
        size: bytes.byteLength,
        bytes,
        ...(object.contentType ? { mediaType: object.contentType } : {}),
      }
    } catch (error) {
      return { ok: false, reason: `Attachment read failed for ${path}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return { readAttachment, writeAttachment, getAttachmentObject, attachmentObjectKey }
}
