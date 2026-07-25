/**
 * Apply a target's certified context capabilities to the in-process app runtime.
 *
 * Runtime owns authenticated profile retrieval, validation, caching, and prompt
 * composition. This app wrapper adapts that source to `createAgentRuntime`'s
 * `composeProfile` callback. The full capability and profile-diff response
 * remains available through `current()` for consumers that provision more than
 * prompt context.
 */

import {
  type CertifiedProfile,
  type CertifiedProfileSourceOptions,
  createCertifiedProfileSource,
} from '@tangle-network/agent-runtime/intelligence'
import type { ResolvedAgentProfile } from './agent'

/** Configure certified profile delivery for one target. */
export type CertifiedDeliveryConfig = CertifiedProfileSourceOptions

/** Compose app profiles and inspect the latest valid certified profile. */
export interface CertifiedDelivery {
  /** The transform passed to `createAgentRuntime`. */
  composeProfile(base: ResolvedAgentProfile): Promise<ResolvedAgentProfile>
  /** Refresh when the configured interval has elapsed. */
  refresh(): Promise<void>
  /** The latest valid profile, including capabilities and profile diffs. */
  current(): CertifiedProfile | null
}

/**
 * Build profile delivery for one agent target.
 *
 * Retrieval errors preserve the last valid profile. Before the first successful
 * pull, the app runs with its base profile.
 */
export function createCertifiedDelivery(config: CertifiedDeliveryConfig): CertifiedDelivery {
  const source = createCertifiedProfileSource(config)

  return {
    async composeProfile(base) {
      return {
        systemPrompt: await source.compose(base.systemPrompt),
        extraTools: base.extraTools,
      }
    },
    refresh: source.refresh,
    current: source.current,
  }
}
