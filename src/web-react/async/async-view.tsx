import { isValidElement, type ReactElement, type ReactNode } from 'react'

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

  return (
    <div data-async-state={state.status} className={className}>
      {branch()}
    </div>
  )
}

function LoadingBlock({ label }: { label: string }): ReactElement {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={BLOCK_CLASS}>
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-transparent"
        aria-hidden="true"
      />
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
      <button
        type="button"
        onClick={retry}
        className="h-8 rounded-md border border-border px-3 text-xs font-medium text-foreground transition hover:bg-accent/30"
      >
        {retryLabel}
      </button>
    </div>
  )
}

function EmptyBlock({ spec }: { spec: AsyncEmptySpec }): ReactElement {
  return (
    <div className={BLOCK_CLASS}>
      <p className="text-sm font-medium text-foreground">{spec.title}</p>
      {spec.description ? <p className="max-w-md text-sm text-muted-foreground">{spec.description}</p> : null}
      {spec.action ? (
        isValidElement(spec.action) ? (
          spec.action
        ) : (
          <button
            type="button"
            onClick={(spec.action as AsyncEmptyAction).onClick}
            className="h-8 rounded-md border border-border px-3 text-xs font-medium text-foreground transition hover:bg-accent/30"
          >
            {(spec.action as AsyncEmptyAction).label}
          </button>
        )
      ) : null}
    </div>
  )
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
      <span role="status" aria-live="polite" className={className ?? 'text-xs text-muted-foreground'}>
        {labels?.pending ?? 'Saving…'}
      </span>
    )
  }
  if (state.status === 'succeeded') {
    return (
      <span role="status" aria-live="polite" className={className ?? 'text-xs text-muted-foreground'}>
        {labels?.succeeded ?? 'Saved'}
      </span>
    )
  }
  return (
    <span role="alert" className={className ?? 'text-xs text-destructive'}>
      {state.message}
    </span>
  )
}
