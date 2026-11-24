import type { AgentProfile } from '@tangle-network/agent-interface'

/** Non-secret execution settings from an authorized connection. The product keeps the
 * connection ID on the execution receipt, outside the reusable AgentProfile. */
export interface ProfileInference {
  harness: NonNullable<AgentProfile['harness']>
  provider: string
  model: string
  credentialSource: 'subscription' | 'api-key' | 'router' | 'managed'
}

/** Apply to a resolved stage. Model limits, permissions, instructions and tools keep
 * their authored values. A one-model connection also owns any small-model calls. */
export function bindProfileInference(profile: AgentProfile, inference: ProfileInference): AgentProfile {
  if (profile.seats?.length) throw new Error('Resolve the profile stage before binding its inference connection.')
  return {
    ...profile,
    harness: inference.harness,
    model: {
      ...profile.model,
      provider: inference.provider,
      default: inference.model,
      ...(profile.model?.small ? { small: inference.model } : {}),
      metadata: { ...profile.model?.metadata, credentialSource: inference.credentialSource },
    },
  }
}
