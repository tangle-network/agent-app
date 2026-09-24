import {
  interactionRequestDigest,
  type InteractionRequest,
  type InteractionRequestMaterial,
} from '@tangle-network/agent-interface'

/** Build a complete interaction fixture through Interface's canonical digest path. */
export function interactionRequestFixture(
  request: Omit<InteractionRequestMaterial, 'binding'>,
): InteractionRequest {
  const material: InteractionRequestMaterial = {
    ...request,
    binding: {
      runId: `run-${request.id}`,
      provider: 'test-provider',
      environmentId: 'test-environment',
      sessionId: 'test-session',
      executionId: `execution-${request.id}`,
      interactionId: request.id,
    },
  }
  return { ...material, requestDigest: interactionRequestDigest(material) }
}
