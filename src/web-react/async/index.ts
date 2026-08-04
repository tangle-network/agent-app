/**
 * `web-react/async` — the three-state fetch primitive.
 *
 * A failed load, an empty result and a load in flight are three different
 * things, and every product that hand-rolled them collapsed the first two: a
 * network failure rendered as "No templates available", an empty member list or
 * a blank conversation, with no message and no retry. The write half collapsed
 * the same way in the other direction — a save button reading "Saved" over a
 * 404, because a resolved promise was read as a landed write.
 *
 * Adoption, with the before/after for each shape:
 * [`docs/async-state-module.md`](../../../docs/async-state-module.md).
 */

export {
  AsyncRequestError,
  DEFAULT_ASYNC_ERROR_MESSAGE,
  asyncErrorMessage,
  defaultIsEmpty,
  readOkJson,
  requireOk,
  resolveAsyncValue,
  type AsyncResolution,
  type AsyncResourceState,
  type AsyncResourceStatus,
  type AsyncRetryable,
} from './state'

export { useAsyncResource, type AsyncLoadContext, type UseAsyncResourceOptions } from './use-async-resource'

export {
  CONFIRMED_WRITE,
  confirmJson,
  confirmResponse,
  confirmWrite,
  isConfirmedWrite,
  rejectWrite,
  useConfirmedMutation,
  type ConfirmedMutation,
  type MutationConfirmed,
  type MutationOutcome,
  type MutationRejected,
  type MutationState,
  type UseConfirmedMutationOptions,
} from './use-confirmed-mutation'

export {
  AsyncView,
  MutationStatus,
  type AsyncEmptyAction,
  type AsyncEmptySpec,
  type AsyncErrorRenderProps,
  type AsyncViewProps,
  type MutationStatusLabels,
  type MutationStatusProps,
} from './async-view'
