export interface ChatFundingFailure {
  code?: string
  message?: string
}

/** Presentation only. The host supplies its authenticated billing destination. */
export interface ChatFundingRecovery {
  reason: 'insufficient_credits' | 'paid_access_required'
  title: string
  message: string
  actionLabel: string
  /** Retrying the same request cannot repair a funding prerequisite. */
  retryable: false
}

/**
 * Recognize a paid-access refusal across HTTP and SDK-wrapped chat failures.
 * Structured codes take precedence; the message fallback covers older sandbox
 * transports that preserve the provider's words but replace its error code.
 * This does not infer funding from a generic HTTP status or authorize a run.
 */
export function getChatFundingRecovery(
  failure: ChatFundingFailure | string | null | undefined,
): ChatFundingRecovery | null {
  const code = typeof failure === 'object' && failure ? failure.code : undefined
  const message = typeof failure === 'string' ? failure : failure?.message ?? ''
  let reason: ChatFundingRecovery['reason'] | undefined
  if (code === 'insufficient_credits') reason = 'insufficient_credits'
  else if (code === 'paid_access_required' || code === 'funding_required') reason = 'paid_access_required'
  else if (/\binsufficient credits\b/i.test(message)) reason = 'insufficient_credits'
  else if (/\binference requires verified paid access\b/i.test(message)) reason = 'paid_access_required'
  if (!reason) return null
  return {
    reason,
    title: reason === 'insufficient_credits' ? 'Insufficient credits' : 'Paid access required',
    message: reason === 'insufficient_credits'
      ? 'Open billing to add funds before trying again.'
      : 'Open billing to check your funded balance or paid seat before trying again.',
    actionLabel: 'Open billing',
    retryable: false,
  }
}
