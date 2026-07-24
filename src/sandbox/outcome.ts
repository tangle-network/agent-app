// Shared Outcome triple for the sandbox modules. Lives in a dependency-free
// leaf so both index.ts and terminal-proxy-token.ts import it instead of
// re-declaring the type (index.ts re-exports * from terminal-proxy-token, so
// the token module cannot import from index without a cycle).
/** Represent success or failure of an operation with corresponding value or error information */
export type Outcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: Error }

export const ok = <T>(value: T): Outcome<T> => ({ succeeded: true, value })
export const fail = (error: unknown): Outcome<never> => ({
  succeeded: false,
  error: error instanceof Error ? error : new Error(String(error)),
})
