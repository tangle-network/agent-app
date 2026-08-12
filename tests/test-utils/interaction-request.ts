/**
 * Builds a schema-valid `InteractionRequest` for tests.
 *
 * A request carries a `binding` (the exact run/session/execution coordinates
 * the ask belongs to) and a `requestDigest` over that material. Both are
 * required, and `InteractionRequestSchema` refuses a request missing either —
 * which is what a producer or a card would see as "malformed", not as a
 * validation warning. Tests that hand-wrote request literals therefore all
 * need the same two fields, so the rule lives here once: callers pass the
 * fields their assertion is about, and the digest is derived rather than
 * hard-coded, so it stays correct when those fields change.
 */

import {
  interactionRequestDigest,
  type InteractionRequest,
  type InteractionRequestBinding,
  type InteractionRequestMaterial,
} from '@tangle-network/agent-interface'

type RequestOverrides = Partial<Omit<InteractionRequestMaterial, 'binding'>> & {
  binding?: Partial<InteractionRequestBinding>
}

/** Coordinates every fixture shares unless a test overrides one. */
function interactionBinding(
  interactionId: string,
  overrides: Partial<InteractionRequestBinding> = {},
): InteractionRequestBinding {
  return {
    runId: 'run-1',
    provider: 'test-provider',
    environmentId: 'env-1',
    sessionId: 'session-1',
    executionId: 'exec-1',
    interactionId,
    ...overrides,
  }
}

/** A valid request: supplied fields over question-shaped defaults, digest derived. */
export function buildInteractionRequest(overrides: RequestOverrides = {}): InteractionRequest {
  const { binding: bindingOverrides, id: idOverride, ...rest } = overrides
  const id = idOverride ?? 'ask-1'
  const material: InteractionRequestMaterial = {
    kind: 'question',
    title: 'Need input',
    answerSpec: { fields: [] },
    ...rest,
    id,
    binding: interactionBinding(id, bindingOverrides),
  }
  return { ...material, requestDigest: interactionRequestDigest(material) }
}
