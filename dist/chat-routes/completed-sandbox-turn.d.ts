/**
 * Recover a detached Sandbox turn from its durable completed records.
 *
 * A fast detached run can finish before the live event subscriber receives
 * every message-part event. The Sandbox still retains two exact records: a
 * turn-id keyed result cache and the completed assistant message on the
 * session. This adapter joins them without guessing across turns, then returns
 * the same `DetachedTurnFinal` shape `runDetachedTurn` already consumes.
 */
import type { SandboxInstance, SessionMessage } from '@tangle-network/sandbox';
import type { DetachedTurnFinal } from './detached-turn';
/** The official Sandbox methods needed for completed-turn recovery. */
export type CompletedSandboxTurnSource = Pick<SandboxInstance, 'findCompletedTurn' | 'session'>;
/** Options for resolving one exact detached turn. */
export interface ReadCompletedSandboxTurnOptions {
    turnId: string;
    sessionId: string;
    log?: (message: string, meta?: Record<string, unknown>) => void;
}
/**
 * Recover the durable content a Sandbox recorder attached to one assistant
 * message. The caller is responsible for proving that the message belongs to
 * the exact terminal turn; this projection deliberately makes no conclusion
 * about whether that terminal state was completed or interrupted.
 */
export declare function recoverSandboxAssistantMessage(message: SessionMessage): DetachedTurnFinal;
/**
 * Read the exact completed turn from its keyed cache and completed message.
 * Never borrow a session-wide aggregate from a concurrently advancing session.
 * Observation failure is retryable and distinct from successful absent reads.
 */
export declare function readCompletedSandboxTurn(box: CompletedSandboxTurnSource, options: ReadCompletedSandboxTurnOptions): Promise<DetachedTurnFinal | null>;
