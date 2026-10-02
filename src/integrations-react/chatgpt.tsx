'use client'

import { useId } from 'react'
import { Button, Input } from '@tangle-network/ui/primitives'
import { cn, focusRing } from '@tangle-network/ui/utils'
import { CHATGPT_PACKAGE_URL, CHATGPT_PLUGINS_URL, CHATGPT_SETUP_URL, chatGPTView } from './chatgpt-state.js'
import type { ConnectToChatGPTProps } from './chatgpt-types.js'

/**
 * Mount in the app's existing integration settings. Navigation and instructions
 * only: the host owns registration evidence, enrollment, OAuth, and refresh.
 */
export function ConnectToChatGPT(props: ConnectToChatGPTProps) {
  const id = useId()
  const view = chatGPTView(props)
  const failed = view.status === 'error' || view.status === 'unavailable'
  const registered = view.status === 'registered' || view.status === 'connected'
  const scope = JSON.stringify([props.endpoint, props.enrollment?.enrollmentId, props.enrollment?.agentId,
    props.enrollment?.workspaceId, props.enrollment?.threadId, view.status])
  const external = { target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' } as const

  return <section
    aria-labelledby={`${id}-app ${id}-title`}
    aria-busy={view.status === 'checking' || undefined}
    data-chatgpt-state={view.status}
    className={cn('min-w-0 rounded-xl border border-border bg-card p-5 text-foreground sm:p-6', props.className)}
  >
    <header className="min-w-0">
      <p id={`${id}-app`} className="mb-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{props.app?.name}</p>
      <h2 id={`${id}-title`} className="text-xl font-semibold tracking-tight">Connect to ChatGPT</h2>
    </header>
    <div className="mt-4 space-y-2" role={failed ? 'alert' : 'status'} aria-atomic="true">
      <p className={cn('text-sm font-medium', failed ? 'text-destructive' : 'text-foreground')}>{view.label}</p>
      <p id={`${id}-description`} className="text-sm leading-relaxed text-muted-foreground">{view.description}</p>
    </div>
    <div className="mt-5">
      {view.action ? <Button asChild size="lg" className="h-auto min-h-11 w-full whitespace-normal text-center sm:w-auto">
        <a href={CHATGPT_PLUGINS_URL} {...external} aria-describedby={`${id}-description ${id}-new-tab`}>
          {view.action}<span aria-hidden="true">↗</span>
        </a>
      </Button> : <Button type="button" size="lg" disabled className="w-full sm:w-auto">
        {view.status === 'checking' ? 'Checking connection…' : 'Setup unavailable'}
      </Button>}
      <p id={`${id}-new-tab`} className="mt-2 text-xs text-muted-foreground">Links open in a new tab. Opening ChatGPT does not connect automatically.</p>
    </div>
    <details key={scope} className="mt-5 min-w-0 border-t border-border pt-3">
      <summary className={cn('min-h-11 cursor-pointer rounded-lg py-3 text-sm font-medium', focusRing)}>
        {registered ? 'Connection details' : 'Setup instructions'}
      </summary>
      <div className="min-w-0 space-y-4 pb-1 text-sm leading-relaxed text-muted-foreground">
        {registered ? <p>Open Plugins in ChatGPT and select the existing connection. Keep using the same app account and selected agent; review any permission changes in the existing consent flow.</p> : view.status !== 'unavailable' ? <ol className="list-decimal space-y-2 pl-5">
          <li>In ChatGPT Plugins, look for this app before creating another connection.</li>
          <li>When registration is needed, enable Developer mode in Settings → Security and login. In Plugins, choose the plus button and enter this app’s name and exact MCP endpoint. Account or workspace policy may require an administrator.</li>
          <li>Sign in through the app’s existing consent flow and review the requested permissions. Select the connection from the tools menu in a new ChatGPT conversation.</li>
        </ol> : null}
        {view.endpoint ? <div className="min-w-0 space-y-1">
          <label htmlFor={`${id}-endpoint`} className="block font-medium text-foreground">MCP endpoint</label>
          <Input id={`${id}-endpoint`} readOnly value={view.endpoint}
            onFocus={event => event.currentTarget.select()}
            className="min-h-11 w-full min-w-0 font-mono text-xs" />
          <p className="text-xs">Select to copy. No credentials are included.</p>
        </div> : null}
        {view.connectionId ? <p className="min-w-0">Registered ID: <code className="[overflow-wrap:anywhere]">{view.connectionId}</code></p> : null}
        <p>Generated package files do not connect or publish an app. For a complete plugin, use the developer’s reviewed package and the supported local marketplace installation flow.</p>
        <p className="flex flex-wrap gap-x-4 gap-y-2">
          <a href={CHATGPT_SETUP_URL} {...external} className={cn('rounded underline underline-offset-4', focusRing)}>OpenAI setup guide<span className="sr-only"> (opens in a new tab)</span></a>
          <a href={CHATGPT_PACKAGE_URL} {...external} className={cn('rounded underline underline-offset-4', focusRing)}>Package installation guide<span className="sr-only"> (opens in a new tab)</span></a>
        </p>
      </div>
    </details>
  </section>
}
