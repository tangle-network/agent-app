/**
 * Read a sandbox provisioning failure without leaking what it carries.
 *
 * Provisioning errors arrive as deep `cause` chains from the sandbox API, the
 * runtime sidecar, and the app's own vault code, and they routinely carry
 * bearer tokens and signed URLs in their messages. Every app on this shell
 * needs the same three things from one: a redacted shape it can log, a
 * classification it can act on, and a sentence it can show a person. Before
 * this module each app either wrote its own or — far more often — wrote none,
 * and surfaced the raw error or a generic apology.
 *
 * The classifiers are deliberately narrow. `isSandboxApiSandboxMissingFailure`
 * does not fire on a 404 from inside a live box; `isSandboxHostCapacityFailure`
 * does not fire on capacity wording from any origin but the sandbox API. A
 * classifier that over-matches turns a transient failure into a box deletion.
 */
import { EGRESS_PROXY_RECOVERY_REQUIRED } from './recovery'

const SAFE_ERROR_FIELDS = [
  'code',
  'status',
  'phase',
  'endpoint',
  'origin',
  'retryAfterMs',
  'sidecarVersion',
  'containerImage',
] as const

export interface SafeSandboxErrorCause {
  name?: string
  message?: string
  code?: string | number
  status?: string | number
  phase?: string
  endpoint?: string
  origin?: string
  retryAfterMs?: number
  sidecarVersion?: string
  containerImage?: string
}

