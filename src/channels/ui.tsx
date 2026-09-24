import type { ReactNode } from 'react'
import type { AsyncResourceState, MutationState } from '../web-react/async'

export const panelClass = 'space-y-4 rounded-xl border border-border bg-card p-6 text-foreground'
export const buttonClass = 'inline-flex items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
export const inputClass = 'block w-full rounded-md border border-border bg-background px-3 py-2 text-foreground'

export function ChannelFailure({ state }: { state: MutationState<unknown> }) {
  return state.status === 'failed' ? <p role="alert" className="text-sm text-destructive">{state.message}</p> : null
}

export function ChannelState<T>({ resource, children, empty }: { resource: AsyncResourceState<T>; children: (value: T) => ReactNode; empty: string }) {
  switch (resource.status) {
    case 'idle': return <p className="text-sm text-muted-foreground">Choose a channel to continue.</p>
    case 'loading': return <p role="status" className="text-sm text-muted-foreground">Loading channel…</p>
    case 'error': return <div role="alert"><p>{resource.message}</p><button type="button" className={buttonClass} onClick={resource.retry}>Try again</button></div>
    case 'empty': return <div><p>{empty}</p><button type="button" className={buttonClass} onClick={resource.retry}>Refresh</button></div>
    case 'ready': return <>{children(resource.value)}</>
  }
}
