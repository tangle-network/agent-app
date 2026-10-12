/**
 * Record a person's consent that this app's Sandbox service key may bill them.
 *
 * An app that creates sandboxes under its own service key and names the
 * signed-in person as `billingOwnerId` needs that person's billing delegation
 * grant, or the Sandbox API refuses the create with
 * `BILLING_DELEGATION_GRANT_REQUIRED`. Platform records the grant from the key
 * the person gave the app at sign-in (`POST /v1/keys/billing-delegation-grants`),
 * so the app records it before its first delegated create. The call is
 * idempotent on Platform.
 *
 * A refusal answers a typed code and a message written for the person, so an
 * app can show it as is. Web-standard fetch only.
 */

export interface BillingConsentRefusal {
  status: 402 | 403 | 503
  code: 'billing_consent.payer_not_chargeable' | 'billing_consent.refused' | 'billing_consent.unavailable'
  /** Written for the person whose account would pay. */
  message: string
  /** Platform's own code, for logs. */
  platformCode: string | null
}

export type BillingConsentOutcome =
  | { succeeded: true; value: { created: boolean } }
  | { succeeded: false; error: BillingConsentRefusal }

export interface PlatformBillingConsentOptions {
  /** Platform origin, e.g. `https://id.tangle.tools`. */
  platformUrl: string
  /** This app's Platform service name. */
  serviceName: string
  serviceToken: string | (() => string)
  fetch?: typeof fetch
}

export interface PlatformBillingConsent {
  /**
   * Record that the owner of `payerKey` consents to `serviceKey` billing them
   * for sandboxes. `payerKey` is the key the person gave this app at sign-in;
   * `serviceKey` is the listed key the app creates sandboxes under.
   */
  consent(input: { payerKey: string; serviceKey: string }): Promise<BillingConsentOutcome>
}

const REQUEST_TIMEOUT_MS = 10_000

const notChargeable: BillingConsentRefusal = {
  status: 402,
  code: 'billing_consent.payer_not_chargeable',
  message: 'Your Tangle account has no credit for sandbox use yet. Add credit in your Tangle account, then open the terminal again.',
  platformCode: 'PAYER_NOT_CHARGEABLE',
}

function refusal(status: number | null, platformCode: string | null): BillingConsentRefusal {
  if (platformCode === 'PAYER_NOT_CHARGEABLE') return notChargeable
  if (status === null || status >= 500 || status === 429) {
    return {
      status: 503,
      code: 'billing_consent.unavailable',
      message: 'Tangle could not record your sandbox billing consent right now. Try again in a moment.',
      platformCode,
    }
  }
  return {
    status: 403,
    code: 'billing_consent.refused',
    message: 'Tangle did not accept your sign-in for sandbox billing. Sign out and sign in again.',
    platformCode,
  }
}

interface PlatformBody {
  data?: { id?: unknown; created?: unknown }
  error?: { code?: unknown }
}

export function createPlatformBillingConsent(options: PlatformBillingConsentOptions): PlatformBillingConsent {
  const fetchImpl = options.fetch ?? fetch
  const base = options.platformUrl.replace(/\/+$/, '')
  // Resolved values only: a cancelled request never settles, so a shared
  // in-flight promise would hang every later caller.
  let delegate: { serviceKey: string; keyId: string } | null = null

  async function request(path: string, init: RequestInit): Promise<{ status: number; body: PlatformBody } | null> {
    try {
      const response = await fetchImpl(`${base}${path}`, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      return { status: response.status, body: (await response.json().catch(() => ({}))) as PlatformBody }
    } catch {
      return null
    }
  }

  const codeOf = (body: PlatformBody): string | null => (typeof body.error?.code === 'string' ? body.error.code : null)

  return {
    async consent({ payerKey, serviceKey }) {
      if (delegate?.serviceKey !== serviceKey) {
        const self = await request('/v1/keys/self', { headers: { authorization: `Bearer ${serviceKey}` } })
        const keyId = self?.body.data?.id
        if (!self || self.status !== 200 || typeof keyId !== 'string' || !keyId) {
          return { succeeded: false, error: refusal(self ? Math.max(self.status, 500) : null, self ? codeOf(self.body) : null) }
        }
        delegate = { serviceKey, keyId }
      }
      const token = typeof options.serviceToken === 'function' ? options.serviceToken() : options.serviceToken
      const result = await request('/v1/keys/billing-delegation-grants', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-service-name': options.serviceName,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sourceKey: payerKey, delegateKeyId: delegate.keyId }),
      })
      if (!result) return { succeeded: false, error: refusal(null, null) }
      if (result.status === 200 || result.status === 201) {
        return { succeeded: true, value: { created: result.status === 201 } }
      }
      const platformCode = codeOf(result.body)
      // The service key's own account pays for itself and needs no grant.
      if (platformCode === 'PAYER_IS_DELEGATE_OWNER') return { succeeded: true, value: { created: false } }
      return { succeeded: false, error: refusal(result.status, platformCode) }
    },
  }
}
