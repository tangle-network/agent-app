/**
 * Vault path rules and the KV key layout. Every key the Vault store writes is
 * built here, so a path that passes `validateVaultFilePath` and fits the
 * 512-byte Cloudflare KV key limit is exactly a path the store can hold.
 */
import { isWorkspaceFileExportable } from '../../web/file-export'

export const VAULT_KV_KEY_MAX_BYTES = 512

export class VaultPathError extends Error {
  readonly code: string = 'vault.invalid_path'
  readonly path?: string

  constructor(message: string, path?: string) {
    super(message)
    this.name = 'VaultPathError'
    this.path = path
  }
}

/** A path the workspace export boundary keeps private (runtime configuration). */
export class VaultPrivateRuntimeFileError extends VaultPathError {
  override readonly code = 'vault.private_runtime_file'

  constructor(path: string) {
    super('Runtime configuration is not available through workspace files', path)
    this.name = 'VaultPrivateRuntimeFileError'
  }
}

export type VaultStorageKeyKind = 'head' | 'revision' | 'operation' | 'metadata' | 'prefix' | 'erasure'
const VAULT_STORAGE_KEY_KINDS: readonly string[] = ['head', 'revision', 'operation', 'metadata', 'prefix', 'erasure']

export class VaultStorageKeyError extends VaultPathError {
  override readonly code = 'vault.key_too_long'
  readonly actualBytes: number
  readonly maxBytes = VAULT_KV_KEY_MAX_BYTES
  readonly keyKind: VaultStorageKeyKind

  constructor(input: {
    path?: string
    actualBytes: number
    keyKind: VaultStorageKeyKind
  }) {
    const subject = input.path ? `Vault path "${input.path}"` : `Vault ${input.keyKind} key`
    super(`${subject} exceeds the ${VAULT_KV_KEY_MAX_BYTES}-byte storage key limit`, input.path)
    this.name = 'VaultStorageKeyError'
    this.actualBytes = input.actualBytes
    this.keyKind = input.keyKind
  }
}

export interface VaultPathErrorResponseBody {
  error: {
    code: string
    message: string
    path?: string
    actualBytes?: number
    maxBytes?: number
    keyKind?: VaultStorageKeyKind
  }
}

export function vaultPathErrorResponseBody(error: VaultPathError): VaultPathErrorResponseBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      path: error.path,
      ...(error instanceof VaultStorageKeyError
        ? {
            actualBytes: error.actualBytes,
            maxBytes: error.maxBytes,
            keyKind: error.keyKind,
          }
        : {}),
    },
  }
}

/** The typed path error a coordinator response carries, or null when it carries none. */
export function parseVaultPathErrorResponse(value: unknown): VaultPathError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const detail = (value as { error?: unknown }).error
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null
  const error = detail as Record<string, unknown>
  const path = typeof error.path === 'string' ? error.path : undefined
  if (error.code === 'vault.key_too_long'
    && typeof error.actualBytes === 'number'
    && VAULT_STORAGE_KEY_KINDS.includes(String(error.keyKind))) {
    return new VaultStorageKeyError({
      path,
      actualBytes: error.actualBytes,
      keyKind: error.keyKind as VaultStorageKeyKind,
    })
  }
  if (error.code === 'vault.private_runtime_file' && path) return new VaultPrivateRuntimeFileError(path)
  if (error.code === 'vault.invalid_path' && typeof error.message === 'string') {
    return new VaultPathError(error.message, path)
  }
  return null
}

export function validateWorkspaceId(workspaceId: string): void {
  if (!workspaceId) throw new VaultPathError('Workspace ID is required')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(workspaceId)) {
    throw new VaultPathError(`Invalid workspace ID: ${workspaceId}`)
  }
}

export function validateVaultFilePath(filePath: string): void {
  if (!filePath) throw new VaultPathError('File path is required', filePath)
  if (filePath.includes('\0')) throw new VaultPathError('File path must not contain null bytes', filePath)
  if (filePath.startsWith('/')) throw new VaultPathError('File path must be relative', filePath)
  if (filePath.includes('\\')) throw new VaultPathError('File path must use forward slashes', filePath)

  for (const segment of filePath.split('/')) {
    if (!segment) throw new VaultPathError('File path must not contain empty segments', filePath)
    if (segment === '.' || segment === '..') {
      throw new VaultPathError('File path must not contain "." or ".." segments', filePath)
    }
    if (segment.startsWith('.')) {
      throw new VaultPathError('File path must not contain hidden segments', filePath)
    }
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new VaultPathError('File path contains unsupported characters; use ASCII letters, digits, ".", "_", and "-"', filePath)
    }
  }
  if (!isWorkspaceFileExportable(filePath)) throw new VaultPrivateRuntimeFileError(filePath)
}

