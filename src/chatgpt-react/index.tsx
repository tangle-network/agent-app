import { useId, useState } from 'react'
import { Button, Input } from '@tangle-network/ui/primitives'
import type { AgentEnrollmentIdentity } from '../agent-enrollment/index'

/** The public display fields from chatgpt-agents-kit's AgentAppDescription. */
export interface ChatGPTAppMetadata {
  name: string
  displayName: string
  description: string
}

/** Supplied by the host from a real registered ChatGPT connection. Never derived from an endpoint. */
export interface ChatGPTRegisteredConnection {
  id: string
  url: string
}

/** Only the host can confirm connection state for its current authenticated user. */
export type ChatGPTConnectionState =
  | { status: 'not-connected' }
  | { status: 'checking' }
  | { status: 'connected' }
  | { status: 'error'; message: string }

export interface ChatGPTConnectProps {
  app: ChatGPTAppMetadata
  /** Public MCP resource URL advertised by the app's existing kit endpoint. */
  endpoint: string
  /** Existing authorized native enrollment; this component never provisions one. */
  enrollment: AgentEnrollmentIdentity
  registeredConnection?: ChatGPTRegisteredConnection
  state: ChatGPTConnectionState
  /** Host refreshes state through its existing authenticated route. No check is inferred from opening a link. */
  onCheck?: () => void
  className?: string
}

const pluginsUrl = 'https://chatgpt.com/plugins'
const guideUrl = 'https://developers.openai.com/plugins/deploy/connect-chatgpt'

function publicUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) return url
  } catch { /* Configuration errors render a recoverable setup message below. */ }
  return undefined
}

/** Browser-only presentation: no enrollment, OAuth, connection discovery or local persistence. */
export function ChatGPTConnect(props: ChatGPTConnectProps) {
  const { enrollment, app, endpoint, registeredConnection } = props
  // A workspace/agent/endpoint switch must not retain the previous setup or clipboard notice.
  const key = JSON.stringify([enrollment.enrollmentId, enrollment.agentId, enrollment.workspaceId,
    enrollment.threadId, app.name, endpoint, registeredConnection?.id, registeredConnection?.url])
  return <ConnectSurface key={key} {...props} />
}

function ConnectSurface({ app, endpoint, enrollment, registeredConnection, state, onCheck, className }: ChatGPTConnectProps) {
  const id = useId()
  const [showSetup, setShowSetup] = useState(false)
  const [copyNotice, setCopyNotice] = useState('')
  const resource = publicUrl(endpoint)
  const registeredUrl = registeredConnection?.id.trim() ? publicUrl(registeredConnection.url) : undefined
  const connectionUrl = registeredUrl?.hostname === 'chatgpt.com' && !registeredUrl.port ? registeredUrl.href : undefined
  const checking = state.status === 'checking'
  const connected = state.status === 'connected'
  const status = checking ? 'Checking connection…' : connected ? 'Connected to ChatGPT'
    : state.status === 'error' ? state.message : 'Ready to connect'

  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpoint)
      setCopyNotice('MCP URL copied')
    } catch {
      setCopyNotice('Select the MCP URL and copy it manually.')
    }
  }

  return <section className={`tangle-chatgpt ${className ?? ''}`} aria-labelledby={`${id}-heading`}>
    <div className="tangle-chatgpt__heading">
      <div>
        <span className="tangle-chatgpt__eyebrow">{app.displayName}</span>
        <h2 id={`${id}-heading`}>Your agent, in ChatGPT</h2>
      </div>
      <span className="tangle-chatgpt__badge">ChatGPT</span>
    </div>
    <p className="tangle-chatgpt__description">{app.description}</p>
    <dl className="tangle-chatgpt__identity">
      <div><dt>Agent</dt><dd>{enrollment.agentId}</dd></div>
      <div><dt>Workspace</dt><dd>{enrollment.workspaceId}</dd></div>
    </dl>
    <p role={state.status === 'error' ? 'alert' : 'status'} aria-busy={checking} className="tangle-chatgpt__status">{status}</p>
    <div className="tangle-chatgpt__actions">
      {connectionUrl || connected ? <Button asChild className="tangle-chatgpt__primary">
        <a href={connectionUrl ?? pluginsUrl} target="_blank" rel="noopener noreferrer">
          {connected ? 'Open in ChatGPT' : 'Connect to ChatGPT'}{' '}<span className="tangle-chatgpt__sr-only">(opens a new tab)</span>
        </a>
      </Button> : <Button type="button" className="tangle-chatgpt__primary" disabled={checking || !resource}
        aria-expanded={showSetup} aria-controls={`${id}-setup`} onClick={() => setShowSetup(!showSetup)}>
        Connect to ChatGPT
      </Button>}
      {onCheck && <Button type="button" variant="outline" className="tangle-chatgpt__secondary" disabled={checking}
        onClick={onCheck}>{checking ? 'Checking…' : 'Check connection'}</Button>}
    </div>
    {!resource && <p role="alert">A public HTTPS MCP URL without credentials, query parameters or a fragment is required. Contact your app administrator.</p>}
    {resource && (connectionUrl || connected) && <button type="button" className="tangle-chatgpt__text-action"
      aria-expanded={showSetup} aria-controls={`${id}-setup`} onClick={() => setShowSetup(!showSetup)}>Connection setup</button>}
    {resource && showSetup && <div id={`${id}-setup`} className="tangle-chatgpt__setup">
      <h3>Set up {app.displayName}</h3>
      <ol>
        <li>In ChatGPT settings, open <strong>Security and login</strong> and enable <strong>Developer mode</strong>. Availability depends on your account and workspace.</li>
        <li>Open <a href={pluginsUrl} target="_blank" rel="noopener noreferrer">ChatGPT Plugins (new tab)</a>, select the plus button, and enter this app’s name, description and MCP URL.</li>
        <li>Complete the sign-in and review the available tools. Start a new chat and select the connection from the tools menu.</li>
      </ol>
      <label htmlFor={`${id}-url`}>MCP URL</label>
      <div className="tangle-chatgpt__endpoint">
        <Input id={`${id}-url`} readOnly value={endpoint} onFocus={event => event.currentTarget.select()} />
        <Button type="button" variant="outline" className="tangle-chatgpt__secondary" onClick={() => { void copyEndpoint() }}>Copy URL</Button>
      </div>
      <p role="status" className="tangle-chatgpt__copy-notice">{copyNotice}</p>
      <p>Sign in with the account you use for this workspace.</p>
      <a href={guideUrl} target="_blank" rel="noopener noreferrer">OpenAI setup guide (new tab)</a>
    </div>}
  </section>
}
