/**
 * Reading arbitrary bytes out of a sandbox over an exec channel that only
 * speaks text.
 *
 * `box.exec` returns stdout as a string, so a binary file has to be encoded to
 * survive the trip: `wc -c` gives the on-disk length, `base64` gives the
 * payload, and the decoded byte count is checked against the stat. That last
 * check is the point of the module — an exec channel that caps or clips its
 * output still reports `exitCode: 0` with a short buffer, which decodes into a
 * perfectly valid but TRUNCATED file. Verifying the length turns that silent
 * corruption into a loud failure at the boundary.
 *
 * Both helpers return typed outcomes; callers must inspect `succeeded` before
 * touching `value`.
 */
/** The `box.exec` surface these helpers use — structural, so a caller can pass
 *  the sandbox SDK's `SandboxInstance` directly or a narrower test double. */
export interface SandboxExecChannel {
    exec(command: string, options?: {
        sessionId?: string;
    }): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
}
/** Define options to execute code within a sandbox environment with optional session control */
export interface SandboxExecOptions {
    /** Run inside a named session rather than the box's default one. */
    sessionId?: string;
}
/** Resolve the outcome of a sandbox file size check with success status and value or error message */
export type SandboxFileSizeOutcome = {
    succeeded: true;
    value: number;
} | {
    succeeded: false;
    error: string;
};
/** Represent the outcome of reading sandbox file bytes with success status and corresponding data or error */
export type SandboxFileBytesOutcome = {
    succeeded: true;
    value: {
        bytes: Uint8Array;
        size: number;
    };
} | {
    succeeded: false;
    error: string;
};
/** Wraps a value in single quotes for `sh`, closing and reopening the quote
 *  around each embedded quote (`'` → `'"'"'`). Every path these helpers
 *  interpolate into a command goes through this — in-box filenames are
 *  arbitrary, so spaces, quotes and `$` are ordinary content, not syntax. */
export declare function shellQuote(value: string): string;
/** Stats a sandbox file's byte length via `wc -c`. A caller enforcing a size
 *  cap must check this BEFORE {@link readSandboxBinaryBytes}, so an oversize
 *  file is rejected without paying for a base64 round trip of it. */
export declare function statSandboxFileSize(box: SandboxExecChannel, absolutePath: string, options?: SandboxExecOptions): Promise<SandboxFileSizeOutcome>;
/** Reads a sandbox file as base64 and decodes it, verifying the decoded byte
 *  length against `expectedSize` (from a prior {@link statSandboxFileSize}). A
 *  mismatch is reported, never returned as a short buffer. */
export declare function readSandboxBinaryBytes(box: SandboxExecChannel, absolutePath: string, expectedSize: number, options?: SandboxExecOptions): Promise<SandboxFileBytesOutcome>;
