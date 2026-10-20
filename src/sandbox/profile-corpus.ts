import type { AgentProfileFileMount } from '@tangle-network/agent-interface'
import { createHash } from 'node:crypto'
import type { SandboxRuntimeConfig, SandboxBuildContext } from './configuration'
import { Sandbox } from '@tangle-network/sandbox/core'
import type { SandboxInstance } from '@tangle-network/sandbox'
import type { SandboxExistingBoxStage } from './lifecycle-errors'
import type { Harness } from '../harness/index'
import { type Outcome, ok } from './outcome'
import { splitDeferredProfileFiles } from './profile-files'
import { checksFor, isRecent, TRUSTED_REUSE_TTL_MS, recordCheck } from './runtime-cache'
import { writeDeferredFilesWithRuntimeAuthRefresh } from './runtime-connection'

export function deferredProfileWriteFailed(stage: 'new' | 'reused' | 'resumed', name: string, cause: Error): Error {
  return new Error(`deferred file write failed on ${stage} box ${name}: ${cause.message}`, { cause })
}

// Resolve the shell's deferred (inline) profile files and write them into a
// box that already exists (reuse/resume paths). No-op unless the shell opts
// into deferProfileFiles. Idempotent overwrite — a redeploy with new skills
// refreshes the corpus on the next ensure call.
// Box-metadata key holding the content hash of the deferred corpus that was
// written to the box at CREATE. On reuse, an unchanged hash means the skills are
// already on disk, so the (large, file-API) re-write can be skipped.
export const DEFERRED_CORPUS_HASH_KEY = 'agentAppDeferredCorpusHash'

/** Stable content hash of the deferred file corpus (path + inline content).
 *  Unchanged corpus ⇒ same hash; a new/edited/removed skill ⇒ different hash.
 *  Exported for the reuse-skip test. */
export function deferredCorpusHash(files: AgentProfileFileMount[]): string {
  const norm = files
    .map((f) => ({
      p: f.path,
      c: f.resource.kind === 'inline' ? ((f.resource as { content?: string }).content ?? '') : `ref:${f.resource.kind}`,
    }))
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(norm), 'utf8').digest('hex')
}

export async function materializeDeferredFilesForExistingBox(
  shell: SandboxRuntimeConfig,
  client: Sandbox,
  box: SandboxInstance,
  stage: SandboxExistingBoxStage,
  name: string,
  workspaceId: string,
  userId: string | undefined,
  harness: Harness,
  corpusMarker?: Promise<string | null>,
): Promise<Outcome<SandboxInstance>> {
  if (!shell.deferProfileFiles) return ok(box)
  const connectedIntegrationIds = await shell.connectedIntegrationIds(workspaceId)
  const buildCtx: SandboxBuildContext = {
    workspaceId,
    connectedIntegrationIds,
    ...(userId ? { userId } : {}),
  }
  const files = await shell.files(buildCtx)
  const fullProfile = shell.profile({ extraFiles: files, harness })
  const { deferredFiles } = splitDeferredProfileFiles(fullProfile)
  if (deferredFiles.length === 0) return ok(box)
  // Skip the whole re-write when the corpus is UNCHANGED since the box was
  // created with it. The skill corpus is large and the bulk goes through the
  // file API (writeMany) UNCONDITIONALLY, so re-writing it on every reuse adds
  // seconds of latency to each turn. The create payload stamps the corpus hash
  // into box metadata; a matching hash means the skills are already on disk.
  // Fail-safe: a missing or mismatched hash (e.g. a redeploy with new skills, or
  // a box created before this optimization) WRITES — a stale skip is never
  // risked. Reads metadata only, so no extra exec/round-trip.
  const corpusHash = deferredCorpusHash(deferredFiles)
  const stampedHash = (box.metadata as Record<string, unknown> | undefined)?.[DEFERRED_CORPUS_HASH_KEY]
  if (typeof stampedHash === 'string' && stampedHash === corpusHash) return ok(box)
  // The create-time stamp goes stale on the first release that changes the
  // corpus, and without this the box rewrote the whole corpus on every reuse
  // after it (a ~0.7 s file batch per GTM turn, 2026-10-11). The marker is
  // written only after a corpus write succeeds and lives on the same disk as
  // the files, so a lost disk loses both and the corpus is written again.
  // What this isolate last found on the box stands in for reading the marker
  // again for as long as it trusts a probe of the same box identity.
  const found = checksFor(box)?.corpus
  if (isRecent(found?.at, TRUSTED_REUSE_TTL_MS) && found?.hash === corpusHash) return ok(box)
  if ((await (corpusMarker ?? readDeferredCorpusMarker(box))) === corpusHash) {
    recordCheck(box, { corpus: { hash: corpusHash, at: Date.now() } })
    return ok(box)
  }
  const written = await writeDeferredFilesWithRuntimeAuthRefresh(client, box, deferredFiles, stage, name)
  if (written.succeeded) {
    await writeDeferredCorpusMarker(written.value, corpusHash)
    recordCheck(written.value, { corpus: { hash: corpusHash, at: Date.now() } })
  }
  return written
}

/** Where a reused box records the deferred corpus it last received in full,
 *  relative to /home/agent like every file-API profile write. */
const DEFERRED_CORPUS_MARKER_PATH = '.agent-app/deferred-corpus-hash'

const DEFERRED_CORPUS_HASH_RE = /^[0-9a-f]{64}$/

/** The corpus hash a box last recorded, or null when it is absent or unreadable. */
export async function readDeferredCorpusMarker(box: SandboxInstance): Promise<string | null> {
  if (typeof box.read !== 'function') return null
  try {
    const value = (await box.read(`/home/agent/${DEFERRED_CORPUS_MARKER_PATH}`)).trim()
    return DEFERRED_CORPUS_HASH_RE.test(value) ? value : null
  } catch {
    return null
  }
}

/** Best effort: a failed marker write only costs the next reuse a corpus rewrite. */
async function writeDeferredCorpusMarker(box: SandboxInstance, corpusHash: string): Promise<void> {
  if (typeof box.fs?.writeMany !== 'function') return
  try {
    await box.fs.writeMany([{ path: DEFERRED_CORPUS_MARKER_PATH, content: corpusHash }])
  } catch {
    // The corpus itself is on disk; the next reuse writes it and the marker again.
  }
}
