/**
 * The sandbox sources every app needs, so no product hand-rolls box lifecycle
 * around `fs.openArchive` and `fs.read`.
 *
 * Both refuse a box that is not running. A stopped box is resumed for the
 * export and stopped again once it has been read, so exporting neither fails on
 * an idle workspace nor leaves the owner paying for a box they had stopped. A
 * box that no longer exists exports nothing. A box busy with another lifecycle
 * operation (a page-open warm, the previous export's stop) is retried on a
 * later request instead of failing the export.
 */

import { ExportRetryLater } from './engine'
import type { ExportArchiveSource, ExportDataClass, ExportFile, ExportFilesSource } from './types'

/** The slice of the Sandbox SDK's `SandboxInstance` these sources use. */
export interface ArchivableBox {
  readonly status: string
  resume(): Promise<void>
  stop?(): Promise<void>
  waitFor(status: 'running', options?: { timeoutMs?: number }): Promise<void>
  fs: {
    openArchive(dir: string, options?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>
    read?(path: string): Promise<string>
  }
}

const GONE = new Set(['deleted', 'expired', 'failed'])

/**
 * Never customer data: installed packages and the platform's runtime state. In
 * a Hospitality box they were 98% of the archive (110 MB of node_modules and
 * 12.5 MB of .sidecar beside 0.4 MB of workspace files).
 */
export const DEFAULT_SANDBOX_EXCLUDE: readonly string[] = ['node_modules', '.sidecar']

/**
 * A resume the platform failed on its side (HTTP 5xx). The box stays suspended
 * and a later resume usually works: on 2026-10-12 one Hospitality export failed
 * on "Project sidecar could not be reprovisioned for resume" and the next export,
 * six minutes later, resumed the same box.
 */
function isServerFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 500
}

/** The platform's typed refusal while another resume, stop or delete holds the box. */
function isLifecycleBusy(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown } | null
  return typeof e === 'object' && e !== null && e.status === 409 && e.code === 'SANDBOX_LIFECYCLE_IN_PROGRESS'
}

/** The box, running, plus a callback that puts it back the way the owner left it. `null` when it is gone. */
async function openRunning(
  getBox: () => Promise<ArchivableBox | null>,
  timeoutMs: number,
): Promise<{ box: ArchivableBox; restore: () => Promise<void> } | null> {
  const box = await getBox()
  if (!box || GONE.has(box.status)) return null
  const wasStopped = box.status === 'stopped'
  try {
    if (wasStopped) await box.resume()
    if (box.status !== 'running' || wasStopped) await box.waitFor('running', { timeoutMs })
  } catch (err) {
    if (isLifecycleBusy(err)) throw new ExportRetryLater('the sandbox is busy with another operation; retrying shortly')
    if (isServerFailure(err)) throw new ExportRetryLater('the sandbox could not be started; retrying shortly')
    throw err
  }
  const restore = async () => {
    if (wasStopped && box.stop) await box.stop().catch(() => {})
  }
  return { box, restore }
}

/**
 * One sandbox's filesystem as `sandbox/<name>.tar.gz`. `getBox` returns the
 * SDK instance (`client.get(id)`), or `null` when the box is gone.
 */
export function sandboxArchive(args: {
  name: string
  getBox(): Promise<ArchivableBox | null>
  /** Directory to archive, relative to the box workspace. Default `.`. */
  dir?: string
  /** Directory names left out wherever they appear. Default `DEFAULT_SANDBOX_EXCLUDE`. */
  exclude?: readonly string[]
  dataClass?: ExportDataClass
  description?: string
  /** How long to wait for a resumed box. Default 120 s. */
  resumeTimeoutMs?: number
}): ExportArchiveSource {
  return {
    kind: 'archive',
    name: args.name,
    dataClass: args.dataClass ?? 'sandbox',
    description: args.description,
    exclude: args.exclude ?? DEFAULT_SANDBOX_EXCLUDE,
    async open() {
      const opened = await openRunning(args.getBox, args.resumeTimeoutMs ?? 120_000)
      if (!opened) return null
      const archive = await opened.box.fs.openArchive(args.dir ?? '.')
      return archive.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: () => opened.restore() }))
    },
  }
}

/**
 * Named text files read from one sandbox, written under `files/<name>/<path>`.
 * Use it where the product stores documents in a box under internal names (a
 * content-addressed vault), so the owner gets each one under its real name.
 * `list` reads the product's own records; the box is resumed only when it
 * returns files.
 */
export function sandboxFiles(args: {
  name: string
  getBox(): Promise<ArchivableBox | null>
  list(): Promise<{ path: string; boxPath: string }[]>
  dataClass?: ExportDataClass
  description?: string
  resumeTimeoutMs?: number
}): ExportFilesSource {
  return {
    kind: 'files',
    name: args.name,
    dataClass: args.dataClass ?? 'knowledge',
    description: args.description,
    async *files(): AsyncIterable<ExportFile> {
      const listed = await args.list()
      if (!listed.length) return
      const opened = await openRunning(args.getBox, args.resumeTimeoutMs ?? 120_000)
      if (!opened) return
      const read = opened.box.fs.read
      if (!read) throw new Error('workspace-export: this sandbox client cannot read files')
      try {
        for (const file of listed) {
          // Read here, not in `open`: the engine opens a chunk after the listing
          // ends, by which time `finally` has stopped the box again.
          const text = await read.call(opened.box.fs, file.boxPath)
          yield { path: file.path, open: async () => text }
        }
      } finally {
        await opened.restore()
      }
    },
  }
}
