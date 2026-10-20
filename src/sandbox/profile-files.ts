import type { AgentProfile, AgentProfileFileMount } from '@tangle-network/agent-interface'
import type { SandboxInstance } from '@tangle-network/sandbox'
import type { ExecResult } from '@tangle-network/sandbox/core'
import { ProfileWriteExecTimeoutError, transientExecError } from './exec-failure'
import { type Outcome, fail, ok } from './outcome'
import { createHash } from 'node:crypto'
import { shellPath, shellSingleQuote } from './shell-path'

// Split a profile's `resources.files` into the inline mounts that can be
// written into a running box and the rest (non-inline refs that the
// orchestrator must resolve, so they stay in the create payload). Returns the
// inline set to defer and a profile copy with those inline files removed.
/** Split profile files into inline deferred files and a lean profile without them */
export function splitDeferredProfileFiles(
  profile: AgentProfile,
): { leanProfile: AgentProfile; deferredFiles: AgentProfileFileMount[] } {
  const files = profile.resources?.files ?? []
  const deferredFiles: AgentProfileFileMount[] = []
  const keptFiles: AgentProfileFileMount[] = []
  for (const mount of files) {
    if (mount.resource.kind === 'inline') deferredFiles.push(mount)
    else keptFiles.push(mount)
  }
  if (deferredFiles.length === 0) return { leanProfile: profile, deferredFiles }
  const leanProfile: AgentProfile = {
    ...profile,
    resources: { ...(profile.resources ?? {}), files: keptFiles },
  }
  return { leanProfile, deferredFiles }
}

// The runtime exec proxy (`box.exec` → /terminals/commands) hangs (30s
// timeout) on any request whose body crosses ~4096 bytes, and one oversized
// exec wedges the channel so every later exec on the box hangs too. We slice
// each file's base64 into appends whose full command string stays well under
// that cap. 3000 chars of base64 leaves ~1000 bytes of headroom for the
// surrounding `printf '%s' '<slice>' >> <path>.b64` command plus the proxy's
// JSON request envelope — comfortably below 4096.
const PROFILE_WRITE_B64_CHUNK_CHARS = 3000

// gtm's corpus is ~135 small execs; on a cold box the runtime exec proxy
// hard-throttles (HTTP 429 after ~21 execs in ~34s) and, under sustained load,
// SILENTLY HANGS instead of returning 429 — one parked exec wedges the channel
// and `writeProfileFilesToBox` never returns, so `ensureWorkspaceSandbox`
// parks the worker (~140s, no exception). These failures plus sidecar exec-plane
// readiness/transport failures (5xx, reset, fetch/network errors) are transient:
// retry the SAME exec with exponential backoff before failing loud. A non-zero
// exit is a real command failure, never retried.
const PROFILE_WRITE_MAX_RETRIES = 4

const PROFILE_WRITE_RETRY_BASE_MS = 250

const PROFILE_WRITE_RETRY_MAX_MS = 2000

// Client-side hard ceiling per exec. The proxy's own 30s timeout is unreliable
// once the channel wedges (it can hang past it), so we race each exec against an
// independent timer we control: a wedged exec is abandoned here and retried as a
// transient transport error, never silently parked. We also pass timeoutMs to
// the SDK as defense-in-depth, but the race is the guarantee.
const PROFILE_WRITE_EXEC_TIMEOUT_MS = 30_000

// Pacing between execs to stay under the proxy throttle that triggers the hang.
// The drill saw throttling at ~0.6 exec/s bursts; ~150ms between ~135 execs
// adds well under a minute total and keeps the burst rate below the trip point.
// On by default for the deferred path; overridable for tests/tuning.
const PROFILE_WRITE_PACE_MS = 150

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// A mount whose path sits in a bin directory is made executable. Shared so the
// file-API eligibility check and the exec branch agree on "executable by dir".
const PROFILE_BIN_DIR_RE = /(^|\/)(s?bin)\//

