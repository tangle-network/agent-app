import type { ReactNode } from 'react'
import { AsyncView, MutationStatus, type AsyncResourceState, type MutationState } from '../web-react/async'

export const panelClass = 'space-y-4 rounded-xl border border-border bg-card p-6 text-foreground'
export const buttonClass = 'inline-flex items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
export const primaryButtonClass = `${buttonClass} border-primary bg-primary text-primary-foreground hover:bg-primary/90`
export const inputClass = 'block w-full rounded-md border border-input bg-background px-3 py-2 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring'

export function ChannelFailure({ state }: { state: MutationState<unknown> }) {
  return state.status === 'failed' ? <MutationStatus state={state} className="text-sm text-destructive" /> : null
}

/** Channel copy around the shared async view, not a second state renderer. */
export function ChannelState<T>({ resource, children, empty }: { resource: AsyncResourceState<T>; children: (value: T) => ReactNode; empty: string }) {
  return <AsyncView state={resource} empty={{ title: empty, action: { label: 'Refresh', onClick: resource.retry } }}
    loadingLabel="Loading channel…" retryLabel="Try again"
    renderIdle={() => <p className="text-sm text-muted-foreground">Choose a channel to continue.</p>}>
    {children}
  </AsyncView>
}
