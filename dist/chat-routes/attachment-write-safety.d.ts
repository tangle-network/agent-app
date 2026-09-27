import type { AtomicAttachmentWriteResult, AttachmentWriteOwnership, AttachmentWriteResult } from './attachment-store';
/** Read an injected writer result without allowing hostile getters to escape. */
export declare function inspectLegacyAttachmentWriteResult(value: unknown): AttachmentWriteResult | undefined;
/**
 * Read an ownership-aware writer result with strict runtime checks.
 *
 * The public types protect TypeScript callers only. The product adapter is an
 * injection boundary, so a proxy, malformed value, or truthy non-boolean must
 * fail closed before the route invokes cleanup or publishes a path.
 */
export declare function inspectAtomicAttachmentWriteResult(value: unknown, ownership: AttachmentWriteOwnership): AtomicAttachmentWriteResult | undefined;
