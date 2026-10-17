/**
 * Typed outcomes for a settings write. A settings API answers a refusal with
 * `{ error: { code, message, field?, retryAfterSeconds? } }`; this reads that
 * body into a rejection whose message is the server's sentence, so the row
 * shows "Only the owner can turn sources on" instead of "Request failed (403)".
 * A request that never reached the server is the `network` code.
 */

import { confirmWrite, rejectWrite, type MutationOutcome, type MutationRejected } from '../web-react/async'

/** The refusal codes settings routes share. A product may send others; they keep the server's message. */
export type SettingFailureCode = 'forbidden' | 'invalid' | 'plan_limit' | 'rate_limited' | 'not_runnable' | 'upstream' | 'network'

export interface SettingFailure {
  code: SettingFailureCode | (string & {})
  /** The sentence the row shows. */
  message: string
  /** The field an `invalid` refusal names. */
  field?: string
  /** When a `rate_limited` refusal can be tried again. */
  retryAfterSeconds?: number
}

const FALLBACK: Record<SettingFailureCode, string> = {
  forbidden: "You don't have permission to change this.",
  invalid: "That value can't be saved. Check it and try again.",
  plan_limit: "Your plan doesn't include this.",
  rate_limited: "You've reached the limit for now. Try again shortly.",
  not_runnable: "This can't run right now.",
  upstream: "A connected service didn't respond. Nothing changed; try again.",
  network: "Couldn't reach the server. Check your connection, then retry.",
}

function codeForStatus(status: number): SettingFailureCode {
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 402) return 'plan_limit'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 409 || status === 422) return 'invalid'
  return 'upstream'
}

function retryWording(seconds: number): string {
  if (seconds < 90) return `Try again in ${Math.max(1, Math.round(seconds))} seconds.`
  return `Try again in ${Math.round(seconds / 60)} minutes.`
}

function readFailure(body: unknown, status: number): SettingFailure {
  const raw = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  const error = typeof raw === 'string' ? { message: raw } : typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const code = typeof error.code === 'string' && error.code ? error.code : codeForStatus(status)
  const retryAfterSeconds = typeof error.retryAfterSeconds === 'number' ? error.retryAfterSeconds : undefined
  const given = typeof error.message === 'string' && error.message.trim() ? error.message.trim() : null
  let message = given ?? FALLBACK[code as SettingFailureCode] ?? FALLBACK.upstream
  if (retryAfterSeconds !== undefined && code === 'rate_limited' && !given) message = `You've reached the limit for now. ${retryWording(retryAfterSeconds)}`
  return {
    code,
    message,
    ...(typeof error.field === 'string' ? { field: error.field } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  }
}

/**
 * Confirms a settings write from its response, or rejects it with the
 * server's typed failure. Pass the `fetch` promise itself so a request that
 * never reached the server becomes a `network` failure rather than a throw.
 * `parse` returns the value the server kept: read it from the 2xx body when
 * the route answers with the saved record, or return the value sent
 * (`() => next`) when it answers `{ success: true }` or 204. Without `parse`
 * the value is the body, typed `unknown`, so it cannot stand in for a field's
 * value.
 */
export function confirmSettingResponse(request: Response | Promise<Response>): Promise<MutationOutcome<unknown>>
export function confirmSettingResponse<T>(request: Response | Promise<Response>, parse: (data: unknown) => T): Promise<MutationOutcome<T>>
export async function confirmSettingResponse<T>(
  request: Response | Promise<Response>,
  parse?: (data: unknown) => T,
): Promise<MutationOutcome<unknown>> {
  let response: Response
  try {
    response = await request
  } catch (error) {
    return rejectWrite(FALLBACK.network, { code: 'network', message: FALLBACK.network, cause: error } satisfies SettingFailure & { cause: unknown })
  }
  const text = await response.text().catch(() => '')
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const failure = readFailure(body, response.status)
    return rejectWrite(failure.message, failure)
  }
  try {
    return confirmWrite(parse ? parse(body) : body)
  } catch (error) {
    return rejectWrite('The server answered, but not with the saved value. Reload to see what was kept.', error)
  }
}

/** The typed failure behind a rejected settings write (or a mutation's `failed` state), when it carries one. */
export function settingFailure(outcome: Pick<MutationRejected, 'message' | 'error'>): SettingFailure {
  const error = outcome.error as Partial<SettingFailure> | undefined
  return typeof error === 'object' && error !== null && typeof error.code === 'string'
    ? { ...error, code: error.code, message: outcome.message }
    : { code: 'upstream', message: outcome.message }
}
