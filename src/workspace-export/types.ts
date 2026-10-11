/** Public contracts for `/workspace-export`. */

/** What kind of customer data a source holds. The manifest groups files by class. */
export type ExportDataClass =
  | 'workspace'
  | 'people'
  | 'conversations'
  | 'traces'
  | 'files'
  | 'knowledge'
  | 'connections'
  | 'sandbox'
  | 'lines'
  | 'ledgers'
  | 'billing'
  | 'records'

export type ExportRow = Record<string, unknown>

interface SourceBase {
  /** Unique within the export; becomes the archive path. `[a-z0-9_.-]`, no slashes. */
  name: string
  dataClass: ExportDataClass
  /** One line for the manifest, e.g. which table or prefix this reads. */
  description?: string
}

/**
 * Rows written as NDJSON to `data/<name>.ndjson`, or with `format: 'csv'` as a
 * spreadsheet at `spreadsheets/<name>.csv`. A source with no rows writes no file.
 */
export interface ExportRowsSource extends SourceBase {
  kind: 'rows'
  /** `csv` needs `columns`: the header row, in order. Default `ndjson`. */
  format?: 'ndjson' | 'csv'
  columns?: readonly string[]
  /** Yield rows or pages of rows. Products decrypt their own encrypted columns here. */
  rows(): AsyncIterable<ExportRow | ExportRow[]>
  /** The count the database reports, recorded beside the written count. */
  expectedCount?(): Promise<number>
  /** Columns dropped entirely, in addition to the automatic credential-name policy. */
  omitColumns?: readonly string[]
}

export interface ExportFile {
  /** Path under `files/<source>/`. Leading slashes and `..` are removed. */
  path: string
  /** Bytes, text, a stream, or `null` when the file vanished since listing. */
  open(): Promise<ReadableStream<Uint8Array> | Uint8Array | string | null>
}

/** Individual files written under `files/<name>/`. */
export interface ExportFilesSource extends SourceBase {
  kind: 'files'
  files(): AsyncIterable<ExportFile>
}

/**
 * A gzip-compressed tar, normally a sandbox workspace read through the Sandbox
 * SDK (`box.fs.openArchive(dir)`). Written to `sandbox/<name>.tar.gz` after
 * credential files are blanked and credential values masked.
 */
export interface ExportArchiveSource extends SourceBase {
  kind: 'archive'
  /** `null` when there is nothing to archive (no sandbox for this workspace). */
  open(): Promise<ReadableStream<Uint8Array> | null>
  /** Directory names whose contents are left out wherever they appear, e.g. `node_modules`. */
  exclude?: readonly string[]
}

/** One JSON document written to `data/<name>.json`. */
export interface ExportJsonSource extends SourceBase {
  kind: 'json'
  value(): Promise<unknown>
}

export type ExportSource = ExportRowsSource | ExportFilesSource | ExportArchiveSource | ExportJsonSource

export interface ExportPlan {
  sources: ExportSource[]
  /** Extra manifest sections, such as database table coverage. Redacted like rows. */
  notes?: Record<string, unknown>
}

/** Who asked. `role` must be `'owner'`; anything else is refused. */
export interface ExportPrincipal {
  userId: string
  role: string
}

export interface StoredEntry {
  /** Path inside the archive. */
  path: string
  method: 0 | 8
  crc32: number
  sha256: string
  size: number
  compressedSize: number
  segments: { key: string; size: number }[]
}

export type UnitStatus = 'pending' | 'done' | 'empty' | 'failed'

export interface ExportUnit {
  name: string
  kind: ExportSource['kind']
  dataClass: ExportDataClass
  description?: string
  status: UnitStatus
  attempts: number
  entries: StoredEntry[]
  rows?: number
  expectedRows?: number
  files?: number
  /** Files listed so far by a files unit that continues in the next request. */
  cursor?: number
  /** Members and bytes inside a sandbox archive, and members left out by `exclude`. */
  archive?: { files: number; bytes: number; blanked: string[]; excluded?: number }
  /** Times the source asked to be retried later (a busy sandbox) without spending an attempt. */
  deferrals?: number
  redactions: number
  error?: string
}

export type ExportStatus = 'running' | 'complete' | 'failed'

export interface ExportJob {
  v: 1
  id: string
  workspaceId: string
  requestedBy: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  status: ExportStatus
  error?: string
  units: ExportUnit[]
  /** manifest.json and README.txt, written when every unit finished. */
  meta?: StoredEntry[]
  lease?: { id: string; until: number }
}

/** What the progress endpoint returns. */
export interface ExportProgress {
  id: string
  status: ExportStatus
  createdAt: string
  completedAt?: string
  error?: string
  unitsTotal: number
  /** Sources finished, with or without data. Failed sources are counted in `unitsFailed`, never here. */
  unitsDone: number
  unitsFailed: number
  current?: string
  bytes: number
  units: { name: string; dataClass: ExportDataClass; status: UnitStatus; rows?: number; files?: number; bytes: number; error?: string }[]
  /** Signed, expiring link; present once the export is complete. */
  downloadUrl?: string
  downloadExpiresAt?: string
}
