/**
 * `/workspace-export` — owner-only, complete, secret-free workspace exports.
 *
 * A product declares where a workspace's data lives (D1 tables, R2 and KV
 * prefixes, the sandbox filesystem, JSON documents) and mounts one route. The
 * owner clicks Export, the work runs source by source with resumable progress,
 * and the result downloads as one zip with a manifest of counts and SHA-256
 * checksums through a signed, expiring link. See docs/workspace-export.md.
 */

export { createWorkspaceExport, type WorkspaceExportOptions } from './routes'
export { createExportEngine, MANIFEST_SCHEMA, type ExportEngine, type ExportEngineOptions } from './engine'
export { createR2ExportStorage, createMemoryExportStorage, type ExportStorage, type R2ExportBucket } from './storage'
export { d1WorkspaceTables, type D1ExportDatabase, type D1TableCoverage, type D1WorkspaceTablesOptions } from './d1'
export { r2Files, kvFiles, type R2FilesBucket, type KVFilesNamespace } from './sources'
export { createSecretScanner, isSecretName, isCredentialFile, REDACTED, type SecretScanner } from './secrets'
export type {
  ExportArchiveSource,
  ExportDataClass,
  ExportFile,
  ExportFilesSource,
  ExportJob,
  ExportJsonSource,
  ExportPlan,
  ExportPrincipal,
  ExportProgress,
  ExportRow,
  ExportRowsSource,
  ExportSource,
  ExportStatus,
  ExportUnit,
  StoredEntry,
  UnitStatus,
} from './types'
