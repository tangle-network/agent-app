export interface SafeSandboxErrorCause {
    name?: string;
    message?: string;
    code?: string | number;
    status?: string | number;
    phase?: string;
    endpoint?: string;
    origin?: string;
    retryAfterMs?: number;
    sidecarVersion?: string;
    containerImage?: string;
}
export interface SafeSandboxErrorDiagnostics {
    message: string;
    causes: SafeSandboxErrorCause[];
    truncated: boolean;
    truncatedAtDepth?: number;
    cycle: boolean;
}
export declare function serializeSandboxProvisioningError(error: unknown, options?: {
    maxDepth?: number;
}): SafeSandboxErrorDiagnostics;
export declare function formatSandboxProvisioningSupportDetails(diagnostics: SafeSandboxErrorDiagnostics): string;
export declare function isSandboxAuthFailure(diagnostics: SafeSandboxErrorDiagnostics): boolean;
export declare function isSandboxApiBearerAuthFailure(diagnostics: SafeSandboxErrorDiagnostics): boolean;
/** Machine-readable code emitted when resume lost the physical box. */
export declare const SANDBOX_BACKING_CONTAINER_MISSING_CODE: 'BACKING_CONTAINER_MISSING';
/**
 * Legacy fallback for Sandbox API releases that only returned the nested host
 * 404 text. New callers must use `SANDBOX_BACKING_CONTAINER_MISSING_CODE`.
 */
export declare function isLegacySandboxBackingContainerMissingMessage(message: string): boolean;
/**
 * True when the sandbox API cannot find a sandbox resource or its backing
 * container. The latter arrives as a 500 from resume with a nested host 404.
 *
 * A sandbox id is a cache of where a workspace's box lives, not the workspace's
 * identity: the platform reaps, suspends, and loses boxes as ordinary lifecycle
 * events. Callers use this to discard the dead id and provision a replacement,
 * so the match is deliberately narrow — a 404 from the runtime sidecar
 * (`/runtime/...`, a missing file or session inside a live box) is NOT this.
 */
export declare function isSandboxApiSandboxMissingFailure(diagnostics: SafeSandboxErrorDiagnostics): boolean;
/**
 * True when a resume failed because the host the box is pinned to cannot seat
 * it — the host's slot budget is exhausted, not the box's fault and not
 * something waiting fixes.
 *
 * A box lives on one host. When that host fills, every future resume for every
 * box on it fails identically and permanently, so a workspace whose box landed
 * on a full host is bricked until it is placed somewhere else. Callers use this
 * the same way they use {@link isSandboxApiSandboxMissingFailure}: discard the
 * dead id and provision a replacement, which the orchestrator is free to place
 * on a host with room. The workspace itself is preserved — it lives in the
 * Vault, not in the box's filesystem.
 *
 * Matched on the message because the sandbox API returns a generic
 * `SERVER_ERROR` for it; a dedicated code upstream would replace this.
 */
export declare function isSandboxHostCapacityFailure(diagnostics: SafeSandboxErrorDiagnostics): boolean;
/**
 * True when a resume failed on the box's own configuration rather than on
 * anything a retry can change.
 *
 * These are permanent facts about one box. Its egress policy can be missing,
 * or its verified Platform lineage can differ from the current caller. Neither
 * creation-time fact can change on resume, so the box must be replaced.
 *
 * Narrow on purpose. A bare 500 from the sandbox API is transient far more
 * often than not, and treating one as unbringable would delete a healthy box.
 * Matched on the specific unrecoverable phrasing, and only from `sandbox-api`.
 */
export declare function isSandboxBoxConfigFailure(diagnostics: SafeSandboxErrorDiagnostics): boolean;
export declare function formatSandboxProvisioningUserMessage(diagnostics: SafeSandboxErrorDiagnostics): string;
