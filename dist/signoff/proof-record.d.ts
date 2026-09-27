import { z } from 'zod';
/** Bumped when the canonical body shape changes; a verifier refuses versions it does not know. */
export declare const SIGNOFF_PROOF_VERSION = 1;
declare const signoffProofStepSchema: z.ZodObject<{
    id: z.ZodString;
    command: z.ZodString;
    cwd: z.ZodString;
    status: z.ZodEnum<{
        blocked: "blocked";
        cancelled: "cancelled";
        failed: "failed";
        passed: "passed";
        skipped: "skipped";
    }>;
    exitCode: z.ZodNumber;
    durationMs: z.ZodNumber;
    startedAt: z.ZodString;
    outputSha256: z.ZodString;
}, z.core.$strip>;
declare const signoffProofPeerSchema: z.ZodObject<{
    name: z.ZodString;
    version: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
declare const signoffProofSubjectSchema: z.ZodObject<{
    repo: z.ZodString;
    commit: z.ZodString;
    tree: z.ZodString;
    commitTree: z.ZodString;
    parents: z.ZodArray<z.ZodString>;
    committedAt: z.ZodString;
}, z.core.$strip>;
declare const signoffProofBodySchema: z.ZodObject<{
    proofVersion: z.ZodNumber;
    subject: z.ZodObject<{
        repo: z.ZodString;
        commit: z.ZodString;
        tree: z.ZodString;
        commitTree: z.ZodString;
        parents: z.ZodArray<z.ZodString>;
        committedAt: z.ZodString;
    }, z.core.$strip>;
    signedAt: z.ZodString;
    host: z.ZodObject<{
        hostname: z.ZodString;
        platform: z.ZodString;
        arch: z.ZodString;
        user: z.ZodString;
    }, z.core.$strip>;
    tooling: z.ZodObject<{
        node: z.ZodString;
        pnpm: z.ZodNullable<z.ZodString>;
        peers: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    wallClockMs: z.ZodNumber;
    seeds: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    declaredRequired: z.ZodArray<z.ZodString>;
    steps: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        command: z.ZodString;
        cwd: z.ZodString;
        status: z.ZodEnum<{
            blocked: "blocked";
            cancelled: "cancelled";
            failed: "failed";
            passed: "passed";
            skipped: "skipped";
        }>;
        exitCode: z.ZodNumber;
        durationMs: z.ZodNumber;
        startedAt: z.ZodString;
        outputSha256: z.ZodString;
    }, z.core.$strip>>;
    verdict: z.ZodEnum<{
        fail: "fail";
        pass: "pass";
    }>;
}, z.core.$strip>;
declare const signoffProofSealSchema: z.ZodObject<{
    algorithm: z.ZodEnum<{
        "hmac-sha256": "hmac-sha256";
        sha256: "sha256";
    }>;
    bodySha256: z.ZodString;
    keyId: z.ZodNullable<z.ZodString>;
    mac: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
declare const signoffProofSchema: z.ZodObject<{
    body: z.ZodObject<{
        proofVersion: z.ZodNumber;
        subject: z.ZodObject<{
            repo: z.ZodString;
            commit: z.ZodString;
            tree: z.ZodString;
            commitTree: z.ZodString;
            parents: z.ZodArray<z.ZodString>;
            committedAt: z.ZodString;
        }, z.core.$strip>;
        signedAt: z.ZodString;
        host: z.ZodObject<{
            hostname: z.ZodString;
            platform: z.ZodString;
            arch: z.ZodString;
            user: z.ZodString;
        }, z.core.$strip>;
        tooling: z.ZodObject<{
            node: z.ZodString;
            pnpm: z.ZodNullable<z.ZodString>;
            peers: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        wallClockMs: z.ZodNumber;
        seeds: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        declaredRequired: z.ZodArray<z.ZodString>;
        steps: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            command: z.ZodString;
            cwd: z.ZodString;
            status: z.ZodEnum<{
                blocked: "blocked";
                cancelled: "cancelled";
                failed: "failed";
                passed: "passed";
                skipped: "skipped";
            }>;
            exitCode: z.ZodNumber;
            durationMs: z.ZodNumber;
            startedAt: z.ZodString;
            outputSha256: z.ZodString;
        }, z.core.$strip>>;
        verdict: z.ZodEnum<{
            fail: "fail";
            pass: "pass";
        }>;
    }, z.core.$strip>;
    seal: z.ZodObject<{
        algorithm: z.ZodEnum<{
            "hmac-sha256": "hmac-sha256";
            sha256: "sha256";
        }>;
        bodySha256: z.ZodString;
        keyId: z.ZodNullable<z.ZodString>;
        mac: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type SignoffProofStep = z.infer<typeof signoffProofStepSchema>;
export type SignoffProofPeer = z.infer<typeof signoffProofPeerSchema>;
export type SignoffProofSubject = z.infer<typeof signoffProofSubjectSchema>;
export type SignoffProofBody = z.infer<typeof signoffProofBodySchema>;
export type SignoffProofSeal = z.infer<typeof signoffProofSealSchema>;
export type SignoffProof = z.infer<typeof signoffProofSchema>;
type CanonicalValue = string | number | boolean | null | readonly CanonicalValue[] | {
    readonly [key: string]: CanonicalValue;
};
/**
 * Deterministic JSON: object keys sorted, array order preserved, no whitespace.
 *
 * The seal is a hash over this string, so two readers must produce byte-identical
 * bytes from the same record. `undefined` throws rather than vanishing — a field
 * that silently disappears is a field the hash stops covering.
 */
export declare function canonicalJson(value: CanonicalValue): string;
export declare function canonicalizeProofBody(body: SignoffProofBody): string;
export declare function hashProofBody(body: SignoffProofBody): string;
/** The digest a runner records for a step's combined output. Shared so both halves agree. */
export declare function hashStepOutput(output: string): string;
export declare function signoffKeyId(key: Uint8Array): string;
/** Read the local sign-off key. Throws when absent — an unreadable key is never a silent downgrade to unsealed. */
export declare function readSignoffKey(path: string): Uint8Array;
export declare function sealProof(body: SignoffProofBody, key?: Uint8Array): SignoffProof;
/** Constant-time comparison of two hex digests of equal length. */
export declare function macMatches(expected: string, actual: string): boolean;
export interface BuildSignoffProofInput {
    readonly repoDir: string;
    /** Repo identity the verifier's required-step table is keyed on. */
    readonly repo: string;
    /** Revision the sign-off is for; defaults to `HEAD`. */
    readonly rev?: string;
    readonly steps: readonly SignoffProofStep[];
    /** Measured elapsed time for the run. Required — it is not derivable from the steps. */
    readonly wallClockMs: number;
    /** Step ids this run treated as required. Checked against the verifier's table. */
    readonly declaredRequired: readonly string[];
    readonly seeds: Readonly<Record<string, string | number>>;
    readonly peerNames?: readonly string[];
    readonly key?: Uint8Array;
    readonly now?: Date;
}
export declare function buildSignoffProof(input: BuildSignoffProofInput): SignoffProof;
/** Parse an untrusted proof document, failing loud on any shape the verifier cannot reason about. */
export declare function parseSignoffProof(json: string): SignoffProof;
export declare function serializeSignoffProof(proof: SignoffProof): string;
/**
 * The single line an operator pastes into a PR or a merge commit: how many steps
 * ran, how long it took, the seeds, and the verdict.
 */
export declare function formatSignoffSummary(proof: SignoffProof): string;
export {};
