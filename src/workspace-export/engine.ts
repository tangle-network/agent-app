/**
 * Builds a workspace export one source at a time and serves it as a zip.
 *
 * Each source becomes a unit. A unit streams its data through the credential
 * masks, records CRC-32, SHA-256 and sizes, and stores the bytes as bounded
 * segments. The job record (`job.json`) tracks which units are done, so an
 * export resumes after a closed tab or a dropped request instead of starting
 * over. When every unit is done, the manifest is written, and the download
 * route stitches the stored segments into one zip with an exact length.
 */

import { assertSafeKeySegment } from '../object-store'
import { crc32Update, createSha256 } from './checksum'
import { createSecretScanner, isSecretName, REDACTED, type SecretScanner } from './secrets'
import type { ExportStorage } from './storage'
import { createTarInspector } from './tar'
import type {
  ExportJob,
  ExportPlan,
  ExportProgress,
  ExportRow,
  ExportSource,
  ExportUnit,
  StoredEntry,
} from './types'
import { createZipStream, type ZipEntrySpec } from './zip'

export const MANIFEST_SCHEMA = 'tangle.workspace-export/v1'
const SEGMENT_BYTES = 8 * 1024 * 1024
const LEASE_MS = 5 * 60_000
const MAX_ATTEMPTS = 3
/** Files written per request. Each read and segment write is a subrequest, and
 *  Workers cap subrequests per request, so a large files source spans requests. */
const FILES_PER_REQUEST = 200
const SOURCE_NAME = /^[a-z0-9][a-z0-9_.-]{0,95}$/

export interface ExportEngineOptions {
  /** Product name for the manifest and the download filename, e.g. `hospitality`. */
  app: string
  storage: ExportStorage
  plan(args: { workspaceId: string }): ExportPlan | Promise<ExportPlan>
  /** Exact credential values held by the product that must never appear. */
  knownSecrets?(args: { workspaceId: string }): readonly string[] | Promise<readonly string[]>
  /** Storage key prefix. Default `workspace-exports`. */
  prefix?: string
  now?: () => number
}

class LeaseLost extends Error {}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function errorText(scanner: SecretScanner, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return scanner.maskText(raw).text.slice(0, 300)
}

function toStream(body: ReadableStream<Uint8Array> | Uint8Array | string): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return new ReadableStream({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes)
      controller.close()
    },
  })
}

function concatenate(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Make a file path safe and unique inside the archive. */
function safePath(path: string, used: Set<string>): string {
  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
    .map((p) => p.replace(/[\0-\x1f]/g, '_'))
  let candidate = parts.join('/') || 'file'
  let n = 1
  while (used.has(candidate)) {
    n += 1
    candidate = `${parts.join('/') || 'file'}~${n}`
  }
  used.add(candidate)
  return candidate
}

function jsonCell(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof ArrayBuffer) value = new Uint8Array(value)
  if (value instanceof Uint8Array) {
    let bin = ''
    for (const b of value) bin += String.fromCharCode(b)
    return { $base64: btoa(bin) }
  }
  return value
}