export interface SafeSandboxErrorDiagnostics {
  message: string
  causes: SafeSandboxErrorCause[]
  truncated: boolean
  truncatedAtDepth?: number
  cycle: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asSafeScalar(value: unknown): string | number | undefined {
  if (typeof value === 'string' && value.length > 0) return redactDiagnosticText(value)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function redactDiagnosticText(value: string): string {
  const secretKeyPattern = '(?:(?:[A-Z0-9]+_)*(?:api_?key|auth_?token|access_?token|refresh_?token|key|token|password|secret|credential)|apiKey|authToken|accessToken|refreshToken)'
  return value
    .replace(/(['"]authorization['"]\s*:\s*)(['"])[^'"]*\2/gi, '$1$2[REDACTED]$2')
    .replace(/\b(authorization\s*[:=]\s*)(['"])[^'"]*\2/gi, '$1$2[REDACTED]$2')
    .replace(/\b(authorization\s*[:=]\s*)Digest\b[^;}\n]*(?:\r?\n[ \t]+[^;}\n]*)*/gi, '$1[REDACTED]')
    .replace(/\b(authorization\s*[:=]\s*)(?:Basic|Bearer|Negotiate)\s+[^\s;,&}\n]+(?:\r?\n[ \t]+[^\s;,&}\n]+)*/gi, '$1[REDACTED]')
    .replace(new RegExp(`\\b(authorization\\s*[:=]\\s*)(?!(?:Basic|Bearer|Digest|Negotiate)\\b)([A-Za-z][A-Za-z0-9._-]+)\\s+(?!(?:authorization|${secretKeyPattern})\\s*[:=]|['"](?:authorization|${secretKeyPattern})['"]\\s*:)([^}\\n]*(?:\\r?\\n[ \\t]+[^}\\n]*)*)`, 'gi'), (_match, prefix: string, _scheme: string, valuePart: string) => {
      if (valuePart.includes(';') || /\r?\n[ \t]+/.test(valuePart)) return `${prefix}[REDACTED]`
      const tokenMatch = valuePart.match(/^\S+(.*)$/)
      return `${prefix}[REDACTED]${tokenMatch?.[1] ?? ''}`
    })
    .replace(/\b(authorization\s*[:=]\s*)[A-Za-z][\w.-]+\s+[^\s;,&}\n]+(?=[;&}\n]|$)/gi, '$1[REDACTED]')
    .replace(/\b(authorization\s*[:=]\s*)(?!\[REDACTED\])[^'"\s&}]+(?:[;,][^'"\s&}]+)*/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-[REDACTED]')
    .replace(
      /([?&][^=&#\s]*(?:token|key|secret|password|authorization)[^=&#\s]*=)[^&#\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      new RegExp(`(['"])(${secretKeyPattern})\\1\\s*:\\s*(['"])[^'"]+\\3`, 'gi'),
      '$1$2$1:$3[REDACTED]$3',
    )
    .replace(
      new RegExp(`\\b(${secretKeyPattern})\\s*([:=])(\\s*)(['"]?)(?!Bearer\\b)[^'"\\s;,&}]+(?:[;,]\\s*[^'"\\s;,&}]+)*`, 'gi'),
      '$1$2$3$4[REDACTED]',
    )
}

function readMessage(value: unknown): string | undefined {
  if (value instanceof Error) return redactDiagnosticText(value.message)
  if (typeof value === 'string' && value.length > 0) return redactDiagnosticText(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  if (!isRecord(value)) return undefined
  const message = value.message
  return typeof message === 'string' && message.length > 0 ? redactDiagnosticText(message) : undefined
}

function readName(value: unknown): string | undefined {
  if (value instanceof Error) return redactDiagnosticText(value.name)
  if (!isRecord(value)) return undefined
  const name = value.name
  return typeof name === 'string' && name.length > 0 ? redactDiagnosticText(name) : undefined
}

function readCause(value: unknown): unknown {
  if (!isRecord(value)) return undefined
  return value.cause
}

export function serializeSandboxProvisioningError(
  error: unknown,
  options: { maxDepth?: number } = {},
): SafeSandboxErrorDiagnostics {
  const maxDepth = options.maxDepth ?? 6
  const causes: SafeSandboxErrorCause[] = []
  const seen = new Set<unknown>()
  let truncatedAtDepth: number | undefined
  let cycle = false

  let current: unknown = error
  let depth = 0
  for (; depth < maxDepth && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) {
      cycle = true
      causes.push({
        name: 'CauseChainCycle',
        message: `cause chain cycle detected after ${depth} entries`,
      })
      break
    }
    if (isRecord(current)) seen.add(current)

    const cause: SafeSandboxErrorCause = {}
    const name = readName(current)
    const message = readMessage(current)
    if (name) cause.name = name
    if (message) cause.message = message

    if (isRecord(current)) {
      for (const field of SAFE_ERROR_FIELDS) {
        const safeValue = asSafeScalar(current[field])
        if (safeValue !== undefined) {
          Object.assign(cause, { [field]: safeValue })
        }
      }
    }

    if (Object.keys(cause).length > 0) causes.push(cause)
    current = readCause(current)
  }

  if (!cycle && isRecord(current) && seen.has(current)) {
    cycle = true
    causes.push({
      name: 'CauseChainCycle',
      message: `cause chain cycle detected after ${depth} entries`,
    })
  } else if (current !== undefined && current !== null && depth >= maxDepth) {
    truncatedAtDepth = maxDepth
    causes.push({
      name: 'CauseChainTruncated',
      message: `cause chain truncated after ${maxDepth} entries`,
    })
  }

  return {
    message: readMessage(error) ?? 'Sandbox unavailable',
    causes,
    truncated: truncatedAtDepth !== undefined,
    truncatedAtDepth,
    cycle,
  }
}

export function formatSandboxProvisioningSupportDetails(
  diagnostics: SafeSandboxErrorDiagnostics,
): string {
  const actionableCause = diagnostics.causes.find((cause) =>
    cause.code !== undefined
    || cause.status !== undefined
    || cause.phase !== undefined
    || cause.endpoint !== undefined
    || cause.origin !== undefined
    || cause.retryAfterMs !== undefined
    || cause.sidecarVersion !== undefined
    || cause.containerImage !== undefined,
  ) ?? diagnostics.causes[1]

  if (!actionableCause) return 'Support details: no nested sandbox cause details were available.'

  const details = [
    typeof actionableCause.name === 'string' ? redactDiagnosticText(actionableCause.name) : undefined,
    actionableCause.code !== undefined ? `code=${actionableCause.code}` : undefined,
    actionableCause.status !== undefined ? `status=${actionableCause.status}` : undefined,
    actionableCause.phase !== undefined ? `phase=${redactDiagnosticText(actionableCause.phase)}` : undefined,
    actionableCause.endpoint !== undefined ? `endpoint=${redactDiagnosticText(actionableCause.endpoint)}` : undefined,
    actionableCause.origin !== undefined ? `origin=${redactDiagnosticText(actionableCause.origin)}` : undefined,
    actionableCause.retryAfterMs !== undefined ? `retryAfterMs=${actionableCause.retryAfterMs}` : undefined,
    actionableCause.sidecarVersion !== undefined ? `sidecarVersion=${redactDiagnosticText(actionableCause.sidecarVersion)}` : undefined,
    actionableCause.containerImage !== undefined ? `containerImage=${redactDiagnosticText(actionableCause.containerImage)}` : undefined,
    typeof actionableCause.message === 'string' ? redactDiagnosticText(actionableCause.message) : undefined,
  ].filter(Boolean)

  if (details.length === 0) return 'Support details: no nested sandbox cause details were available.'
  return `Support details: ${details.join('; ')}`
}

export function isSandboxAuthFailure(diagnostics: SafeSandboxErrorDiagnostics): boolean {
  return diagnostics.causes.some((cause) => {
    const code = typeof cause.code === 'string' ? cause.code.toUpperCase() : undefined
    const status = typeof cause.status === 'number'
      ? cause.status
      : typeof cause.status === 'string'
        ? Number.parseInt(cause.status, 10)
        : undefined
    const name = typeof cause.name === 'string' ? cause.name.toLowerCase() : ''
    const message = typeof cause.message === 'string' ? cause.message.toLowerCase() : ''

    return code === 'AUTH_ERROR'
      || status === 401
      || name.includes('autherror')
      || message.includes('missing or invalid authentication')
  })
}

export function isSandboxApiBearerAuthFailure(diagnostics: SafeSandboxErrorDiagnostics): boolean {
  return diagnostics.causes.some((cause) => {
    const status = typeof cause.status === 'number'
      ? cause.status
      : typeof cause.status === 'string'
        ? Number.parseInt(cause.status, 10)
        : undefined
    if (status !== 401) return false
    if (cause.origin !== 'sandbox-api') return false
    if (typeof cause.endpoint !== 'string') return false
    const endpointPath = sandboxApiEndpointPath(cause.endpoint)
    if (!endpointPath) return false
    return /^\/v1\/sandboxes\/[^/?#]+(?:\/(?!runtime(?:[/?#]|$))[^?#]*)?(?:[?#].*)?$/.test(endpointPath)
  })
}

/** Machine-readable code emitted when resume lost the physical box. */
export const SANDBOX_BACKING_CONTAINER_MISSING_CODE = 'BACKING_CONTAINER_MISSING' as const

/**
 * Legacy fallback for Sandbox API releases that only returned the nested host
 * 404 text. New callers must use `SANDBOX_BACKING_CONTAINER_MISSING_CODE`.
 */
export function isLegacySandboxBackingContainerMissingMessage(message: string): boolean {
  return /host-agent startcontainer failed \(404\):/i.test(message)
    && /container not found/i.test(message)
    && /"code"\s*:\s*"not_found"/i.test(message)
}

/**
 * True when the sandbox API cannot find a sandbox resource or its backing
 * container. The latter arrives as a 500 from resume with a nested host 404.
 *
 * A sandbox id is a cache of where a workspace's box lives, not the workspace's
 * identity: the platform reaps, suspends, and loses boxes as ordinary lifecycle
 * events. Callers use this to discard the dead id and provision a replacement,
 * so the match is deliberately narrow — a 404 from the runtime sidecar
 * (`/runtime/...`, a missing file or session inside a live box) is NOT this.
 */
export function isSandboxApiSandboxMissingFailure(diagnostics: SafeSandboxErrorDiagnostics): boolean {
  return diagnostics.causes.some((cause) => {
    const status = typeof cause.status === 'number'
      ? cause.status
      : typeof cause.status === 'string'
        ? Number.parseInt(cause.status, 10)
        : undefined
    if (cause.origin !== 'sandbox-api') return false
    if (typeof cause.endpoint !== 'string') return false
    const endpointPath = sandboxApiEndpointPath(cause.endpoint)
    if (!endpointPath) return false
    const sandboxResource = /^\/v1\/sandboxes\/[^/?#]+(?:\/(?!runtime(?:[/?#]|$))[^?#]*)?(?:[?#].*)?$/.test(endpointPath)
    if (!sandboxResource) return false
    if (status === 404) return true

    if (status !== 500 || !/^\/v1\/sandboxes\/[^/?#]+\/resume(?:[?#].*)?$/.test(endpointPath)) {
      return false
    }
    const code = typeof cause.code === 'string' ? cause.code.toUpperCase() : undefined
    if (code === SANDBOX_BACKING_CONTAINER_MISSING_CODE) return true
    // Older Sandbox API releases returned only the nested host 404. The SDK
    // represented that response as SERVER_ERROR, so keep this exact fallback
    // until those releases are no longer in service.
    if (code !== undefined && code !== 'SERVER_ERROR') return false
    const message = typeof cause.message === 'string' ? cause.message : ''
    return isLegacySandboxBackingContainerMissingMessage(message)
  })
}

/**
 * True when a resume failed because the host the box is pinned to cannot seat
 * it — the host's slot budget is exhausted, not the box's fault and not
 * something waiting fixes.
 *
 * A box lives on one host. When that host fills, every future resume for every
 * box on it fails identically and permanently, so a workspace whose box landed
 * on a full host is bricked until it is placed somewhere else. Callers use this
 * the same way they use {@link isSandboxApiSandboxMissingFailure}: discard the
 * dead id and provision a replacement, which the orchestrator is free to place
 * on a host with room. The workspace itself is preserved — it lives in the
 * Vault, not in the box's filesystem.
 *
 * Matched on the message because the sandbox API returns a generic
 * `SERVER_ERROR` for it; a dedicated code upstream would replace this.
 */
export function isSandboxHostCapacityFailure(diagnostics: SafeSandboxErrorDiagnostics): boolean {
  return diagnostics.causes.some((cause) => {
    if (cause.origin !== 'sandbox-api') return false
    if (typeof cause.message !== 'string') return false
    return /host has no available slot|host capacity reservation failed/i.test(cause.message)
  })
}

/**
 * True when a resume failed on the box's own configuration rather than on
 * anything a retry can change.
 *
 * These are permanent facts about one box. Its egress policy can be missing,
 * or its verified Platform lineage can differ from the current caller. Neither
 * creation-time fact can change on resume, so the box must be replaced.
 *
 * Narrow on purpose. A bare 500 from the sandbox API is transient far more
 * often than not, and treating one as unbringable would delete a healthy box.
 * Matched on the specific unrecoverable phrasing, and only from `sandbox-api`.
 */
export function isSandboxBoxConfigFailure(diagnostics: SafeSandboxErrorDiagnostics): boolean {
  return diagnostics.causes.some((cause) => {
    if (cause.origin !== 'sandbox-api') return false
    if (cause.code === 'SANDBOX_ATTRIBUTION_MISMATCH') return true
    if (typeof cause.message !== 'string') return false
    return /has no recorded egress policy|cannot rebuild the proxy config/i.test(cause.message)
  })
}

function sandboxApiEndpointPath(endpoint: string): string | null {
  if (endpoint.startsWith('/')) return endpoint
  try {
    const url = new URL(endpoint)
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}

export function formatSandboxProvisioningUserMessage(
  diagnostics: SafeSandboxErrorDiagnostics,
): string {
  if (diagnostics.causes.some((cause) => cause.code === EGRESS_PROXY_RECOVERY_REQUIRED)) {
    return 'Sandbox recovery is required before chat can continue. The stopped sandbox has not been deleted.'
  }

  // The sandbox itself is reachable — copying the Vault into it is what did not
  // finish. Saying "the service is unavailable" sends people to inspect
  // infrastructure that is healthy.
  if (diagnostics.causes.some((cause) => cause.code === 'vault.hydration_incomplete')) {
    return 'I couldn\'t finish copying your Vault into the sandbox, so I stopped rather than work from a partial copy. The copy resumes where it left off — try again in a moment.'
  }

  if (isSandboxApiBearerAuthFailure(diagnostics)) {
    return 'I\'m unable to reconnect to the sandbox because its sandbox API credential was rejected. Another request may have rotated the bearer used for this operation.'
  }

  if (isSandboxAuthFailure(diagnostics)) {
    return 'I\'m unable to reconnect to the sandbox because its runtime authentication failed. This can happen when an existing sandbox is reused with stale credentials.'
  }

  if (diagnostics.causes.some((cause) => (
    cause.code === 'PAYLOAD_TOO_LARGE'
    || cause.code === 'FILE_TOO_LARGE'
    || cause.status === 413
    || cause.status === '413'
  ))) {
    return 'An attachment is too large for the sandbox to accept. Use a smaller file and try again.'
  }

  // Matched by code, not bare 429: the sidecar's rate limiters also answer
  // 429, and those are not attachment-staging pressure.
  if (diagnostics.causes.some((cause) => cause.code === 'UPLOAD_BUDGET_EXHAUSTED')) {
    return 'Too much attachment data is staged in the sandbox at once. Retry shortly.'
  }

  return 'I\'m unable to connect to the sandbox right now. This usually means the sandbox service is not configured or is temporarily unavailable.'
}