// Run a box.exec, abandoning it if it does not settle within timeoutMs. The
// returned promise rejects with ProfileWriteExecTimeoutError on timeout so the
// retry loop treats a hang exactly like a transient transport error. We also
// forward timeoutMs to the SDK so the underlying request is cancelled when the
// SDK honors it; the race covers the case where it does not.
function execWithTimeout(
  box: SandboxInstance,
  cmd: string,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new ProfileWriteExecTimeoutError(timeoutMs))
    }, timeoutMs)
    box.exec(cmd, { timeoutMs }).then(
      (res) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(res)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

// Materialize inline profile files into a running box via `box.exec`. Uses a
// base64 pipe so arbitrary content (scripts, unicode, special chars) lands
// byte-exact, and writes to ANY absolute path (e.g. /usr/local/bin) or a
// `~`-relative path — the exec runs as the sidecar, which is not bound by the
// safe-prefix allow-list the /files/write API enforces. Sets the executable
// bit when the mount declares it OR the target is a bin directory.
//
// Each file is written in several small execs (mkdir, one append per base64
// chunk, then a decode+cleanup) so no single exec request body trips the
// ~4 KiB proxy cap. Writes are sequential; a single bad mount stops the batch
// and the first failure is returned (fail-loud), the rest are not attempted.
//
// Each exec is bounded by a client-side hard timeout and retried with backoff
// on transient rate-limit/readiness/transport failures, so one wedged or early
// exec-plane request can never park the caller (and thus never park provisioning).
// A small pace between execs keeps the burst rate below the proxy throttle that
// triggers the hang.
/** Define options to control execution timeout, pacing, and retry behavior when writing profile files */
export interface WriteProfileFilesOptions {
  // Hard ceiling per exec (ms). A hung/wedged exec is abandoned and retried.
  execTimeoutMs?: number
  // Delay between execs (ms) to stay under the proxy throttle. 0 disables it.
  paceMs?: number
  // Max retries for a transient exec before failing loud.
  maxRetries?: number
}

// The workspace-relative target for a deferred inline mount when it can be
// materialized through the sidecar file API (`box.fs.writeMany` — FILES rate
// group, 300/min, whole-file, auto-mkdir) instead of the chunked terminal-exec
// path (50/min); null when it must stay on exec. The file API resolves relative
// paths from the workspace root, so eligibility is: inline and a path that
// resolves under the workspace root with no `..`/`.sidecar` segment. `~/…` and
// `/home/agent/…` are home-relative; agent sandboxes set $HOME to the workspace
// root, so both map to the same relative target. Other absolute (`/…`) and bare
// `~`/`~user` mounts stay on exec.
function fileApiTarget(mount: AgentProfileFileMount): string | null {
  if (mount.resource.kind !== 'inline') return null
  let rel: string
  if (mount.path.startsWith('~/')) rel = mount.path.slice(2)
  else if (mount.path.startsWith('/home/agent/')) rel = mount.path.slice('/home/agent/'.length)
  else if (mount.path.startsWith('/') || mount.path.startsWith('~')) return null
  else rel = mount.path
  if (rel.length === 0 || rel.startsWith('/') || rel.split('/').some((seg) => seg === '..' || seg === '.sidecar')) {
    return null
  }
  return rel
}

function isExecutableProfileFile(mount: AgentProfileFileMount): boolean {
  return mount.executable ?? PROFILE_BIN_DIR_RE.test(mount.path)
}

function profileFileMode(mount: AgentProfileFileMount): number | undefined {
  return isExecutableProfileFile(mount) ? 0o755 : undefined
}

// The sandbox gateway rejects request bodies over 1 MiB, and `writeMany` sends
// each file as one JSON string, so a file larger than one request can never
// land through it — the SDK splits batches but not files. Such a file goes
// through the chunked `fs.uploadData` when the SDK has it and the chunked exec
// path otherwise: the rule the SDK's `materializeProfileFileMounts` applies.
const PROFILE_FILE_API_MAX_JSON_BYTES = 1024 * 1024 - 16 * 1024

function fitsProfileFileApi(content: string): boolean {
  const encoder = new TextEncoder()
  // JSON escaping grows one byte to at most six (`\u001f`).
  if (encoder.encode(content).byteLength * 6 <= PROFILE_FILE_API_MAX_JSON_BYTES) return true
  return encoder.encode(JSON.stringify(content)).byteLength <= PROFILE_FILE_API_MAX_JSON_BYTES
}

type ProfileFileUpload = (remotePath: string, data: string, options?: { mode?: number }) => Promise<unknown>

function fileApiSupportsMode(box: SandboxInstance): boolean {
  const fs = box.fs as (SandboxInstance['fs'] & { supportsWriteMode?: boolean }) | undefined
  return fs?.supportsWriteMode === true
}

/** Write profile files to a sandbox with pacing, retries, and optional execution timeout handling */
export async function writeProfileFilesToBox(
  box: SandboxInstance,
  files: AgentProfileFileMount[],
  options: WriteProfileFilesOptions = {},
): Promise<Outcome<void>> {
  const execTimeoutMs = options.execTimeoutMs ?? PROFILE_WRITE_EXEC_TIMEOUT_MS
  const paceMs = options.paceMs ?? PROFILE_WRITE_PACE_MS
  const maxRetries = options.maxRetries ?? PROFILE_WRITE_MAX_RETRIES
  // The bulk of a profile corpus (skills, `~/.claude/skills/…`, config) is
  // inline and workspace-relative — write it in ONE paced,
  // retry-aware batch via the SDK's file API (`box.fs.writeMany`, FILES rate
  // group 300/min). The SDK owns the pacing + transient-retry this module used
  // to hand-roll. Absolute / bare-`~` paths can't use the file API
  // (prefix-restricted), so they stay on the chunked exec path.
  // Capability-guarded: SDKs without `writeMany` route everything through
  // exec; SDKs before @tangle-network/sandbox 0.9.4 keep executable files on
  // exec because they do not expose `supportsWriteMode` or forward file modes.
  const fileApiAvailable = typeof box.fs?.writeMany === 'function'
  const modeAwareFileApi = fileApiSupportsMode(box)
  const uploadData = (box.fs as { uploadData?: ProfileFileUpload } | undefined)?.uploadData
  const viaFileApi: { path: string; content: string; mode?: number }[] = []
  const viaUpload: { path: string; content: string; mode?: number }[] = []
  const viaExec: AgentProfileFileMount[] = []
  for (const mount of files) {
    if (mount.resource.kind !== 'inline') continue
    const fileApiPath = fileApiAvailable ? fileApiTarget(mount) : null
    const executable = isExecutableProfileFile(mount)
    if (fileApiPath !== null && (!executable || modeAwareFileApi)) {
      const mode = profileFileMode(mount)
      const content = mount.resource.content ?? ''
      const write = { path: fileApiPath, content, ...(mode !== undefined ? { mode } : {}) }
      if (fitsProfileFileApi(content)) viaFileApi.push(write)
      else if (typeof uploadData === 'function') viaUpload.push(write)
      else viaExec.push(mount)
    }
    else viaExec.push(mount)
  }
  if (viaFileApi.length > 0) {
    // `writeMany` is fail-loud on the first file it can't write. Preserve the
    // cause so the runtime-auth-refresh wrapper still detects a 401 — it
    // recurses `.cause` for an AuthError/401 shape (see isRuntimeExecAuthError).
    try {
      await box.fs.writeMany(viaFileApi, { paceMs, maxRetries })
    } catch (err) {
      return fail(new Error('writeProfileFilesToBox: file-API batch write failed', { cause: err }))
    }
  }
  for (const upload of viaUpload) {
    // The SDK paces, retries, and checksums each chunked upload session.
    try {
      await uploadData!.call(box.fs, upload.path, upload.content, upload.mode !== undefined ? { mode: upload.mode } : undefined)
    } catch (err) {
      return fail(new Error(`writeProfileFilesToBox: chunked upload failed for ${upload.path}`, { cause: err }))
    }
  }

  // Pace BETWEEN execs, not before the first or after the last. Shared across
  // the exec mounts so the (now smaller) executable/edge-case set stays paced.
  let execStarted = false

  // Pace + transient-retry ONE exec attempt: backoff/pace/fail-loud in one place.
  // `run` must be idempotent under unknown-outcome retries (exec writes
  // deterministic parts). A transient error retries with backoff up to
  // maxRetries (honoring a server Retry-After); anything else, or exhausting
  // retries, fails loud with the cause.
  const paceAndRetry = async <T>(run: () => Promise<T>, path: string): Promise<Outcome<T>> => {
    for (let attempt = 0; ; attempt++) {
      if (execStarted && paceMs > 0) await sleep(paceMs)
      execStarted = true
      try {
        return ok(await run())
      } catch (err) {
        const { retryable, retryAfterMs } = transientExecError(err)
        if (retryable && attempt < maxRetries) {
          const backoff = Math.min(PROFILE_WRITE_RETRY_BASE_MS * 2 ** attempt, PROFILE_WRITE_RETRY_MAX_MS)
          await sleep(retryAfterMs ?? backoff)
          continue
        }
        return fail(new Error(`writeProfileFilesToBox: exec failed for ${path}`, { cause: err }))
      }
    }
  }

  for (const mount of viaExec) {
    if (mount.resource.kind !== 'inline') continue // always true (viaExec is inline) — narrows for TS
    const content = mount.resource.content ?? ''
    const path = mount.path

    const b64 = Buffer.from(content, 'utf8').toString('base64')
    const b64Chunks: string[] = []
    for (let i = 0; i < b64.length; i += PROFILE_WRITE_B64_CHUNK_CHARS) {
      b64Chunks.push(b64.slice(i, i + PROFILE_WRITE_B64_CHUNK_CHARS))
    }
    const expectedSha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    const dir = path.replace(/\/[^/]*$/, '')
    const executable = isExecutableProfileFile(mount)
    const q = shellPath(path)
    const qb64 = shellPath(`${path}.b64`)
    const qtmp = shellPath(`${path}.tmp`)
    const qpartPrefix = shellPath(`${path}.b64.part.`)

    // Run one exec step. Transport errors (incl. a wedged-proxy timeout) are
    // paced + retried by paceAndRetry; a non-zero exit is a REAL command failure
    // — surfaced immediately, never retried.
    const step = async (cmd: string): Promise<Outcome<void>> => {
      const res = await paceAndRetry(() => execWithTimeout(box, cmd, execTimeoutMs), path)
      if (!res.succeeded) return res
      const exec = res.value
      if (exec.exitCode !== 0) {
        return fail(
          new Error(
            `writeProfileFilesToBox: failed to write ${path} (exit ${exec.exitCode}): ${exec.stderr.slice(0, 500)}`,
          ),
        )
      }
      return ok(undefined)
    }

    // Ensure the target directory exists. Chunk/final commands below are
    // idempotent under unknown-outcome transport retries; this no-op/mkdir is too.
    const mkdir = dir && dir !== path ? `mkdir -p ${shellPath(dir)}` : ':'
    let res = await step(mkdir)
    if (!res.succeeded) return res

    // Write each deterministic part with overwrite, not append. If the server
    // writes a part but the HTTP response is lost, retrying the same step lands
    // the same bytes instead of duplicating them.
    for (let i = 0; i < b64Chunks.length; i++) {
      const slice = b64Chunks[i]!
      res = await step(`printf '%s' '${slice}' > ${shellPath(`${path}.b64.part.${i}`)}`)
      if (!res.succeeded) return res
    }

    // Materialize from deterministic parts into a temp file, verify its content
    // hash, then atomically move into place. If the final exec succeeds but its
    // response is lost, a retry first accepts an already-correct target and only
    // re-runs idempotent chmod/cleanup. Parts are cleaned only after the target
    // hash is known-good, so a retried final step can always reconstruct.
    const chmod = executable ? `chmod +x ${q} || exit 1; ` : ''
    const checksumMismatch = shellSingleQuote(`writeProfileFilesToBox: checksum mismatch for ${path}`)
    const finalCmd =
      `expected='${expectedSha256}'; ` +
      `if [ -f ${q} ] && [ "$(sha256sum ${q} | awk '{print $1}')" = "$expected" ]; then ` +
      `${chmod}rm -f ${qb64} ${qtmp}; i=0; while [ "$i" -lt ${b64Chunks.length} ]; do rm -f ${qpartPrefix}$i; i=$((i+1)); done; exit 0; fi; ` +
      `: > ${qb64} && ` +
      `i=0; while [ "$i" -lt ${b64Chunks.length} ]; do cat ${qpartPrefix}$i >> ${qb64} || exit 1; i=$((i+1)); done && ` +
      `base64 -d < ${qb64} > ${qtmp} && ` +
      `[ "$(sha256sum ${qtmp} | awk '{print $1}')" = "$expected" ] || { echo ${checksumMismatch} >&2; exit 1; }; ` +
      `mv ${qtmp} ${q} && ` +
      `${executable ? `chmod +x ${q} && ` : ''}` +
      `[ "$(sha256sum ${q} | awk '{print $1}')" = "$expected" ] || { echo ${checksumMismatch} >&2; exit 1; }; ` +
      `rm -f ${qb64} ${qtmp}; i=0; while [ "$i" -lt ${b64Chunks.length} ]; do rm -f ${qpartPrefix}$i; i=$((i+1)); done`
    res = await step(finalCmd)
    if (!res.succeeded) return res
  }
  return ok(undefined)
}
