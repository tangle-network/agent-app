/**
 * The sandbox-archive source every app needs, so no product hand-rolls box
 * lifecycle around `fs.openArchive`.
 *
 * `openArchive` refuses a box that is not running. A stopped box is resumed for
 * the export and stopped again once its archive has been read, so exporting
 * neither fails on an idle workspace nor leaves the owner paying for a box they
 * had stopped. A box that no longer exists exports nothing.
 */

import type { ExportArchiveSource, ExportDataClass } from './types'

/** The slice of the Sandbox SDK's `SandboxInstance` this source uses. */
export interface ArchivableBox {
  readonly status: string
  resume(): Promise<void>
  stop?(): Promise<void>
  waitFor(status: 'running', options?: { timeoutMs?: number }): Promise<void>
  fs: { openArchive(dir: string, options?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>> }
}

const GONE = new Set(['deleted', 'expired', 'failed'])

/**
 * One sandbox's filesystem as `sandbox/<name>.tar.gz`. `getBox` returns the
 * SDK instance (`client.get(id)`), or `null` when the box is gone.
 */
export function sandboxArchive(args: {
  name: string
  getBox(): Promise<ArchivableBox | null>
  /** Directory to archive, relative to the box workspace. Default `.`. */
  dir?: string
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
    async open() {
      const box = await args.getBox()
      if (!box || GONE.has(box.status)) return null
      const wasStopped = box.status === 'stopped'
      if (wasStopped) await box.resume()
      if (box.status !== 'running' || wasStopped) await box.waitFor('running', { timeoutMs: args.resumeTimeoutMs ?? 120_000 })
      const archive = await box.fs.openArchive(args.dir ?? '.')
      if (!wasStopped || !box.stop) return archive
      // Put the box back the way the owner left it once the archive is read.
      const restore = () => box.stop!().catch(() => {})
      return archive.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          flush: () => restore(),
        }),
      )
    },
  }
}
