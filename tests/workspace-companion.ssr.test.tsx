// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { AgentWorkspaceCompanion } from '../src/workspace-react/companion'
it('renders the conversation on the server without storage or tool initialization', () => {
  const initialize = vi.fn(() => <p>Terminal</p>)
  const html = renderToString(<AgentWorkspaceCompanion tabs={[{ id: 'terminal', label: 'Terminal', renderContent: initialize }]} persistenceKey="workspace"><p>Server conversation</p></AgentWorkspaceCompanion>)
  expect(html).toContain('Server conversation')
  expect(html).toContain('Open workspace tools')
  expect(initialize).not.toHaveBeenCalled()
})

it('puts the tools toggle flat inside the conversation header, not in an edge column or a float', () => {
  const html = renderToString(<AgentWorkspaceCompanion header={<span>Launch plan</span>} tabs={[{ id: 'files', label: 'Files', renderContent: () => <p>Files</p> }, { id: 'agent', label: 'Agent', renderContent: () => <p>Agent</p> }]}><p>Server conversation</p></AgentWorkspaceCompanion>)
  const header = html.slice(html.indexOf('data-workspace-header="center"'), html.indexOf('data-companion-center'))
  expect(header).toContain('Launch plan')
  expect(header).toContain('aria-label="Open workspace tools"')
  expect(html.indexOf('data-workspace-surface')).toBeLessThan(html.indexOf('data-workspace-header="center"'))
  expect(html).not.toContain('data-workspace-pane="right"')
  const toggle = header.slice(header.lastIndexOf('<button', header.indexOf('aria-label="Open workspace tools"')), header.indexOf('</button>'))
  for (const cls of ['absolute', 'shadow-sm', 'bg-card']) expect(toggle.split('"').join(' ').split(' ')).not.toContain(cls)
})

it('bounds the conversation to the pane height so its own list scrolls and the composer stays on screen', () => {
  const html = renderToString(<AgentWorkspaceCompanion tabs={[{ id: 'files', label: 'Files', renderContent: () => <p>Files</p> }]}><section className="flex flex-1 flex-col">Server conversation</section></AgentWorkspaceCompanion>)
  const before = html.slice(0, html.indexOf('<section'))
  const wrapper = before.slice(before.lastIndexOf('<div'))
  expect(wrapper).toContain('data-companion-center')
  for (const cls of ['grid', 'h-full', 'min-h-0', 'grid-rows-[minmax(0,1fr)]']) expect(wrapper.split('"').join(' ').split(' ')).toContain(cls)
})
