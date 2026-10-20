

// Sentinel cause for a client-side per-exec timeout (a hung/wedged proxy exec).
// Carried as the `.cause` of the fail-loud Outcome so callers see the wedged
// command instead of an opaque infinite hang.
export class ProfileWriteExecTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`exec exceeded ${timeoutMs}ms (proxy hang/wedge)`)
    this.name = 'ProfileWriteExecTimeoutError'
  }
}

const TRANSIENT_EXEC_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504])

const TRANSIENT_EXEC_CODE_RE = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ECONNABORTED)$/i

const TRANSIENT_EXEC_MESSAGE_RE =
  /\b(408|409|425|429|500|502|503|504)\b|rate.?limit|too many requests|\bfetch failed\b|network error|connection reset|socket hang up|timed? out|service unavailable|bad gateway|gateway timeout|internal server error|\b(?:sidecar|runtime|exec(?:ution)?|terminal|sandbox|service|command(?:s)?|proxy)\b.{0,80}\bnot ready\b|\bnot ready\b.{0,80}\b(?:sidecar|runtime|exec(?:ution)?|terminal|sandbox|service|command(?:s)?|proxy)\b/i

function errorStatus(err: { status?: unknown; statusCode?: unknown; response?: unknown }): number | undefined {
  const rawStatus = err.status ?? err.statusCode ?? (
    err.response && typeof err.response === 'object'
      ? (err.response as { status?: unknown }).status
      : undefined
  )
  if (typeof rawStatus === 'number') return rawStatus
  if (typeof rawStatus === 'string' && /^\d+$/.test(rawStatus)) return Number(rawStatus)
  return undefined
}

function retryAfterMs(err: unknown, seen = new Set<object>()): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  if (seen.has(err)) return undefined
  seen.add(err)
  const e = err as { retryAfterMs?: unknown; cause?: unknown }
  if (typeof e.retryAfterMs === 'number') return e.retryAfterMs
  return retryAfterMs(e.cause, seen)
}

function isTransientExecError(err: unknown, seen = new Set<object>()): boolean {
  if (!err || typeof err !== 'object') return false
  if (seen.has(err)) return false
  seen.add(err)
  const e = err as {
    status?: unknown
    statusCode?: unknown
    response?: unknown
    code?: unknown
    message?: unknown
    cause?: unknown
  }
  const status = errorStatus(e)
  if (status !== undefined && TRANSIENT_EXEC_STATUS_CODES.has(status)) return true
  if (typeof e.code === 'string') {
    if (TRANSIENT_EXEC_CODE_RE.test(e.code)) return true
    if (/rate.?limit|too.?many.?requests|429|server.?error|service.?unavailable/i.test(e.code)) return true
  }
  if (typeof e.message === 'string' && TRANSIENT_EXEC_MESSAGE_RE.test(e.message)) return true
  return isTransientExecError(e.cause, seen)
}

export function isRuntimeExecAuthError(err: unknown, seen = new Set<object>()): boolean {
  if (!err || typeof err !== 'object') return false
  if (seen.has(err)) return false
  seen.add(err)
  const e = err as {
    status?: unknown
    statusCode?: unknown
    response?: unknown
    code?: unknown
    name?: unknown
    message?: unknown
    cause?: unknown
  }
  if (errorStatus(e) === 401) return true
  if (
    typeof e.code === 'string' &&
    /^(AUTH_ERROR|AUTHENTICATION_ERROR|UNAUTHORIZED|UNAUTHENTICATED|ERR_UNAUTHORIZED|ERR_UNAUTHENTICATED|401)$/i.test(e.code)
  ) {
    return true
  }
  if (
    typeof e.name === 'string' &&
    /^(AuthError|AuthenticationError|UnauthorizedError|UnauthenticatedError|SandboxAuthError)$/i.test(e.name)
  ) {
    return true
  }
  return isRuntimeExecAuthError(e.cause, seen)
}

export function isRuntimeAuthRefreshDenied(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  return (
    isRuntimeExecAuthError(err) ||
    errorStatus(err as { status?: unknown; statusCode?: unknown; response?: unknown }) === 403
  )
}

// Classify an exec failure as transient-retryable. Retryable shapes share the
// same backoff path: rate-limit (HTTP 429 + retryAfterMs), client-side timeout,
// and transient sidecar/transport/readiness failures surfaced as SandboxError-
// shaped objects, fetch errors, network resets, or 5xx-ish messages. Everything
// else fails loud. Non-zero shell exits never reach this classifier.
export function transientExecError(err: unknown): { retryable: boolean; retryAfterMs?: number } {
  if (err instanceof ProfileWriteExecTimeoutError) return { retryable: true }
  if (isTransientExecError(err)) return { retryable: true, retryAfterMs: retryAfterMs(err) }
  return { retryable: false }
}
