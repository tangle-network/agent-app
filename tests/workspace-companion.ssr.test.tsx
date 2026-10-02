// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { AgentWorkspaceCompanion } from '../src/workspace-react/companion'
it('renders the conversation on the server without storage or tool initialization', () => {
  const initialize = vi.fn(() => <p>Terminal</p>)
  const html = renderToString(<AgentWorkspaceCompanion tabs={[{ id: 'terminal', label: 'Terminal', renderContent: initialize }]} persistenceKey="workspace"><p>Server conversation</p></AgentWorkspaceCompanion>)
  expect(html).toContain('Server conversation')
  expect(html).toContain('Open right panel')
  expect(initialize).not.toHaveBeenCalled()
})
