/** Typed computer-task outcomes shared by prompt observation and the Router tool. */
export type SandboxRunFailureCode = 'sandbox_unavailable' | 'sandbox_failed' | 'sandbox_unconfirmed' | 'sandbox_empty' | 'invalid_arguments'

export class SandboxRunError extends Error {
  constructor(readonly code: SandboxRunFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SandboxRunError'
  }
}
