/**
 * Exact terminal observation for a native Sandbox execution that another
 * request already admitted. This module never sends a prompt, calls
 * `driveTurn`, or cancels a run.
 */
import type { SandboxInstance } from '@tangle-network/sandbox';
import type { ChatTurnUsage } from './turn-routes';
export interface NativeCompletionReceipt {
    state: 'completed' | 'failed';
    text: string;
    parts: Array<Record<string, unknown>>;
    /** An empty object is an unknown usage receipt, never a measured zero. */
    usage: ChatTurnUsage;
    servedModel?: string;
    servedProvider?: string;
    servedSource?: 'request' | 'environment' | 'profile';
    error?: string;
    completedTurnIds: string[];
}
export interface NativeCompletionAdmission {
    executionId: string;
    state: 'open' | 'closed';
    admittedTurnIds: readonly string[];
    ownerLeaseUntil: Date | number;
    updatedAt?: Date | number;
    closedAt?: Date | number | null;
}
/** Product persistence for the one admission that authorizes this observer. */
export interface NativeCompletionAdmissionStore {
    read(executionId: string): Promise<NativeCompletionAdmission | null>;
    renew(executionId: string, now: Date): Promise<NativeCompletionAdmission | null>;
    closeExpired(executionId: string, now: Date): Promise<NativeCompletionAdmission | null>;
}
/** The official Sandbox reads needed for exact native completion observation. */
export type NativeCompletionSessionSource = Pick<SandboxInstance, 'findCompletedTurn' | 'session'>;
export interface NativeCompletionObservationOptions {
    /** Null when the product cannot currently resolve the admitted Sandbox. */
    source: NativeCompletionSessionSource | null;
    admissionStore: NativeCompletionAdmissionStore;
    executionId: string;
    sessionId: string;
    turnId: string;
    registeredAt: number;
    absentDispatchDeadlineMs?: number;
    receiptDeadlineMs?: number;
    now?: number;
}
export type NativeCompletionObservation = {
    state: 'running';
} | {
    state: 'completed';
    receipt: NativeCompletionReceipt;
} | {
    state: 'failed';
    receipt: NativeCompletionReceipt;
};
/** One exact turn receipt before an admission's ordered aggregate. */
export interface NativeCompletionTurnReceipt {
    turnId: string;
    state: 'completed' | 'failed';
    text: string;
    parts: Array<Record<string, unknown>>;
    usage: ChatTurnUsage;
    servedModel?: string;
    servedProvider?: string;
    servedSource?: 'request' | 'environment' | 'profile';
    error?: string;
}
/** Assemble admitted exact receipts in dispatch order. Missing usage stays unknown. */
export declare function aggregateNativeCompletionReceipts(turns: readonly NativeCompletionTurnReceipt[]): NativeCompletionReceipt;
/**
 * Observe only the turns admitted under `executionId`. Transport failures throw
 * so the durable owner retries. A missing or partial terminal record remains
 * `running` until the configured deadline; it never starts another run.
 */
export declare function observeNativeCompletion(options: NativeCompletionObservationOptions): Promise<NativeCompletionObservation>;
