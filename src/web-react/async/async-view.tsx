import { isValidElement, type ReactElement, type ReactNode } from 'react'

import { Button, EmptyState } from '@tangle-network/ui/primitives'

import type { AsyncResourceState } from './state'
import type { MutationState } from './use-confirmed-mutation'

export interface AsyncEmptyAction {
  label: string
  onClick: () => void
}

export interface AsyncEmptySpec {
  /** What is not there, in the reader's words ("No templates yet"). Required:
   *  an empty state with nothing to say is the state this module exists to
   *  stop being mistaken for a failure. */
  title: string
  description?: string
  /** The next action. An element is rendered as supplied (a link, a dialog
   *  trigger); the object form renders the standard button. */
  action?: AsyncEmptyAction | ReactElement
}

export interface AsyncErrorRenderProps {
  message: string
  retry: () => void
}

export interface AsyncViewProps<T> {
  state: AsyncResourceState<T>
  /** Rendered only for `ready`, with the loaded value — the branch cannot be
   *  entered without one. */
  children: (value: T) => ReactNode
  /** Required: `empty` must name what is missing and what to do about it. */
  empty: AsyncEmptySpec | ReactElement
  /** Must return an element. Returning nothing is what produced the blank
   *  screens this component replaces, so a nullish return falls back to the
   *  built-in block rather than rendering nothing. */
  renderLoading?: () => ReactElement
  renderError?: (props: AsyncErrorRenderProps) => ReactElement
  /** `idle` renders the loading block by default — from the reader's side,
   *  "not started" and "in flight" are the same wait. */
  renderIdle?: () => ReactElement
  loadingLabel?: string
  retryLabel?: string
  /** Applied to the wrapper around the non-`ready` branches. `ready` renders the
   *  children with no wrapper element, so grids and lists keep their layout. */
  className?: string
}

const BLOCK_CLASS = 'flex flex-col items-center justify-center gap-2 px-4 py-10 text-center'

/**
 * Renders the branch the state is actually in.
 *
 * The three anti-patterns this replaces (`catch` that only clears a loading
 * flag, early return on a non-ok response, bare `null` while loading) all end at
 * the same rendered output as a successful-but-empty load. Here every branch is
 * reached from a different variant and each renders visibly: `loading` and
 * `idle` render a labelled busy block, `error` renders the message plus the
 * retry, `empty` renders the caller's copy and next action, and `ready` is the
 * only branch with a value to hand to `children`.
 */
export function AsyncView<T>({
  state,
  children,
  empty,
  renderLoading,
  renderError,
  renderIdle,
  loadingLabel = 'Loading…',
  retryLabel = 'Retry',
  className,
}: AsyncViewProps<T>): ReactElement {
  if (state.status === 'ready') return <>{children(state.value)}</>

  // Every `??` here is the guarantee: a custom renderer that returns nothing
  // leaves the reader with the built-in block, never a blank region.
  const branch = (): ReactNode => {
    switch (state.status) {
      case 'idle':
        return renderIdle?.() ?? <LoadingBlock label={loadingLabel} />
      case 'loading':
        return renderLoading?.() ?? <LoadingBlock label={loadingLabel} />
      case 'error':
        return (
          renderError?.({ message: state.message, retry: state.retry }) ?? (
            <ErrorBlock message={state.message} retry={state.retry} retryLabel={retryLabel} />
          )
        )
      case 'empty':
        if (isValidElement(empty)) return empty
        return typeof empty === 'object' && empty !== null && typeof empty.title === 'string' ? (
          <EmptyBlock spec={empty} />
        ) : (
          <EmptyBlock spec={{ title: 'Nothing here yet.' }} />
        )
    }
  }

  // The busy signal lives on the WRAPPER, not inside the loading block, for the
  // same reason every `??` above exists: `renderLoading` is an escape hatch, and
  // a caller filling it with their own spinner would otherwise take the
  // announcement with them — a screen reader would hear nothing for exactly the
  // products that styled their wait state. The wrapper wraps every non-`ready`
  // branch, so it cannot be opted out of.
  //
  // `aria-busy` is emitted in BOTH states rather than only while loading: a
  // region that gains the attribute at the moment it goes busy, and drops it on
  // arrival, gives assistive tech no transition to report. The `error` branch
  // keeps its own `role="alert"` and takes no live region here, because nesting
  // one inside another is what produces a doubled announcement.
  const busy = state.status === 'loading' || state.status === 'idle'
  const failed = state.status === 'error'
  return (
    <div
      data-async-state={state.status}
      className={className}
      role={failed ? undefined : 'status'}
      aria-live={failed ? undefined : 'polite'}
      aria-busy={busy}
    >
      {branch()}
    </div>
  )
}

function LoadingBlock({ label }: { label: string }): ReactElement {
  return (
    <div className={BLOCK_CLASS}>
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  )
}

function ErrorBlock({
  message,
  retry,
  retryLabel,
}: {
  message: string
  retry: () => void
  retryLabel: string
}): ReactElement {
  return (
    <div role="alert" className={BLOCK_CLASS}>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button type="button" variant="outline" size="sm" onClick={retry}>{retryLabel}</Button>
    </div>
  )
}

function EmptyBlock({ spec }: { spec: AsyncEmptySpec }): ReactElement {
  const action = spec.action
  return <EmptyState title={spec.title} description={spec.description} action={
    isValidElement(action) ? action : action ? <Button type="button" variant="outline" size="sm" onClick={(action as AsyncEmptyAction).onClick}>{(action as AsyncEmptyAction).label}</Button> : undefined
  } />
}

export interface MutationStatusLabels {
  pending?: string
  succeeded?: string
}

export interface MutationStatusProps<T> {
  state: MutationState<T>
  labels?: MutationStatusLabels
  className?: string
}

/**
 * The write's own status line. "Saved" renders only from `succeeded`, which
 * `useConfirmedMutation` can only reach through a confirmed write, so the label
 * cannot appear over a failed request.
 */
export function MutationStatus<T>({ state, labels, className }: MutationStatusProps<T>): ReactElement | null {
  if (state.status === 'idle') return null
  if (state.status === 'pending') {
    return (
      <span role="status" aria-live="polite" aria-busy={true} className={className ?? 'text-sm text-muted-foreground'}>
        {labels?.pending ?? 'Saving…'}
      </span>
    )
  }
  if (state.status === 'succeeded') {
    return (
      <span role="status" aria-live="polite" aria-busy={false} className={className ?? 'text-sm text-muted-foreground'}>
        {labels?.succeeded ?? 'Saved'}
      </span>
    )
  }
  return (
    <span role="alert" className={className ?? 'text-sm text-destructive'}>
      {state.message}
    </span>
  )
}