/** Whether any segment of `filePath` is hidden (starts with a dot). */
export function isHiddenVaultFilePath(filePath: string): boolean {
  return filePath.split('/').some((segment) => segment.startsWith('.'))
}

function assertVaultKeyLength(
  key: string,
  input: { path?: string; keyKind: VaultStorageKeyKind },
): string {
  const actualBytes = new TextEncoder().encode(key).byteLength
  if (actualBytes > VAULT_KV_KEY_MAX_BYTES) {
    throw new VaultStorageKeyError({ ...input, actualBytes })
  }
  return key
}

export function vaultHeadKey(workspaceId: string, path: string): string {
  validateWorkspaceId(workspaceId)
  validateVaultFilePath(path)
  return assertVaultKeyLength(`vault:${workspaceId}:${path}`, { path, keyKind: 'head' })
}

export function vaultHeadPrefix(workspaceId: string): string {
  validateWorkspaceId(workspaceId)
  return assertVaultKeyLength(`vault:${workspaceId}:`, { keyKind: 'prefix' })
}

/**
 * Head keys under a path prefix. The prefix may end inside a segment (`notes/me`)
 * or at a separator (`memories/workspace/`); empty means the whole Vault.
 */
export function vaultHeadPathPrefix(workspaceId: string, pathPrefix: string): string {
  const base = vaultHeadPrefix(workspaceId)
  if (!pathPrefix) return base
  if (pathPrefix.startsWith('/') || pathPrefix.includes('\\') || pathPrefix.includes('\0')
    || pathPrefix.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new VaultPathError('Vault path prefix must be relative and normalized', pathPrefix)
  }
  return assertVaultKeyLength(`${base}${pathPrefix}`, { path: pathPrefix, keyKind: 'prefix' })
}

/** Erasure audit rows of one path sort by its write count, zero-padded to 12 digits. */
export function vaultErasureKey(workspaceId: string, path: string, sequence: number): string {
  validateWorkspaceId(workspaceId)
  validateVaultFilePath(path)
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new VaultPathError('Vault erasure sequence must be a positive integer', path)
  }
  return assertVaultKeyLength(
    `vault-erasure:${workspaceId}:${path}:${String(sequence).padStart(12, '0')}`,
    { path, keyKind: 'erasure' },
  )
}

/** An unfinished erasure's job record, or one chunk of the revision ids it collected. */
export function vaultErasureJobKey(workspaceId: string, path: string, sequence: number, chunk?: number): string {
  const row = vaultErasureKey(workspaceId, path, sequence)
  const key = `vault-erasure-job:${row.slice('vault-erasure:'.length)}${chunk === undefined ? '' : `:${chunk}`}`
  return assertVaultKeyLength(key, { path, keyKind: 'erasure' })
}

export function vaultErasurePrefix(workspaceId: string, pathPrefix = ''): string {
  validateWorkspaceId(workspaceId)
  return assertVaultKeyLength(`vault-erasure:${workspaceId}:${pathPrefix}`, { path: pathPrefix, keyKind: 'prefix' })
}

export function vaultRevisionKey(workspaceId: string, revision: string, path?: string): string {
  validateWorkspaceId(workspaceId)
  if (!revision) throw new VaultPathError('Vault revision is required', path)
  return assertVaultKeyLength(`vault-revision:${workspaceId}:${revision}`, { path, keyKind: 'revision' })
}

/** Every revision record of a workspace, committed and conflicting alike. */
export function vaultRevisionPrefix(workspaceId: string): string {
  validateWorkspaceId(workspaceId)
  return assertVaultKeyLength(`vault-revision:${workspaceId}:`, { keyKind: 'prefix' })
}

export function vaultOperationKey(workspaceId: string, operationId: string, path?: string): string {
  validateWorkspaceId(workspaceId)
  if (!operationId) throw new VaultPathError('Vault mutation operationId is required', path)
  return assertVaultKeyLength(`vault-operation:${workspaceId}:${operationId}`, { path, keyKind: 'operation' })
}

export function vaultMetaKey(workspaceId: string, key: string): string {
  validateWorkspaceId(workspaceId)
  if (!key) throw new VaultPathError('Vault metadata key is required')
  return assertVaultKeyLength(`vault-meta:${workspaceId}:${key}`, { keyKind: 'metadata' })
}

export function validateVaultMutationKeys(input: {
  workspaceId: string
  operationId: string
  changes: Array<{ path: string; revision?: string }>
}): void {
  vaultOperationKey(input.workspaceId, input.operationId)
  for (const change of input.changes) {
    vaultHeadKey(input.workspaceId, change.path)
    if (change.revision) vaultRevisionKey(input.workspaceId, change.revision, change.path)
  }
}
