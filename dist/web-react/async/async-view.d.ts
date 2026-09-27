import { type ReactElement, type ReactNode } from 'react';
import type { AsyncResourceState } from './state';
import type { MutationState } from './use-confirmed-mutation';
export interface AsyncEmptyAction {
    label: string;
    onClick: () => void;
}
export interface AsyncEmptySpec {
    /** What is not there, in the reader's words ("No templates yet"). Required:
     *  an empty state with nothing to say is the state this module exists to
     *  stop being mistaken for a failure. */
    title: string;
    description?: string;
    /** The next action. An element is rendered as supplied (a link, a dialog
     *  trigger); the object form renders the standard button. */
    action?: AsyncEmptyAction | ReactElement;
}
export interface AsyncErrorRenderProps {
    message: string;
    retry: () => void;
}
export interface AsyncViewProps<T> {
    state: AsyncResourceState<T>;
    /** Rendered only for `ready`, with the loaded value — the branch cannot be
     *  entered without one. */
    children: (value: T) => ReactNode;
    /** Required: `empty` must name what is missing and what to do about it. */
    empty: AsyncEmptySpec | ReactElement;
    /** Must return an element. Returning nothing is what produced the blank
     *  screens this component replaces, so a nullish return falls back to the
     *  built-in block rather than rendering nothing. */
    renderLoading?: () => ReactElement;
    renderError?: (props: AsyncErrorRenderProps) => ReactElement;
    /** `idle` renders the loading block by default — from the reader's side,
     *  "not started" and "in flight" are the same wait. */
    renderIdle?: () => ReactElement;
    loadingLabel?: string;
    retryLabel?: string;
    /** Applied to the wrapper around the non-`ready` branches. `ready` renders the
     *  children with no wrapper element, so grids and lists keep their layout. */
    className?: string;
}
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
export declare function AsyncView<T>({ state, children, empty, renderLoading, renderError, renderIdle, loadingLabel, retryLabel, className, }: AsyncViewProps<T>): ReactElement;
export interface MutationStatusLabels {
    pending?: string;
    succeeded?: string;
}
export interface MutationStatusProps<T> {
    state: MutationState<T>;
    labels?: MutationStatusLabels;
    className?: string;
}
/**
 * The write's own status line. "Saved" renders only from `succeeded`, which
 * `useConfirmedMutation` can only reach through a confirmed write, so the label
 * cannot appear over a failed request.
 */
export declare function MutationStatus<T>({ state, labels, className }: MutationStatusProps<T>): ReactElement | null;
