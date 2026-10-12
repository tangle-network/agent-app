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
  ExportFile,
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
// A short lease, renewed while a request works, so a request that dies (closed
// tab, cancelled fetch) stalls the export for at most a minute.
const LEASE_MS = 60_000
const HEARTBEAT_MS = 20_000
const MAX_ATTEMPTS = 3
/** Files written per request. Each read and segment write is a subrequest, and
 *  Workers cap subrequests per request, so a large files source spans requests. */
const FILES_PER_REQUEST = 200
/** Files copied concurrently; four 8 MiB segments stay well inside a Worker's 128 MB. */
const FILES_IN_PARALLEL = 4
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
  /** Sandbox archives read at once in one request. Default 4. */
  archiveConcurrency?: number
  /** Table and JSON sources written at once in one request. Default 8. */
  rowConcurrency?: number
  now?: () => number
}

class LeaseLost extends Error {}

/**
 * Thrown by a source that cannot run yet for a reason that will pass, such as a
 * sandbox busy with another lifecycle operation. The unit stays pending without
 * spending an attempt, and the export moves on to other sources.
 */
export class ExportRetryLater extends Error {
  readonly retryLater = true
}

/** A deferred source waits this long before its next try, so a busy or restarting box gets real time to recover. */
const DEFER_MS = 30_000
/** Deferrals before the source fails the export: about ten minutes at DEFER_MS apart. */
const MAX_DEFERRALS = 20

