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
  exec(
    command: string,
    options?: { sessionId?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

export interface SandboxExecOptions {
  /** Run inside a named session rather than the box's default one. */
  sessionId?: string
}

export type SandboxFileSizeOutcome =
  | { succeeded: true; value: number }
  | { succeeded: false; error: string }

export type SandboxFileBytesOutcome =
  | { succeeded: true; value: { bytes: Uint8Array; size: number } }
  | { succeeded: false; error: string }

/** Wraps a value in single quotes for `sh`, closing and reopening the quote
 *  around each embedded quote (`'` → `'"'"'`). Every path these helpers
 *  interpolate into a command goes through this — in-box filenames are
 *  arbitrary, so spaces, quotes and `$` are ordinary content, not syntax. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** Decodes with `atob` rather than `Buffer.from(s, 'base64')`: Buffer SKIPS
 *  characters outside the alphabet, so a corrupted payload would decode to
 *  something plausible instead of throwing. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function execInSandbox(box: SandboxExecChannel, command: string, options?: SandboxExecOptions) {
  return options?.sessionId ? box.exec(command, { sessionId: options.sessionId }) : box.exec(command)
}

/** Stats a sandbox file's byte length via `wc -c`. A caller enforcing a size
 *  cap must check this BEFORE {@link readSandboxBinaryBytes}, so an oversize
 *  file is rejected without paying for a base64 round trip of it. */
export async function statSandboxFileSize(
  box: SandboxExecChannel,
  absolutePath: string,
  options?: SandboxExecOptions,
): Promise<SandboxFileSizeOutcome> {
  const quotedPath = shellQuote(absolutePath)
  let result
  try {
    result = await execInSandbox(box, `wc -c < ${quotedPath}`, options)
  } catch (err) {
    return { succeeded: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (result.exitCode !== 0) {
    return { succeeded: false, error: result.stderr || 'unknown error' }
  }
  const size = Number.parseInt(result.stdout.trim(), 10)
  if (!Number.isFinite(size)) {
    return { succeeded: false, error: `could not parse file size from "${result.stdout.trim()}"` }
  }
  return { succeeded: true, value: size }
}

/** Reads a sandbox file as base64 and decodes it, verifying the decoded byte
 *  length against `expectedSize` (from a prior {@link statSandboxFileSize}). A
 *  mismatch is reported, never returned as a short buffer. */
export async function readSandboxBinaryBytes(
  box: SandboxExecChannel,
  absolutePath: string,
  expectedSize: number,
  options?: SandboxExecOptions,
): Promise<SandboxFileBytesOutcome> {
  const quotedPath = shellQuote(absolutePath)
  let result
  try {
    result = await execInSandbox(box, `base64 ${quotedPath}`, options)
  } catch (err) {
    return { succeeded: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (result.exitCode !== 0) {
    return { succeeded: false, error: result.stderr || 'unknown error' }
  }
  // GNU coreutils wraps base64 output at 76 columns; BusyBox may not wrap at
  // all. Stripping all whitespace makes both shapes decode identically.
  const cleaned = result.stdout.replace(/\s+/g, '')
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(cleaned)
  } catch (err) {
    return {
      succeeded: false,
      error: `could not decode file contents: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (bytes.byteLength !== expectedSize) {
    return {
      succeeded: false,
      error: `read returned ${bytes.byteLength} bytes, expected ${expectedSize} — output truncated in transit`,
    }
  }
  return { succeeded: true, value: { bytes, size: expectedSize } }
}
