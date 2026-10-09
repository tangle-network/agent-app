/**
 * Let the operator API accept a Platform agent key next to the app's own keys.
 *
 * `withPlatformAgentKeys` wraps the app's existing `OperatorKeyStore`: a
 * Bearer key starting `sk-tan-` is verified at Platform for this app's
 * product (see `platform/agent-keys.ts`); every other key goes to the app's
 * own store unchanged, so existing `gak_` keys keep working.
 *
 * Authority for a Platform agent key:
 * - Which actions: only the key's `<product>:operator:read|write|run` scopes
 *   (or `*`), mapped to `operator:read|write|run`. A key without any is
 *   refused, so a key approved for other products cannot reach this API.
 * - Which user: the key owner's Tangle identity (stable Platform user id and
 *   verified email), resolved through the app's own `TangleSsoAccountStore`,
 *   the same account policy browser SSO applies. A first call creates the app
 *   user and its Tangle link exactly as a first browser sign-in would; an
 *   ambiguous or conflicting identity is refused. Nothing in the request names
 *   the user.
 * - Which workspaces: the app's ordinary roles, through the operator
 *   adapter's `authorizeWorkspace`. The key confers no workspace access.
 */
import {
  agentOperatorScopes,
  PLATFORM_KEY_PREFIX,
  type PlatformAgentKeyVerifier,
} from '../platform/agent-keys'
import type { RequestApiKey } from '../platform/api-key-auth'
import type { TangleSsoAccountStore } from '../platform/sso'
import type { OperatorKeyStore } from './server'

const OPERATOR_ACTIONS = ['read', 'write', 'run'] as const

export interface PlatformAgentKeyAccess<Identity> {
  verifier: PlatformAgentKeyVerifier
  /** This app's Platform product id, e.g. `gtm-agent`. */
  product: string
  /**
   * The app's browser-SSO account store. It must keep the Platform link per
   * user (a link-table store): the link is saved with no session.
   */
  accounts: Pick<TangleSsoAccountStore, 'resolveAccount' | 'upsertUserByEmail' | 'saveTangleLink'>
  /** Load the operator identity for an app user id. */
  loadIdentity(userId: string): Promise<Identity | null>
  /** Optional per-key request quota; by default every verified request is admitted. */
  claimRequest?(keyId: string, requestId: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }>
}

/** An operator key that came from Platform agent signup. */
export interface PlatformAgentOperatorKey extends RequestApiKey {
  source: 'platform-agent'
}

function refused(status: number, code: string, error: string): Response {
  return Response.json({ error, code }, { status, headers: { 'cache-control': 'private, no-store' } })
}

function isPlatformAgentKey(key: RequestApiKey): key is PlatformAgentOperatorKey {
  return (key as Partial<PlatformAgentOperatorKey>).source === 'platform-agent'
}

export function withPlatformAgentKeys<Key extends RequestApiKey, Identity>(
  appKeys: OperatorKeyStore<Key, Identity>,
  access: PlatformAgentKeyAccess<Identity>,
): OperatorKeyStore<Key | PlatformAgentOperatorKey, Identity> {
  async function provisionOwner(verified: { platformUserId: string; email: string; name: string | null }, rawKey: string): Promise<string> {
    const resolution = await access.accounts.resolveAccount({ email: verified.email, platformUserId: verified.platformUserId })
    if (resolution.kind === 'reject') {
      throw refused(403, 'agent_key.account_conflict', `The key owner's Tangle identity conflicts with an account in this app (${resolution.reason}).`)
    }
    // A user already linked to this Platform identity is used as it is: its
    // profile and link belong to the owner's own sign-ins.
    if (resolution.kind === 'existing' && resolution.matchedBy === 'platform-id') return resolution.userId
    // A new or email-matched user is created and linked now, the way a first
    // browser sign-in would; the agent key is the Platform credential this app
    // then acts with, so its spend counts against the key's one cap.
    const { userId } = await access.accounts.upsertUserByEmail({
      email: verified.email,
      name: verified.name,
      tangleUserId: verified.platformUserId,
      resolution,
    })
    await access.accounts.saveTangleLink({
      userId,
      sessionToken: '',
      tangleUserId: verified.platformUserId,
      email: verified.email,
      name: verified.name,
      apiKey: rawKey,
      planTier: null,
    })
    return userId
  }

  return {
    async verify(authorization) {
      const raw = /^Bearer +(\S+)$/i.exec(authorization)?.[1]
      if (!raw?.startsWith(PLATFORM_KEY_PREFIX)) return appKeys.verify(authorization)
      const verified = await access.verifier.verify(raw)
      if (!verified.ok) throw refused(verified.status, verified.code, verified.message)
      const scopes = agentOperatorScopes(verified.scopes, access.product, OPERATOR_ACTIONS)
      if (scopes.length === 0) {
        throw refused(403, 'agent_key.product_not_granted', "The key's owner did not approve it for this app.")
      }
      const ownerId = await provisionOwner(verified, raw)
      return {
        keyId: verified.keyId,
        ownerId,
        scopes,
        // The operator API requires a finite expiry. This one bounds the
        // request being authorized; the next request asks Platform again once
        // the verifier's short cache lapses.
        expiresAt: Math.max(verified.validUntil, Date.now() + 30_000),
        source: 'platform-agent',
      }
    },
    async resolveIdentity(key) {
      return isPlatformAgentKey(key) ? access.loadIdentity(key.ownerId) : appKeys.resolveIdentity(key as Key)
    },
    async claimRequest(key, requestId) {
      if (!isPlatformAgentKey(key)) return appKeys.claimRequest(key as Key, requestId)
      return access.claimRequest ? access.claimRequest(key.keyId, requestId) : { allowed: true }
    },
  }
}