function isRetryLater(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { retryLater?: unknown }).retryLater === true
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)
  // Spreadsheet apps run cells that start with these as formulas.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

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
  const archiveConcurrency = Math.max(1, Math.floor(options.archiveConcurrency ?? 4))

  const rowConcurrency = Math.max(1, Math.floor(options.rowConcurrency ?? 8))
  const batchKind = (kind: ExportUnit['kind']) => (kind === 'archive' ? 'archive' : kind === 'rows' || kind === 'json' ? 'rows' : null)

  /**
   * The units the next step runs, starting at `pending[from]`. Consecutive
   * units of one batchable kind run together under one job save. An archive
   * mostly waits on its box to resume and stream its tar, and a table unit on
   * two D1 queries and one storage write; run one at a time, a workspace with
   * dozens of sandboxes or a hundred mostly empty tables spends minutes on
   * those waits (a 97-table Builder export took 300 s). A unit already
   * attempted runs alone, so a batch that died at a Worker limit cannot keep
   * taking its neighbours with it. Files units run alone: they resume at a cursor.
   */
  function nextBatch<T extends { unit: ExportUnit }>(pending: T[], from: number): T[] {
    const first = pending[from]!
    const kind = batchKind(first.unit.kind)
    if (!kind || first.unit.attempts > 0) return [first]
    const limit = kind === 'archive' ? archiveConcurrency : rowConcurrency
    const batch = [first]
    for (let i = from + 1; i < pending.length && batch.length < limit; i += 1) {
      const candidate = pending[i]!
      if (batchKind(candidate.unit.kind) !== kind || candidate.unit.attempts > 0) break
      batch.push(candidate)
    }
    return batch
  }

  const base =(workspaceId: string, id: string) =>
    `${prefix}/${assertSafeKeySegment(workspaceId)}/${assertSafeKeySegment(id)}`
  const jobKey = (workspaceId: string, id: string) => `${base(workspaceId, id)}/job.json`
  /** The key a download signature covers. No object lives there; the zip is assembled per request. */
  const archiveKey = (workspaceId: string, id: string) => `${base(workspaceId, id)}/archive.zip`
  /** One small object per running export, so a scheduled job can find them without listing every segment. */
  const runningKey = (workspaceId: string, id: string) =>
    `${prefix}/_running/${assertSafeKeySegment(workspaceId)}~${assertSafeKeySegment(id)}`

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
      const csv = source.format === 'csv'
      const columns = (source.columns ?? []).filter((column) => !omit.has(column))
      if (csv && !columns.length) throw new Error(`workspace-export: csv source "${source.name}" needs columns`)
      let rows = 0
      const iterator = source.rows()[Symbol.asyncIterator]()
      // Peek, so a table with no rows writes no file: most of a workspace's
      // tables are empty, and a folder of empty files reads as a broken export.
      let first = await iterator.next()
      while (!first.done && Array.isArray(first.value) && first.value.length === 0) first = await iterator.next()
      if (first.done) {
        unit.rows = 0
        unit.status = 'empty'
        return
      }
      let header = csv ? `${columns.map(csvCell).join(',')}\r\n` : ''
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = first.done ? await iterator.next() : first
          first = { done: true, value: undefined }
          if (done) {
            controller.close()
            return
          }
          const page = Array.isArray(value) ? value : [value]
          let text = header
          header = ''
          for (const row of page) {
            const redacted = redactRow(row, omit, scanner)
            unit.redactions += redacted.count
            text += csv
              ? `${columns.map((column) => csvCell(redacted.row[column])).join(',')}\r\n`
              : `${JSON.stringify(redacted.row)}\n`
            rows += 1
          }
          if (text) controller.enqueue(encoder.encode(text))
        },
        async cancel() {
          await iterator.return?.()
        },
      })
      const path = csv ? `spreadsheets/${source.name}.csv` : `data/${source.name}.ndjson`
      unit.entries.push(await writeEntry(`${keyBase}/0`, path, body, true))
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
      // Files are copied FILES_IN_PARALLEL at a time: one at a time, each KV or R2
      // read plus segment write left a 1,000-file vault crawling. Paths are taken
      // in listing order, keys come from the listing position (unique across
      // resumes), and the cursor moves only past a fully written chunk.
      let chunk: { file: ExportFile; position: number; path: string }[] = []
      const flush = async () => {
        const written_ = await Promise.all(
          chunk.map(async ({ file, position, path }) => {
            const body = await file.open()
            if (body === null) return null
            const masked = toStream(body).pipeThrough(scanner.maskBytes((n) => (unit.redactions += n)))
            return writeEntry(`${keyBase}/p${position}`, path, masked, false)
          }),
        )
        for (const entry of written_) if (entry) unit.entries.push(entry)
        written += written_.filter(Boolean).length
        unit.cursor = chunk.at(-1)!.position + 1
        chunk = []
      }
      for await (const file of source.files()) {
        if (seen < start) {
          seen += 1
          continue
        }
        if (written + chunk.length >= FILES_PER_REQUEST || now() > deadline) {
          if (chunk.length) await flush()
          unit.cursor = seen
          return
        }
        chunk.push({ file, position: seen, path: folder + safePath(file.path, used) })
        seen += 1
        if (chunk.length >= FILES_IN_PARALLEL) await flush()
      }
      if (chunk.length) await flush()
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
    const stats: { files: number; bytes: number; blanked: string[]; excluded?: number } = { files: 0, bytes: 0, blanked: [] }
    const tarGz = archive
      .pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>)
      .pipeThrough(createTarInspector(stats, source.exclude))
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

  /** Describes what this archive actually holds, folder by folder. */
  function readme(job: ExportJob): string {
    const entries = job.units.flatMap((u) => u.entries.map((e) => e.path))
    const count = (folder: string) => entries.filter((path) => path.startsWith(folder)).length
    const folders: [string, string][] = [
      ['spreadsheets/', 'tables to open in a spreadsheet app, one row per record'],
      ['files/', 'documents and uploads at their original names, one folder per source'],
      ['data/', 'every database table that holds data, one JSON object per line (.ndjson) or one document (.json)'],
      ['sandbox/', "the agent's working files; extract with `tar -xzf`"],
    ]
    const lines = [`${options.app} workspace export`, '', `Workspace: ${job.workspaceId}`, `Export: ${job.id}`, `Created: ${job.createdAt}`, '']
    for (const [folder, what] of folders) {
      const n = count(folder)
      if (n) lines.push(`${folder.padEnd(14)}${n} file${n === 1 ? '' : 's'}: ${what}`)
    }
    const fileSources = [...new Set(entries.filter((p) => p.startsWith('files/')).map((p) => p.split('/')[1]))]
    if (fileSources.length) lines.push('', `Files: ${fileSources.map((name) => `files/${name}/`).join(', ')}`)
    const empty = job.units.filter((u) => u.status === 'empty').length
    if (empty) lines.push('', `${empty} source${empty === 1 ? ' was' : 's were'} empty and wrote no file; manifest.json lists every source.`)
    lines.push(
      '',
      'manifest.json lists every file with its size and SHA-256, row counts per source, and the redaction policy.',
      'Verify a file: `shasum -a 256 <path>` and compare with manifest.json.',
      'Secrets are never exported. Credential fields read "[redacted]".',
      '',
    )
    return lines.join('\n')
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
      await storage.put(runningKey(workspaceId, job.id), new Uint8Array(0))
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
      // Saves are serialized: the heartbeat and the unit loop share one etag.
      let saving: Promise<void> = Promise.resolve()
      const save = () => {
        saving = saving.then(async () => {
          if (job.lease) job.lease.until = now() + LEASE_MS
          etag = await saveJob(job, etag)
        })
        return saving
      }
      let heartbeat: ReturnType<typeof setInterval> | undefined
      try {
        job.lease = { id: crypto.randomUUID(), until: now() + LEASE_MS }
        await save()
        // Index every job this request touches, including ones started before the
        // index existed, so the background sweep can finish it if this tab closes.
        await storage.put(runningKey(workspaceId, id), new Uint8Array(0))
        heartbeat = setInterval(() => {
          save().catch(() => {})
        }, HEARTBEAT_MS)
        // Units waiting out a deferral are skipped until their time comes.
        const pending = job.units.flatMap((unit, index) =>
          unit.status === 'pending' && !(unit.retryAt && unit.retryAt > now()) ? [{ unit, index }] : [])
        // The plan is read only when something can run or the export can finish (its notes go in the manifest).
        const finishing = job.units.every((u) => u.status === 'done' || u.status === 'empty')
        const plan: ExportPlan = pending.length || finishing ? await options.plan({ workspaceId }) : { sources: [] }
        const scanner = createSecretScanner({ knownSecrets: (await options.knownSecrets?.({ workspaceId })) ?? [] })
        const sources = new Map(plan.sources.map((s) => [s.name, s]))
        let next = 0
        while (next < pending.length) {
          if (now() > deadline) break
          const batch = nextBatch(pending, next)
          next += batch.length
          const exhausted = batch.find(({ unit }) => unit.attempts >= MAX_ATTEMPTS)
          if (exhausted) {
            // Earlier requests died inside this unit without recording an outcome,
            // most often at the Worker CPU limit.
            const { unit } = exhausted
            unit.status = 'failed'
            unit.error ??= 'the request exporting this source ended before it finished'
            job.status = 'failed'
            job.error = `${unit.name}: ${unit.error}`
            await save()
            break
          }
          // Recorded before running, so a request that dies mid-unit still counts.
          for (const { unit } of batch) unit.attempts += 1
          await save()
          const failed = await Promise.all(
            batch.map(async ({ unit, index }) => {
              const source = sources.get(unit.name)
              try {
                if (!source || source.kind !== unit.kind) {
                  // Removed while the export ran (a deleted sandbox, a dropped table):
                  // nothing is left to export, so record why instead of failing the export.
                  unit.status = 'empty'
                  unit.entries = []
                  unit.error = 'removed from the workspace while the export ran'
                  return false
                }
                await runUnit(job, unit, index, source, scanner, deadline)
                unit.error = undefined
                unit.retryAt = undefined
                return false
              } catch (err) {
                unit.error = errorText(scanner, err)
                if (isRetryLater(err) && (unit.deferrals ?? 0) < MAX_DEFERRALS) {
                  // Busy, not broken: give the attempt back and try again on a later request.
                  unit.deferrals = (unit.deferrals ?? 0) + 1
                  unit.retryAt = now() + DEFER_MS
                  unit.attempts -= 1
                  if (unit.cursor === undefined) unit.entries = []
                  return 'deferred' as const
                }
                // A files unit keeps what it already wrote and resumes at its cursor.
                if (unit.cursor === undefined) unit.entries = []
                if (unit.attempts >= MAX_ATTEMPTS) unit.status = 'failed'
                return true
              }
            }),
          )
          const dead = batch.find(({ unit }) => unit.status === 'failed')
          if (dead) {
            job.status = 'failed'
            job.error = `${dead.unit.name}: ${dead.unit.error}`
          }
          if (failed.includes(true)) {
            await save()
            break
          }
          if (failed.includes('deferred')) {
            // The other sources keep going; the busy one runs again on the next request.
            await save()
            continue
          }
          const { unit } = batch[0]!
          if (unit.status === 'pending') {
            // Progress was made; continue this unit in the next request.
            unit.attempts = 0
            await save()
            break
          }
          await save()
        }
        if (job.status === 'running' && job.units.every((u) => u.status === 'done' || u.status === 'empty')) {
          await finalize(job, plan, scanner)
        }
        clearInterval(heartbeat)
        await saving.catch(() => {})
        job.lease = undefined
        await saveJob(job, etag)
        if (job.status !== 'running') await storage.delete([runningKey(workspaceId, id)])
        return job
      } catch (err) {
        if (err instanceof LeaseLost) return (await loadJob(workspaceId, id))?.job ?? null
        // A request that failed outside a unit (a storage or planning error) hands
        // the lease back, so the panel's retry continues now instead of waiting it out.
        // Only the stored job is touched, never this request's half-applied copy.
        clearInterval(heartbeat)
        await saving.catch(() => {})
        const leaseId = job.lease?.id
        const stored = leaseId ? await loadJob(workspaceId, id).catch(() => null) : null
        if (stored && stored.job.lease?.id === leaseId) {
          stored.job.lease = undefined
          await saveJob(stored.job, stored.etag).catch(() => {})
        }
        throw err
      } finally {
        clearInterval(heartbeat)
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
        unitsDone: job.units.filter((u) => u.status === 'done' || u.status === 'empty').length,
        unitsFailed: job.units.filter((u) => u.status === 'failed').length,
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
    /**
     * Advance every running export whose lease has lapsed, so an export keeps
     * going after the owner closes the tab. Call it from the product's scheduled
     * handler (a one-minute cron). Returns how many exports it advanced.
     */
    async continueRunning(budgetMs = 60_000): Promise<number> {
      const deadline = now() + budgetMs
      const keys: string[] = []
      let cursor: string | undefined
      do {
        const page = await storage.list(`${prefix}/_running/`, cursor)
        keys.push(...page.keys)
        cursor = page.cursor
      } while (cursor)
      let advanced = 0
      for (const key of keys) {
        const remaining = deadline - now()
        if (remaining <= 0) break
        const name = key.split('/').at(-1) ?? ''
        const workspaceId = name.slice(0, name.lastIndexOf('~'))
        const id = name.slice(name.lastIndexOf('~') + 1)
        if (!workspaceId || !id) continue
        const loaded = await loadJob(workspaceId, id)
        if (!loaded || loaded.job.status !== 'running') {
          await storage.delete([key])
          continue
        }
        if (loaded.job.lease && loaded.job.lease.until > now()) continue
        await this.advance(workspaceId, id, Math.min(remaining, 20_000))
        advanced += 1
      }
      return advanced
    },

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