export function createExportEngine(options: ExportEngineOptions) {
  const { storage } = options
  const prefix = options.prefix ?? 'workspace-exports'
  const now = options.now ?? (() => Date.now())

  const base = (workspaceId: string, id: string) =>
    `${prefix}/${assertSafeKeySegment(workspaceId)}/${assertSafeKeySegment(id)}`
  const jobKey = (workspaceId: string, id: string) => `${base(workspaceId, id)}/job.json`
  /** The key a download signature covers. No object lives there; the zip is assembled per request. */
  const archiveKey = (workspaceId: string, id: string) => `${base(workspaceId, id)}/archive.zip`

  async function loadJob(workspaceId: string, id: string): Promise<{ job: ExportJob; etag: string } | null> {
    if (!/^[a-z0-9-]{8,64}$/.test(id)) return null
    const object = await storage.get(jobKey(workspaceId, id))
    if (!object) return null
    const job = JSON.parse(await new Response(object.body).text()) as ExportJob
    if (job.workspaceId !== workspaceId) return null
    return { job, etag: object.etag }
  }

  async function saveJob(job: ExportJob, etag?: string): Promise<string> {
    job.updatedAt = iso(now())
    const result = await storage.put(jobKey(job.workspaceId, job.id), new TextEncoder().encode(JSON.stringify(job)), {
      ifMatch: etag,
    })
    if (!result) throw new LeaseLost('export job changed underneath this request')
    return result.etag
  }

  async function writeEntry(
    keyBase: string,
    path: string,
    input: ReadableStream<Uint8Array>,
    compress: boolean,
  ): Promise<StoredEntry> {
    let crc = 0
    let size = 0
    const sha = createSha256()
    let stream = input.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
          crc = crc32Update(crc, chunk)
          size += chunk.length
          await sha.update(chunk)
          controller.enqueue(chunk)
        },
      }),
    )
    if (compress) stream = stream.pipeThrough(new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>)

    const segments: StoredEntry['segments'] = []
    let pending: Uint8Array[] = []
    let pendingLength = 0
    let compressedSize = 0
    const flush = async () => {
      if (!pendingLength) return
      const key = `${keyBase}/${segments.length}`
      await storage.put(key, concatenate(pending, pendingLength))
      segments.push({ key, size: pendingLength })
      compressedSize += pendingLength
      pending = []
      pendingLength = 0
    }
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending.push(value)
      pendingLength += value.length
      if (pendingLength >= SEGMENT_BYTES) await flush()
    }
    await flush()
    return {
      path,
      method: compress ? 8 : 0,
      crc32: crc,
      sha256: await sha.digestHex(),
      size,
      compressedSize,
      segments,
    }
  }

  function redactRow(row: ExportRow, omit: ReadonlySet<string>, scanner: SecretScanner): { row: ExportRow; count: number } {
    const out: ExportRow = {}
    let count = 0
    for (const [column, raw] of Object.entries(row)) {
      if (omit.has(column)) continue
      if (isSecretName(column)) {
        if (raw === null || raw === undefined || raw === '') out[column] = raw ?? null
        else {
          out[column] = REDACTED
          count += 1
        }
        continue
      }
      const result = scanner.redactValue(jsonCell(raw))
      out[column] = result.value
      count += result.count
    }
    return { row: out, count }
  }

  async function runUnit(
    job: ExportJob,
    unit: ExportUnit,
    index: number,
    source: ExportSource,
    scanner: SecretScanner,
    deadline: number,
  ) {
    const keyBase = `${base(job.workspaceId, job.id)}/u/${index}`
    if (unit.cursor === undefined) {
      unit.entries = []
      unit.redactions = 0
    }
    const encoder = new TextEncoder()

    if (source.kind === 'rows') {
      const omit = new Set(source.omitColumns ?? [])
      unit.expectedRows = source.expectedCount ? await source.expectedCount() : undefined
      let rows = 0
      const iterator = source.rows()[Symbol.asyncIterator]()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await iterator.next()
          if (done) {
            controller.close()
            return
          }
          const page = Array.isArray(value) ? value : [value]
          let text = ''
          for (const row of page) {
            const redacted = redactRow(row, omit, scanner)
            unit.redactions += redacted.count
            text += `${JSON.stringify(redacted.row)}\n`
            rows += 1
          }
          if (text) controller.enqueue(encoder.encode(text))
        },
        async cancel() {
          await iterator.return?.()
        },
      })
      unit.entries.push(await writeEntry(`${keyBase}/0`, `data/${source.name}.ndjson`, body, true))
      unit.rows = rows
      unit.status = 'done'
      return
    }

    if (source.kind === 'json') {
      const result = scanner.redactValue(await source.value())
      unit.redactions += result.count
      const text = `${JSON.stringify(result.value, null, 2)}\n`
      unit.entries.push(await writeEntry(`${keyBase}/0`, `data/${source.name}.json`, toStream(text), true))
      unit.status = 'done'
      return
    }

    if (source.kind === 'files') {
      // Resumable: `cursor` counts files already listed, so a later request
      // skips them and keeps the entries they produced.
      const folder = `files/${source.name}/`
      const used = new Set(unit.entries.map((e) => e.path.slice(folder.length)))
      const start = unit.cursor ?? 0
      let seen = 0
      let written = 0
      for await (const file of source.files()) {
        if (seen < start) {
          seen += 1
          continue
        }
        if (written >= FILES_PER_REQUEST || now() > deadline) {
          unit.cursor = seen
          return
        }
        const body = await file.open()
        seen += 1
        if (body !== null) {
          const path = folder + safePath(file.path, used)
          const masked = toStream(body).pipeThrough(scanner.maskBytes((n) => (unit.redactions += n)))
          unit.entries.push(await writeEntry(`${keyBase}/${unit.entries.length}`, path, masked, false))
          written += 1
        }
        unit.cursor = seen
      }
      unit.cursor = undefined
      unit.files = unit.entries.length
      unit.status = unit.entries.length ? 'done' : 'empty'
      return
    }

    const archive = await source.open()
    if (!archive) {
      unit.status = 'empty'
      return
    }
    const stats = { files: 0, bytes: 0, blanked: [] as string[] }
    const tarGz = archive
      .pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>)
      .pipeThrough(createTarInspector(stats))
      .pipeThrough(scanner.maskBytes((n) => (unit.redactions += n)))
      .pipeThrough(new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>)
    unit.entries.push(await writeEntry(`${keyBase}/0`, `sandbox/${source.name}.tar.gz`, tarGz, false))
    unit.archive = stats
    unit.files = stats.files
    unit.status = 'done'
  }

  function manifest(job: ExportJob, notes: Record<string, unknown> | undefined) {
    const classes: Record<string, string[]> = {}
    for (const unit of job.units) {
      for (const entry of unit.entries) (classes[unit.dataClass] ??= []).push(entry.path)
    }
    return {
      schema: MANIFEST_SCHEMA,
      app: options.app,
      workspaceId: job.workspaceId,
      exportId: job.id,
      requestedBy: job.requestedBy,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      secretPolicy:
        'Credential columns and JSON keys are replaced with "[redacted]". Credential-shaped values and the product\'s own keys are masked in rows and files. Credential files inside sandbox archives are overwritten with "*". Connections are exported as metadata only.',
      totals: {
        units: job.units.length,
        files: job.units.reduce((n, u) => n + u.entries.length, 0),
        rows: job.units.reduce((n, u) => n + (u.rows ?? 0), 0),
        bytes: job.units.reduce((n, u) => n + u.entries.reduce((m, e) => m + e.size, 0), 0),
        redactions: job.units.reduce((n, u) => n + u.redactions, 0),
      },
      classes,
      sources: job.units.map((u) => ({
        name: u.name,
        kind: u.kind,
        dataClass: u.dataClass,
        description: u.description,
        status: u.status,
        rows: u.rows,
        expectedRows: u.expectedRows,
        files: u.files,
        archive: u.archive,
        redactions: u.redactions,
      })),
      files: job.units.flatMap((u) =>
        u.entries.map((e) => ({ path: e.path, size: e.size, sha256: e.sha256, crc32: e.crc32.toString(16).padStart(8, '0') })),
      ),
      notes,
    }
  }

  function readme(job: ExportJob): string {
    return [
      `${options.app} workspace export`,
      '',
      `Workspace: ${job.workspaceId}`,
      `Export: ${job.id}`,
      `Created: ${job.createdAt}`,
      '',
      'manifest.json   what this archive contains: every file with its size and SHA-256, row counts per source, and the redaction policy',
      'data/*.ndjson   one JSON object per line, one file per table or record type',
      'data/*.json     single documents',
      'files/<source>/ uploaded and generated files, at their original paths',
      'sandbox/*.tar.gz the agent workspace filesystem; extract with `tar -xzf`',
      '',
      'Verify a file: `shasum -a 256 <path>` and compare with manifest.json.',
      'Secrets are never exported. Credential fields read "[redacted]".',
      '',
    ].join('\n')
  }

  async function finalize(job: ExportJob, plan: ExportPlan, scanner: SecretScanner) {
    job.completedAt = iso(now())
    const notes = plan.notes ? (scanner.redactValue(plan.notes).value as Record<string, unknown>) : undefined
    const keyBase = `${base(job.workspaceId, job.id)}/meta`
    const manifestText = `${JSON.stringify(manifest(job, notes), null, 2)}\n`
    job.meta = [
      await writeEntry(`${keyBase}/0`, 'manifest.json', toStream(manifestText), true),
      await writeEntry(`${keyBase}/1`, 'README.txt', toStream(readme(job)), true),
    ]
    job.status = 'complete'
  }

  return {
    archiveKey,

    async list(workspaceId: string): Promise<ExportJob[]> {
      const ids = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await storage.list(`${prefix}/${assertSafeKeySegment(workspaceId)}/`, cursor)
        for (const key of page.keys) if (key.endsWith('/job.json')) ids.add(key.split('/').at(-2)!)
        cursor = page.cursor
      } while (cursor)
      const jobs: ExportJob[] = []
      for (const id of [...ids].sort().reverse().slice(0, 10)) {
        const loaded = await loadJob(workspaceId, id)
        if (loaded) jobs.push(loaded.job)
      }
      return jobs
    },

    async get(workspaceId: string, id: string): Promise<ExportJob | null> {
      return (await loadJob(workspaceId, id))?.job ?? null
    },

    /** Start an export, or return the one already running for this workspace. */
    async start(workspaceId: string, requestedBy: string): Promise<ExportJob> {
      const existing = (await this.list(workspaceId)).find(
        (job) => job.status === 'running' && now() - Date.parse(job.updatedAt) < 15 * 60_000,
      )
      if (existing) return existing
      const plan = await options.plan({ workspaceId })
      const names = new Set<string>()
      for (const source of plan.sources) {
        if (!SOURCE_NAME.test(source.name)) throw new Error(`workspace-export: invalid source name "${source.name}"`)
        if (names.has(source.name)) throw new Error(`workspace-export: duplicate source name "${source.name}"`)
        names.add(source.name)
      }
      const created = now()
      const job: ExportJob = {
        v: 1,
        id: `${created.toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
        workspaceId,
        requestedBy,
        createdAt: iso(created),
        updatedAt: iso(created),
        status: 'running',
        units: plan.sources.map((s) => ({
          name: s.name,
          kind: s.kind,
          dataClass: s.dataClass,
          description: s.description,
          status: 'pending',
          attempts: 0,
          entries: [],
          redactions: 0,
        })),
      }
      await saveJob(job)
      return job
    },

    /**
     * Run pending units until `budgetMs` passes. A unit that starts always
     * finishes, so one call can run longer than the budget. Returns the job as
     * stored; another request holding the lease leaves it unchanged.
     */
    async advance(workspaceId: string, id: string, budgetMs = 20_000): Promise<ExportJob | null> {
      const loaded = await loadJob(workspaceId, id)
      if (!loaded) return null
      const { job } = loaded
      if (job.status !== 'running') return job
      if (job.lease && job.lease.until > now()) return job
      const deadline = now() + budgetMs
      let etag = loaded.etag
      try {
        job.lease = { id: crypto.randomUUID(), until: now() + LEASE_MS }
        etag = await saveJob(job, etag)
        const plan = await options.plan({ workspaceId })
        const scanner = createSecretScanner({ knownSecrets: (await options.knownSecrets?.({ workspaceId })) ?? [] })
        const sources = new Map(plan.sources.map((s) => [s.name, s]))
        for (const [index, unit] of job.units.entries()) {
          if (unit.status !== 'pending') continue
          if (now() > deadline) break
          const source = sources.get(unit.name)
          unit.attempts += 1
          try {
            if (!source || source.kind !== unit.kind) throw new Error('source is no longer available')
            await runUnit(job, unit, index, source, scanner, deadline)
            unit.error = undefined
          } catch (err) {
            unit.error = errorText(scanner, err)
            // A files unit keeps what it already wrote and resumes at its cursor.
            if (unit.cursor === undefined) unit.entries = []
            if (unit.attempts >= MAX_ATTEMPTS) {
              unit.status = 'failed'
              job.status = 'failed'
              job.error = `${unit.name}: ${unit.error}`
            }
            job.lease = { id: job.lease!.id, until: now() + LEASE_MS }
            etag = await saveJob(job, etag)
            break
          }
          job.lease = { id: job.lease!.id, until: now() + LEASE_MS }
          if (unit.status === 'pending') {
            // Progress was made; continue this unit in the next request.
            unit.attempts = 0
            etag = await saveJob(job, etag)
            break
          }
          etag = await saveJob(job, etag)
        }
        if (job.status === 'running' && job.units.every((u) => u.status === 'done' || u.status === 'empty')) {
          await finalize(job, plan, scanner)
        }
        job.lease = undefined
        await saveJob(job, etag)
        return job
      } catch (err) {
        if (err instanceof LeaseLost) return (await loadJob(workspaceId, id))?.job ?? null
        throw err
      }
    },

    progress(job: ExportJob): Omit<ExportProgress, 'downloadUrl' | 'downloadExpiresAt'> {
      const bytesOf = (u: ExportUnit) => u.entries.reduce((n, e) => n + e.size, 0)
      return {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        error: job.error,
        unitsTotal: job.units.length,
        unitsDone: job.units.filter((u) => u.status !== 'pending').length,
        current: job.status === 'running' ? job.units.find((u) => u.status === 'pending')?.name : undefined,
        bytes: job.units.reduce((n, u) => n + bytesOf(u), 0),
        units: job.units.map((u) => ({
          name: u.name,
          dataClass: u.dataClass,
          status: u.status,
          rows: u.rows,
          files: u.files,
          bytes: bytesOf(u),
          error: u.error,
        })),
      }
    },

    /** The finished archive as one stream with an exact length. */
    zip(job: ExportJob): { length: number; stream: ReadableStream<Uint8Array>; filename: string } {
      if (job.status !== 'complete' || !job.meta) throw new Error('workspace-export: export is not complete')
      const modifiedAt = new Date(job.completedAt ?? job.createdAt)
      const entries: ZipEntrySpec[] = [...job.meta, ...job.units.flatMap((u) => u.entries)].map((entry) => ({
        name: entry.path,
        method: entry.method,
        crc32: entry.crc32,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.size,
        modifiedAt,
        open: async () => {
          let index = 0
          let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
          return new ReadableStream<Uint8Array>({
            async pull(controller) {
              for (;;) {
                if (!reader) {
                  const segment = entry.segments[index]
                  if (!segment) {
                    controller.close()
                    return
                  }
                  index += 1
                  const object = await storage.get(segment.key)
                  if (!object || object.size !== segment.size) {
                    controller.error(new Error(`workspace-export: segment ${segment.key} is missing or changed`))
                    return
                  }
                  reader = object.body.getReader()
                }
                const { done, value } = await reader.read()
                if (!done) {
                  controller.enqueue(value)
                  return
                }
                reader = null
              }
            },
            async cancel(reason) {
              await reader?.cancel(reason)
            },
          })
        },
      }))
      const { length, stream } = createZipStream(entries)
      const date = (job.completedAt ?? job.createdAt).slice(0, 10)
      return { length, stream, filename: `${options.app}-workspace-export-${date}.zip` }
    },

    /** Delete exports older than `retentionMs`, and any export by id when given. */
    async prune(workspaceId: string, retentionMs: number, onlyId?: string): Promise<number> {
      const cutoff = now() - retentionMs
      const doomed: string[] = []
      let cursor: string | undefined
      const root = `${prefix}/${assertSafeKeySegment(workspaceId)}/`
      do {
        const page = await storage.list(root, cursor)
        for (const key of page.keys) {
          const id = key.slice(root.length).split('/')[0] ?? ''
          const created = Number.parseInt(id.split('-')[0] ?? '', 36)
          if (onlyId ? id === onlyId : Number.isFinite(created) && created < cutoff) doomed.push(key)
        }
        cursor = page.cursor
      } while (cursor)
      await storage.delete(doomed)
      return doomed.length
    },
  }
}

export type ExportEngine = ReturnType<typeof createExportEngine>
