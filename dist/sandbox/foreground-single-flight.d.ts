/**
 * Serialize request-time sandbox provisioning across Worker isolates.
 *
 * Background prewarming can lose a race without delaying a request. A real
 * user turn cannot: its losing request must wait for the owner, adopt the box
 * that became ready, or report why the owner did not leave a usable box.
 */
import type { Harness } from '../harness/index';
import type { PeekWorkspaceSandboxOutcome } from './index';
import { type FencedPrewarmClaimStore } from './prewarm';
export declare const DEFAULT_FOREGROUND_PROVISION_CLAIM_TTL_SECONDS = 180;
export declare const DEFAULT_FOREGROUND_PROVISION_POLL_INTERVAL_MS = 5000;
export type ReadyRunningSandboxOutcome = Extract<PeekWorkspaceSandboxOutcome, {
    status: 'running';
}> & {
    box: Extract<PeekWorkspaceSandboxOutcome, {
        status: 'running';
    }>['box'] & {
        filesystemIncarnationReadiness: 'ready';
    };
};
export declare class SandboxProvisioningFailedElsewhereError extends Error {
    readonly workspaceId: string;
    readonly state: string;
    readonly code = "sandbox.provisioning_failed_elsewhere";
    constructor(workspaceId: string, state: string);
}
export declare class SandboxFilesystemNotReadyError extends Error {
    readonly workspaceId: string;
    readonly readiness: 'transitioning' | 'missing';
    readonly code = "sandbox.filesystem_not_ready";
    readonly retryable = true;
    constructor(workspaceId: string, readiness: 'transitioning' | 'missing');
}
export type ForegroundSandboxSingleFlightEvent = {
    type: 'waiting';
    key: string;
    workspaceId: string;
} | {
    type: 'release-failed';
    key: string;
    workspaceId: string;
    error: string;
};
export interface ForegroundSandboxSingleFlightOptions<T> {
    claim: FencedPrewarmClaimStore;
    workspaceId: string;
    harness: Harness;
    provision(): Promise<T>;
    peek(): Promise<PeekWorkspaceSandboxOutcome>;
    adopt(box: ReadyRunningSandboxOutcome): T | Promise<T>;
    onEvent?(event: ForegroundSandboxSingleFlightEvent): void;
    wait?(ms: number): Promise<void>;
    claimTtlSeconds?: number;
    pollIntervalMs?: number;
}
/**
 * Run one foreground provision or adopt the ready result from its current
 * owner. An expired retained claim permits takeover. A released claim without
 * a usable box reports the prior attempt instead of starting a retry storm.
 */
export declare function runForegroundSandboxSingleFlight<T>(options: ForegroundSandboxSingleFlightOptions<T>): Promise<T>;
