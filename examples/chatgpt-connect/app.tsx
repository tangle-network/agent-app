import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatGPTConnect, type ChatGPTConnectionState, type ChatGPTConnectProps } from '@tangle-network/agent-app/chatgpt-react'
import { BrandHeader } from '@tangle-network/agent-app/brand'
import '@tangle-network/agent-app/styles'
import '@tangle-network/agent-app/chatgpt-react/styles'
import configs from './config.json'

const params = new URLSearchParams(location.search)
const app = params.get('app') === 'creative' ? configs.creative : configs.gtm
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.dataset.theme = theme
document.documentElement.classList.toggle('dark', theme === 'dark')
const states: Record<string, ChatGPTConnectionState> = {
  setup: { status: 'not-connected' }, checking: { status: 'checking' }, connected: { status: 'connected' },
  error: { status: 'error', message: 'The connection could not be checked. Try again.' },
}

function Example() {
  const [state, setState] = useState(states[params.get('state') ?? 'setup'] ?? states.setup!)
  const [checks, setChecks] = useState(0)
  const props: ChatGPTConnectProps = { ...app, state }
  // A fixture destination tests rendering only. It is not a published or installed app.
  if (params.has('registeredFixture')) props.registeredConnection = { id: 'test-record-id', url: 'https://chatgpt.com/plugins' }
  return <>
    <BrandHeader title={app.app.displayName} />
    <main>
      <p className="example-label">Installed package example · fixture data</p>
      <h1>Bring your work into ChatGPT</h1>
      <p className="example-intro">One shared connection surface, configured by your app.</p>
      <ChatGPTConnect {...props} onCheck={() => {
        setState({ status: 'checking' })
        window.setTimeout(() => { setChecks(value => value + 1); setState({ status: 'not-connected' }) }, 650)
      }} />
      <p className="example-note">This example has no live connection probe. Checks exercised: <span data-checks>{checks}</span>.</p>
    </main>
  </>
}
createRoot(document.getElementById('root')!).render(<Example />)
