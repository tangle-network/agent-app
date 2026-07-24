import {
  INTERACTION_SUBMIT_TIMEOUT_MESSAGE,
  INTERACTION_SUBMIT_TIMEOUT_MS,
  responseErrorMessage,
  type InteractionAnswerSubmission,
  type InteractionAnswerSubmitterOptions,
  type SubmitInteractionAnswer,
} from './interaction-card-support'

/** Manage storage and retrieval of interaction attempt keys by interaction and submission identifiers */
export interface InteractionAttemptStore {
  get(interactionId: string, submissionSignature: string): string | null
  set(interactionId: string, submissionSignature: string, attemptKey: string): void
  delete(interactionId: string, submissionSignature: string): void
}

function attemptStorageKey(namespace: string, interactionId: string): string {
  return `${namespace}:${encodeURIComponent(interactionId)}`
}

function storedAttempts(storage: Pick<Storage, 'getItem'>, key: string): Record<string, string> {
  try {
    const value = JSON.parse(storage.getItem(key) ?? '{}') as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, string>
      : {}
  } catch {
    return {}
  }
}

/** Create a session-based store to manage interaction attempts using provided storage and optional namespace */
export function createSessionInteractionAttemptStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  namespace = 'agent-app:interaction-attempt',
): InteractionAttemptStore {
  return {
    get(id, signature) {
      return storedAttempts(storage, attemptStorageKey(namespace, id))[signature] ?? null
    },
    set(id, signature, attemptKey) {
      const key = attemptStorageKey(namespace, id)
      storage.setItem(key, JSON.stringify({ ...storedAttempts(storage, key), [signature]: attemptKey }))
    },
    delete(id, signature) {
      const key = attemptStorageKey(namespace, id)
      const attempts = storedAttempts(storage, key)
      delete attempts[signature]
      if (Object.keys(attempts).length === 0) storage.removeItem(key)
      else storage.setItem(key, JSON.stringify(attempts))
    },
  }
}

/** Create an in-memory store to manage interaction attempts keyed by ID and signature */
export function createMemoryInteractionAttemptStore(): InteractionAttemptStore {
  const attempts = new Map<string, string>()
  const key = (id: string, signature: string) => `${id}\u0000${signature}`
  return {
    get: (id, signature) => attempts.get(key(id, signature)) ?? null,
    set: (id, signature, attemptKey) => attempts.set(key(id, signature), attemptKey),
    delete: (id, signature) => { attempts.delete(key(id, signature)) },
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stableValue(nested)]))
}

/** Generate a stable string signature from an interaction answer submission */
export function interactionSubmissionSignature(submission: InteractionAnswerSubmission): string {
  return JSON.stringify(stableValue(submission))
}

/** Define options for submitting durable interaction answers with attempt tracking and optional key creation */
export interface DurableInteractionAnswerSubmitterOptions extends InteractionAnswerSubmitterOptions {
  attempts: InteractionAttemptStore
  createAttemptKey?: () => string
}

function defaultAttemptKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Answer submitter for a durable interaction route. One opaque attempt key is
 * retained for an ambiguous transport/5xx result and reused after reload. A
 * changed answer has a different signature and therefore a new attempt. */
export function createDurableInteractionAnswerSubmitter(
  options: DurableInteractionAnswerSubmitterOptions,
): SubmitInteractionAnswer {
  const timeoutMs = options.timeoutMs ?? INTERACTION_SUBMIT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  return async (submission) => {
    const signature = interactionSubmissionSignature(submission)
    let attemptKey: string
    try {
      attemptKey = options.attempts.get(submission.id, signature) ?? ''
      if (!attemptKey) {
        attemptKey = (options.createAttemptKey ?? defaultAttemptKey)()
        options.attempts.set(submission.id, signature, attemptKey)
      }
    } catch (cause) {
      return {
        ok: false,
        expired: false,
        message: cause instanceof Error ? cause.message : 'Failed to submit the answer',
      }
    }
    const url = typeof options.url === 'function' ? options.url(submission) : options.url
    const extra = typeof options.body === 'function' ? options.body(submission) : options.body ?? {}
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(INTERACTION_SUBMIT_TIMEOUT_MESSAGE), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          ...extra,
          id: submission.id,
          outcome: submission.outcome,
          attemptKey,
          ...(submission.data ? { data: submission.data } : {}),
        }),
      })
      if (response.ok) {
        options.attempts.delete(submission.id, signature)
        return { ok: true }
      }
      const failure = await responseErrorMessage(response)
      if (response.status < 500) options.attempts.delete(submission.id, signature)
      return { ok: false, expired: response.status === 410, message: failure.message }
    } catch (cause) {
      if (controller.signal.aborted) {
        return { ok: false, expired: false, message: INTERACTION_SUBMIT_TIMEOUT_MESSAGE }
      }
      return {
        ok: false,
        expired: false,
        message: cause instanceof Error ? cause.message : 'Failed to submit the answer',
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
