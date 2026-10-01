import type { ApplicationIntelligence } from '../runtime/application-intelligence'
import type {
  ChatTurnLifecycle,
  ChatTurnLifecycleComplete,
  ChatTurnLifecycleError,
} from './turn-routes'

/** Adapt the existing terminal hooks, including gated turns, without observing a second stream. */
export function createApplicationIntelligenceLifecycle<TContext>(
  intelligence: Pick<ApplicationIntelligence, 'recordObservation'>,
): ChatTurnLifecycle<TContext> {
  const record = (
    info: ChatTurnLifecycleComplete<TContext> | ChatTurnLifecycleError<TContext>,
  ): Promise<void> => {
    const complete = 'usage' in info ? info : undefined
    return intelligence.recordObservation({
      runId: info.executionId,
      model: complete?.requestedModel,
      labels: {
        'tangle.observation.kind': 'chat-lifecycle',
        'tangle.sessionId': info.identity.sessionId,
        'tangle.userId': info.identity.userId,
        'tangle.tenantId': info.identity.tenantId,
        'tangle.turnStreamId': info.turnStreamId,
        'tangle.execution.state': complete ? (complete.gated ? 'not-executed' : 'completed') : 'failed',
        'tangle.duration_ms': info.durationMs,
        'tangle.cost.scope': 'reported-inference',
        ...(complete?.assistantMessageId ? { 'tangle.assistantMessageId': complete.assistantMessageId } : {}),
        ...(complete?.servedModel ? { 'gen_ai.response.model': complete.servedModel } : {}),
        ...(complete?.servedProvider ? { 'gen_ai.response.provider': complete.servedProvider } : {}),
      },
    }, complete && !complete.gated ? complete.usage.costUsd : undefined)
  }
  return { onTurnComplete: record, onTurnError: record }
}
