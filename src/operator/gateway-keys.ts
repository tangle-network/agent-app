/**
 * The operator key store for an app whose own API keys live in the agent
 * gateway's key store, plus Platform agent keys when the deployment can verify
 * them. The app supplies the gateway calls (`verifyApiKeyFromStore` and the
 * store's `claimRequest`) and its identity loader; this owns the mapping, the
 * refusal of spending-capped keys on native routes, the rate-limit retry
 * window, and one Platform verifier per deployment configuration.
 */
import { createPlatformAgentKeyVerifier, type PlatformAgentKeyVerifier } from '../platform/agent-keys.js'
import type { RequestApiKey } from '../platform/api-key-auth.js'
import {
  withPlatformAgentKeys,
  type PlatformAgentKeyAccess,
  type PlatformAgentKeyContext,
  type PlatformAgentOperatorKey,
} from './platform-agent-keys.js'
import type { OperatorKeyStore } from './server.js'

/** An app key as the gateway's `verifyApiKeyFromStore` returns it. */
export interface GatewayVerifiedApiKey {
  keyId: string
  ownerId: string
  scopes: string[]
  key: { expiresAt?: Date | null }
  spendingLimitCents: number | null
}

/** The gateway key store's answer to counting one request. */
export interface GatewayRequestClaim {
  allowed: boolean
  reason?: string
  minuteResetAt: number
  dailyResetAt: number
}

/** An app key admitted to the operator API. */
export type GatewayOperatorKey = RequestApiKey & { spendingLimitCents: number | null }

export interface GatewayOperatorKeysOptions<Identity> {
  /** This app's Platform product id, e.g. `legal-agent`. */
  product: string
  /** Verify an Authorization header against the app's gateway key store. */
  verify(authorization: string): Promise<GatewayVerifiedApiKey | null>
  /** Count one request against the key's gateway limits. */
  claimRequest(keyId: string, requestId: string): Promise<GatewayRequestClaim>
  /** Load the key owner; `context` is present for a Platform agent key. */
  loadIdentity(userId: string, context?: PlatformAgentKeyContext): Promise<Identity | null>
  /**
   * Platform agent keys are accepted only when both the Platform URL and the
   * service token are configured; otherwise only the app's keys are.
   */
  platform: {
    url: string | undefined
    serviceToken: string | undefined
    accounts: PlatformAgentKeyAccess<Identity>['accounts']
  }
}

let sharedVerifier: { config: string; verifier: PlatformAgentKeyVerifier } | null = null

/** One verifier per deployment configuration, so its short cache spans requests. */
function platformAgentKeyVerifier(platformUrl: string, serviceToken: string, product: string): PlatformAgentKeyVerifier {
  const config = `${platformUrl}\n${serviceToken}\n${product}`
  if (sharedVerifier?.config !== config) {
    sharedVerifier = {
      config,
      verifier: createPlatformAgentKeyVerifier({ platformUrl, serviceName: product, serviceToken, product }),
    }
  }
  return sharedVerifier.verifier
}

export function createGatewayOperatorKeys<Identity>(
  options: GatewayOperatorKeysOptions<Identity>,
): OperatorKeyStore<GatewayOperatorKey | PlatformAgentOperatorKey, Identity> {
  const appKeys: OperatorKeyStore<GatewayOperatorKey, Identity> = {
    async verify(authorization) {
      const verified = await options.verify(authorization)
      return verified ? {
        keyId: verified.keyId,
        ownerId: verified.ownerId,
        scopes: verified.scopes,
        expiresAt: verified.key.expiresAt?.getTime() ?? 0,
        spendingLimitCents: verified.spendingLimitCents,
      } : null
    },
    async resolveIdentity(key) {
      // Native routes use owner billing; capped keys stay on the gateway's reservation path.
      if (key.spendingLimitCents !== null) {
        throw Response.json({
          error: 'Capped keys must use the paid agent gateway; private APIs use owner billing',
          code: 'api_key.native_cap_unsupported',
        }, { status: 403 })
      }
      return options.loadIdentity(key.ownerId)
    },
    async claimRequest(key, requestId) {
      const result = await options.claimRequest(key.keyId, requestId)
      const resetAt = result.reason === 'daily' ? result.dailyResetAt : result.minuteResetAt
      return { allowed: result.allowed, retryAfterSeconds: Math.max(1, (resetAt - Date.now()) / 1000) }
    },
  }
  const platformUrl = options.platform.url?.trim()
  const serviceToken = options.platform.serviceToken?.trim()
  if (!platformUrl || !serviceToken) return appKeys
  return withPlatformAgentKeys(appKeys, {
    verifier: platformAgentKeyVerifier(platformUrl, serviceToken, options.product),
    product: options.product,
    accounts: options.platform.accounts,
    loadIdentity: options.loadIdentity,
  })
}
