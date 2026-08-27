/** Define error codes representing possible Durable Chat failure scenarios */
export type DurableChatErrorCode =
  | 'DURABLE_CHAT_BAD_REQUEST'
  | 'DURABLE_CHAT_UNAUTHORIZED'
  | 'DURABLE_CHAT_CONFLICT'
  | 'DURABLE_CHAT_UNAVAILABLE'
  | 'DURABLE_CHAT_GONE'
  | 'DURABLE_CHAT_NOT_FOUND'

/** Typed, fail-loud errors for adapters and route seams. */
export class DurableChatError extends Error {
  readonly code: DurableChatErrorCode
  readonly status: number
  readonly details?: unknown

  constructor(code: DurableChatErrorCode, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'DurableChatError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** Represent conflict errors occurring in durable chat state management */
export class DurableChatConflictError extends DurableChatError {
  constructor(message = 'durable chat state conflict', details?: unknown) {
    super('DURABLE_CHAT_CONFLICT', message, 409, details)
    this.name = 'DurableChatConflictError'
  }
}

/** Represent unavailable durable chat authority errors with status code 503 */
export class DurableChatUnavailableError extends DurableChatError {
  constructor(message = 'durable chat authority unavailable', details?: unknown) {
    super('DURABLE_CHAT_UNAVAILABLE', message, 503, details)
    this.name = 'DurableChatUnavailableError'
  }
}

/** Represent durable chat errors indicating the chat plan is no longer available */
export class DurableChatGoneError extends DurableChatError {
  constructor(message = 'durable chat plan is gone', details?: unknown) {
    super('DURABLE_CHAT_GONE', message, 410, details)
    this.name = 'DurableChatGoneError'
  }
}
