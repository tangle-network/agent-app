/**
 * Application profile composition using Runtime's certified-guidance source.
 *
 * The shell adapts the prompt source to the application's resolved profile;
 * Runtime owns pulling, cache lifetime, concurrent refresh and retained guidance.
 * Only prompt-compatible guidance is folded here. Tool definitions, execution
 * permissions, MCP servers and files are not installed from certified material.
 * The complete profile remains available through `current()` for inspection and
 * the product's separately authorized materialization path.
 */
import {
  createCertifiedPromptSource,
  type CertifiedProfile,
  type CertifiedPromptSourceOptions,
} from '@tangle-network/agent-runtime/intelligence'
import type { ResolvedAgentProfile } from './agent'

/** Pull coordinates, refresh cadence and timeout owned by the shared source. */
export type CertifiedDeliveryConfig = CertifiedPromptSourceOptions

/** Adapt certified prompt guidance without granting execution authority. */
export interface CertifiedDelivery {
  /** Refresh on the source's cadence and compose the current prompt guidance.
   * Other resolved profile fields pass through unchanged. */
  composeProfile(base: ResolvedAgentProfile): Promise<ResolvedAgentProfile>
  /** Force a pull now, coalescing with an in-flight pull. Best-effort; not a
   * post-activation revision barrier or a permission-revocation protocol. */
  refresh(): Promise<void>
  /** Last successfully pulled profile, or null before a successful pull. */
  current(): CertifiedProfile | null
}

export function createCertifiedDelivery(config: CertifiedDeliveryConfig): CertifiedDelivery {
  const source = createCertifiedPromptSource(config)
  return {
    async composeProfile(base) {
      return { ...base, systemPrompt: await source.compose(base.systemPrompt) }
    },
    refresh: () => source.refresh({ force: true }),
    current: source.current,
  }
}
