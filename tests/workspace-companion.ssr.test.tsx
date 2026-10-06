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

it('keeps the right-panel expander beside the conversation instead of floating over it', () => {
  const html = renderToString(<AgentWorkspaceCompanion tabs={[{ id: 'files', label: 'Files', renderContent: () => <p>Files</p> }]}><p>Server conversation</p></AgentWorkspaceCompanion>)
  const expander = html.slice(0, html.indexOf('aria-label="Open right panel"'))
  const column = expander.slice(expander.lastIndexOf('<div class="'))
  expect(column).toContain('shrink-0')
  expect(column).not.toContain('absolute')
})
