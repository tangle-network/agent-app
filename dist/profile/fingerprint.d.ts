/**
 * Profile fingerprinting — prove WHICH profile a turn actually executed.
 *
 * The backtest invariant this exists to enforce: an eval's score is only worth
 * publishing if the benchmarked profile IS the shipped profile. The failure
 * mode is structural, not hypothetical — a product's eval composed the
 * production profile in one module, executed a hand-rolled stub in another,
 * and stamped the composed profile's identity onto the stub's scorecard.
 * Nothing compared the two, so nothing could notice.
 *
 * A `ProfileFingerprint` is a channelled identity of the profile handed to the
 * sandbox SDK: the system-prompt digest plus the names of every capability
 * surface (MCP servers, subagents, file mounts, hub connections) and the
 * model/harness the turn dispatched at. It is deliberately NOT a byte-exhaustive
 * serialization — channels are what drift in practice, and a channelled diff
 * names the surface that moved instead of reporting "bytes differ".
 *
 * The write half of the seam is `StreamSandboxPromptOptions.onProfileResolved`
 * (`/sandbox`): the one place the final profile exists is inside
 * `streamSandboxPrompt` after the system-prompt override, the MCP merge, and
 * reasoning-effort attachment, so that is where the fingerprint is taken. A
 * caller re-deriving a profile to fingerprint it would reintroduce the exact
 * gap this closes.
 */
import type { AgentProfile } from '@tangle-network/agent-interface';
/** The dispatch context a profile cannot see but a turn's identity includes. */
export interface ProfileFingerprintContext {
    model?: string;
    harness?: string;
}
/** Channelled identity of one executed (or composed) profile. */
export interface ProfileFingerprint {
    /** sha256 over every channel below — one value to log/compare. */
    hash: string;
    /** sha256 of `prompt.systemPrompt` ('' when absent). */
    promptSha: string;
    /** UTF-8 byte length of `prompt.systemPrompt`. */
    promptBytes: number;
    /** Sorted MCP server keys. */
    mcpKeys: string[];
    /** Sorted subagent names. */
    subagentNames: string[];
    /** Sorted `resources.files[].path` mounts. */
    fileMountPaths: string[];
    /** Sorted hub connection ids (alias-qualified when present). */
    connectionIds: string[];
    model?: string;
    harness?: string;
}
/** Fingerprint a profile as the SDK would receive it. */
export declare function fingerprintAgentProfile(profile: AgentProfile, context?: ProfileFingerprintContext): Promise<ProfileFingerprint>;
/** One drifted channel between two fingerprints, rendered as comparable strings. */
export interface ProfileDriftEntry {
    channel: 'promptSha' | 'promptBytes' | 'mcpKeys' | 'subagentNames' | 'fileMountPaths' | 'connectionIds' | 'model' | 'harness';
    a: string;
    b: string;
}
export interface ProfileDrift {
    equal: boolean;
    drift: ProfileDriftEntry[];
}
/** Channel-by-channel comparison of two fingerprints. */
export declare function diffProfileFingerprints(a: ProfileFingerprint, b: ProfileFingerprint): ProfileDrift;
/** Human-readable drift report; exactly 'profiles identical' when equal. */
export declare function formatProfileDrift(drift: ProfileDrift): string;
