/** Public TEST data. The private CONFIRM reply is never returned to a browser. */
export interface ApplicationSenderVerificationStart {
  lineId: string
  testId: string
  state: 'awaiting_test'
  testText: string
  expiresAt: string
}

/** Browser-safe status from the owner server. No sender address is present. */
export interface ApplicationSenderVerification {
  lineId: string
  testId: string
  state: 'awaiting_test' | 'sending' | 'challenge_sent' | 'verified'
    | 'consumed' | 'cancelled' | 'superseded' | 'failed' | 'expired'
  expiresAt: string
  proof: {
    signedInboundTestAt: string | null
    providerReplyAcknowledgedAt: string | null
    signedInboundConfirmAt: string | null
  }
}

/** The owner-key SDK read includes the confirmed sender for the attach helper. */
export interface OwnerApplicationSenderVerification extends ApplicationSenderVerification {
  approvedSender?: string
}

/** Use at the host response boundary so approvedSender cannot enter page state. */
export function publicApplicationSenderVerification(
  result: OwnerApplicationSenderVerification,
): ApplicationSenderVerification {
  return {
    lineId: result.lineId,
    testId: result.testId,
    state: result.state,
    expiresAt: result.expiresAt,
    proof: {
      signedInboundTestAt: result.proof.signedInboundTestAt,
      providerReplyAcknowledgedAt: result.proof.providerReplyAcknowledgedAt,
      signedInboundConfirmAt: result.proof.signedInboundConfirmAt,
    },
  }
}
