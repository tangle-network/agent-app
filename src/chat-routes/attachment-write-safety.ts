import type {
  AtomicAttachmentWriteResult,
  AttachmentWriteOwnership,
  AttachmentWriteReceipt,
  AttachmentWriteResult,
} from './attachment-store'

type ObjectLike = Record<PropertyKey, unknown>

function objectLike(value: unknown): value is ObjectLike {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** Read an injected writer result without allowing hostile getters to escape. */
export function inspectLegacyAttachmentWriteResult(
  value: unknown,
): AttachmentWriteResult | undefined {
  try {
    if (!objectLike(value)) return undefined
    const ok = value.ok
    if (ok === true) return { ok: true }
    if (ok === false && typeof value.reason === 'string') {
      return { ok: false, reason: value.reason }
    }
  } catch {
    // A malformed or hostile adapter result is a storage failure.
  }
  return undefined
}

/**
 * Read an ownership-aware writer result with strict runtime checks.
 *
 * The public types protect TypeScript callers only. The product adapter is an
 * injection boundary, so a proxy, malformed value, or truthy non-boolean must
 * fail closed before the route invokes cleanup or publishes a path.
 */
export function inspectAtomicAttachmentWriteResult(
  value: unknown,
  ownership: AttachmentWriteOwnership,
): AtomicAttachmentWriteResult | undefined {
  try {
    if (!objectLike(value)) return undefined
    const receiptValue = value.receipt
    if (!objectLike(receiptValue)) return undefined
    const receiptOwnership = receiptValue.ownership
    if (!objectLike(receiptOwnership)) return undefined
    if (
      receiptOwnership.id !== ownership.id ||
      receiptOwnership.path !== ownership.path ||
      typeof receiptOwnership.id !== 'string' ||
      typeof receiptOwnership.path !== 'string' ||
      typeof receiptValue.rollback !== 'function'
    ) {
      return undefined
    }
    if (value.ok === true) {
      return { ok: true, receipt: receiptValue as unknown as AttachmentWriteReceipt }
    }
    if (value.ok === false && typeof value.reason === 'string') {
      return {
        ok: false,
        reason: value.reason,
        receipt: receiptValue as unknown as AttachmentWriteReceipt,
      }
    }
  } catch {
    // A malformed or hostile adapter result is a storage failure.
  }
  return undefined
}
