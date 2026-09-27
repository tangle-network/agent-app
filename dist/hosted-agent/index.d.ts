import type { AgentProfile, LineVoiceOptions } from '@tangle-network/sandbox';
import { type Line } from '@tangle-network/sandbox/core';
/**
 * A hosted agent: people text or call a line, and each person is answered
 * from their own isolated sandbox. The developer's Tangle API key pays for
 * every box, model turn, reply and call.
 *
 * The platform does the work. {@link HostedAgent.attachLine} attaches the
 * line to Tangle Hub with one sandbox per person: Hub routes each text and
 * call to the person's box (the named instance {@link PERSON_KEY_PREFIX} plus
 * a hash of their number), keeps one thread per person, handles STOP and
 * START, counts each person's texts per day, and sends the reply. A call on
 * the line runs in the same box and thread, so text and voice share one memory.
 */
export interface HostedAgentConfig {
    /** The developer's Tangle API key. */
    apiKey: string;
    /**
     * The persona every person's box runs. A profile without `model.default`
     * runs {@link DEFAULT_HOSTED_MODEL}, and a profile without `tools` runs with
     * {@link CONVERSATION_TOOLS_OFF} turned off. Set `tools` to choose your own,
     * for example on a harness that cannot turn those tools off.
     */
    profile: AgentProfile;
    /** Backend harness type, such as `opencode`; the runtime default when omitted. */
    harness?: string;
    /** The owner's address on the chosen transport: E.164 phone or email. */
    owner: string;
    /** Texts Hub answers per person per UTC day. Default 20. */
    freeTurnsPerDay?: number;
    box?: Partial<BoxPolicy>;
    sandboxUrl?: string;
}
export interface BoxPolicy {
    cpuCores: number;
    memoryMB: number;
    diskGB: number;
    idleTimeoutSeconds: number;
    maxLifetimeSeconds: number;
    deleteAfterStoppedSeconds: number;
    /** Egress allow-list. The default reaches the model router only. */
    allowDomains: string[];
}
/**
 * Two cores and a 2 GB disk cost what one core and 10 GB cost: both bill the
 * platform's hourly floor. A person's box starts OpenCode on their first text
 * and after every idle stop, and that start is CPU-bound: on one core it took
 * 6.1 s after a resume and 8.4 s on a new box, on two cores 3.5 s and 3.4 s
 * (production, 2026-09-24). A disk no larger than the platform's warm seed
 * lets a new person's box be claimed from the warm pool: create took 2.1-2.7 s
 * instead of 5.3-7.0 s (2026-09-25).
 */
export declare const DEFAULT_BOX_POLICY: BoxPolicy;
/**
 * Each person's box is the developer's named instance with this prefix. It is
 * the key this kit used before Hub routed its texts, so every existing
 * person keeps their box.
 */
export declare const PERSON_KEY_PREFIX = "hosted:";
/**
 * Harness tools a texting or calling assistant does not use. Their
 * descriptions present every turn as coding work: a shell, file search,
 * sub-agents, to-do lists, skills and web fetch. File read, write and edit
 * stay, so a persona can keep notes such as `memory.md`.
 */
export declare const CONVERSATION_TOOLS_OFF: readonly ['bash', 'glob', 'grep', 'task', 'todowrite', 'webfetch', 'skill'];
/**
 * The model for a profile without `model.default`. It gave the most useful
 * on-topic replies among four Router models on the same five texts and calls
 * (2026-09-23), within the latency of the others.
 */
export declare const DEFAULT_HOSTED_MODEL = "openai/gpt-5.6-luna";
export declare class HostedAgentError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function createHostedAgent(config: HostedAgentConfig): {
    /**
     * Attach a Hub connection the developer owns as this agent's line:
     * an Inkbox iMessage identity (default), its email mailbox, or a Linq
     * WhatsApp number (`phoneNumberId`). The owner's address must match the
     * transport. In `shared` mode (default) the owner and anyone who texts it
     * each get their own box and thread; `personal` admits the owner only.
     * With `voice` (iMessage lines only), calls to the
     * line reach the caller's box and thread through that ph0ny agent; Hub
     * admits only members, so a caller texts once before calling. Safe to
     * repeat with the same config. Hub refuses a changed profile, box or
     * limit on an attached line: detach it first
     * (`DELETE /v1/lines/:id/attachment`). Each person keeps their box and
     * its memory, and their thread starts over. Remove any Hub event
     * subscription on the connection first; Hub refuses a line that another
     * route would also answer.
     */
    attachLine(connectionId: string, options?: {
        transport?: 'imessage' | 'email' | 'whatsapp';
        mode?: 'personal' | 'shared';
        /** Required for WhatsApp because one Linq connection may own several numbers. */
        phoneNumberId?: string;
        voice?: LineVoiceOptions;
    }): Promise<Line>;
};
export type HostedAgent = ReturnType<typeof createHostedAgent>;
