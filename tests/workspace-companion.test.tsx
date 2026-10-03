// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef, StrictMode, useEffect, useState } from 'react'
import { AgentWorkspaceCompanion, createAgentWorkspaceCompanionTabs, type AgentWorkspaceCompanionHandle, type AgentWorkspaceCompanionTab } from '../src/workspace-react/companion'
import { WorkspaceLayout } from '@tangle-network/sandbox-ui/workspace'

let desktop = true
let listeners: Array<(event: { matches: boolean }) => void> = []
const mounts = vi.fn()
const unmounts = vi.fn()
function Terminal() {
  const [text, setText] = useState('')
  useEffect(() => { mounts(); return () => { unmounts() } }, [])
  return <input aria-label="Terminal input" value={text} onChange={(event) => setText(event.target.value)} />
}
const tabs: AgentWorkspaceCompanionTab[] = [
  { id: 'files', label: 'Files', renderContent: () => <p>File viewer</p> },
  { id: 'terminal', label: 'Terminal', keepMounted: true, renderContent: () => <Terminal /> },
  { id: 'preview', label: 'Preview', renderContent: () => <p>Configured preview</p> },
]
function resize(matches: boolean) {
  act(() => { desktop = matches; listeners.forEach((listener) => listener({ matches })) })
}
beforeEach(() => {
  desktop = true; listeners = []; mounts.mockClear(); unmounts.mockClear(); window.localStorage.clear()
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (query: string) => ({
    matches: desktop, media: query, addEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => listeners.push(listener),
    removeEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => { listeners = listeners.filter((value) => value !== listener) },
    addListener: () => {}, removeListener: () => {},
  }) })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('actual companion and lower layout', () => {
  it('opens tools using the shared panel expander and mounts only visited tabs', async () => {
    const user = userEvent.setup()
    render(<AgentWorkspaceCompanion tabs={tabs}><p>Conversation</p></AgentWorkspaceCompanion>)
    expect(screen.queryByRole('tab')).toBeNull()
    expect(mounts).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Open right panel' }))
    expect(screen.getByText('File viewer')).toBeTruthy()
    expect(mounts).not.toHaveBeenCalled()
    await user.click(screen.getByRole('tab', { name: 'Terminal' }))
    expect(mounts).toHaveBeenCalledTimes(1)
  })

  it('preserves terminal DOM and input across tabs, close/reopen, and mobile transition', async () => {
    const user = userEvent.setup()
    render(<AgentWorkspaceCompanion tabs={tabs} defaultOpen><p>Conversation</p></AgentWorkspaceCompanion>)
    await user.click(screen.getByRole('tab', { name: 'Terminal' }))
    const input = screen.getByRole('textbox', { name: 'Terminal input' })
    await user.type(input, 'retained scrollback')
    await user.click(screen.getByRole('tab', { name: 'Files' }))
    expect(unmounts).not.toHaveBeenCalled()
    await user.click(screen.getByRole('tab', { name: 'Terminal' }))
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(input)
    await user.click(screen.getByRole('button', { name: 'Collapse right panel' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(unmounts).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open right panel' })))
    await user.click(screen.getByRole('button', { name: 'Open right panel' }))
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(input)
    resize(false)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(input)
    resize(true)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(input)
    expect(input.getAttribute('value')).toBe('retained scrollback')
    expect(mounts).toHaveBeenCalledTimes(1)
    expect(unmounts).not.toHaveBeenCalled()
  })

  it('supports keyboard tabs and validates imperative open requests', async () => {
    const user = userEvent.setup()
    const ref = createRef<AgentWorkspaceCompanionHandle>()
    const changed = vi.fn()
    const opened = vi.fn()
    render(<AgentWorkspaceCompanion ref={ref} tabs={tabs} onActiveTabChange={changed} onOpenChange={opened}><p>Chat</p></AgentWorkspaceCompanion>)
    act(() => { expect(ref.current?.openTab('missing')).toBe(false) })
    expect(opened).not.toHaveBeenCalled()
    act(() => { expect(ref.current?.openTab('files')).toBe(true) })
    expect(changed).toHaveBeenCalledWith('files')
    expect(opened).toHaveBeenCalledWith(true)
    screen.getByRole('tab', { name: 'Files' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true')
  })

  it('recovers remembered selection without leaking selection into another workspace', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('first:companion-tab', 'terminal')
    const { rerender } = render(<AgentWorkspaceCompanion tabs={tabs} persistenceKey="first" defaultOpen><p>Chat</p></AgentWorkspaceCompanion>)
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true'))
    rerender(<AgentWorkspaceCompanion tabs={tabs} persistenceKey="second" defaultOpen><p>Chat</p></AgentWorkspaceCompanion>)
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true'))
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(window.localStorage.getItem('second:companion-tab')).toBe('preview')
    expect(window.localStorage.getItem('first:companion-tab')).toBe('terminal')
  })

  it('retains default layout teardown and adds overlay placement only when requested', () => {
    const { rerender } = render(<WorkspaceLayout center={<p>Chat</p>} right={<Terminal />} defaultRightOpen />)
    expect(mounts).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse right panel' }))
    expect(unmounts).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Open right panel' }).parentElement?.parentElement?.className).not.toContain('absolute')
    rerender(<WorkspaceLayout center={<p>Chat</p>} right={<Terminal />} collapsedControlsPlacement="overlay" />)
    expect(screen.getByRole('button', { name: 'Open right panel' }).parentElement?.parentElement?.className).toContain('absolute')
  })
})


it('falls back from removed tabs and remains usable when storage refuses access', async () => {
  const user = userEvent.setup()
  window.localStorage.setItem('stale:companion-tab', 'removed')
  const { unmount } = render(<AgentWorkspaceCompanion tabs={tabs} persistenceKey="stale" defaultOpen><p>Chat</p></AgentWorkspaceCompanion>)
  expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
  unmount()
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked') })
  render(<AgentWorkspaceCompanion tabs={tabs} persistenceKey="blocked" defaultOpen><p>Chat</p></AgentWorkspaceCompanion>)
  await user.click(screen.getByRole('tab', { name: 'Preview' }))
  expect(screen.getByText('Configured preview')).toBeTruthy()
})

it('offers no tool controls or side effects when the app supplies no tabs', () => {
  render(<AgentWorkspaceCompanion tabs={[]}><p>Only conversation</p></AgentWorkspaceCompanion>)
  expect(screen.getByText('Only conversation')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(mounts).not.toHaveBeenCalled()
})

it('restores controlled selection on reload and across workspace namespaces', async () => {
  window.localStorage.setItem('first:companion-tab', 'terminal')
  window.localStorage.setItem('second:companion-tab', 'preview')
  function Controlled({ namespace }: { namespace: string }) {
    const [id, setId] = useState('files')
    return <AgentWorkspaceCompanion tabs={tabs} persistenceKey={namespace} activeTabId={id} onActiveTabChange={setId} defaultOpen><p>Chat</p></AgentWorkspaceCompanion>
  }
  const { rerender, unmount } = render(<Controlled namespace="first" />)
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true'))
  rerender(<Controlled namespace="second" />)
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true'))
  await userEvent.setup().click(screen.getByRole('tab', { name: 'Files' }))
  expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
  expect(window.localStorage.getItem('second:companion-tab')).toBe('files')
  unmount()
  render(<Controlled namespace="first" />)
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true'))
})

it('reports the fallback when a controlled selected tab is removed', async () => {
  const changed = vi.fn()
  function Controlled({ terminalEnabled }: { terminalEnabled: boolean }) {
    const [id, setId] = useState('terminal')
    return <><p role="status">Selected: {id}</p><AgentWorkspaceCompanion tabs={terminalEnabled ? tabs : tabs.filter((tab) => tab.id !== 'terminal')} activeTabId={id} onActiveTabChange={(next) => { changed(next); setId(next) }} defaultOpen><p>Chat</p></AgentWorkspaceCompanion></>
  }
  const { rerender } = render(<Controlled terminalEnabled />)
  expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true')
  rerender(<Controlled terminalEnabled={false} />)
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Selected: files'))
  expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
  expect(changed).toHaveBeenCalledTimes(1)
  expect(changed).toHaveBeenCalledWith('files')
  expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull()
})

it('reports a stale initial controlled selection only once', () => {
  const changed = vi.fn()
  render(<AgentWorkspaceCompanion tabs={tabs} activeTabId="removed" onActiveTabChange={changed} defaultOpen><p>Chat</p></AgentWorkspaceCompanion>)
  expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
  expect(changed).toHaveBeenCalledTimes(1)
  expect(changed).toHaveBeenCalledWith('files')
})

it('restores a valid saved tab before reconciling a stale controlled initial tab', async () => {
  window.localStorage.setItem('stale-controlled:companion-tab', 'terminal')
  const changed = vi.fn()
  function Controlled() {
    const [id, setId] = useState('removed')
    return <AgentWorkspaceCompanion tabs={tabs} persistenceKey="stale-controlled" activeTabId={id} onActiveTabChange={(next) => { changed(next); setId(next) }} defaultOpen><p>Chat</p></AgentWorkspaceCompanion>
  }
  render(<StrictMode><Controlled /></StrictMode>)
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true'))
  expect(changed).toHaveBeenCalledTimes(1)
  expect(changed).toHaveBeenCalledWith('terminal')
})


describe('shared companion defaults', () => {
  it('starts in Files, orders supported tools and retains visited terminal state', async () => {
    const user = userEvent.setup()
    render(<AgentWorkspaceCompanion defaultOpen tools={{
      preview: () => <p>Preview content</p>,
      terminal: () => <Terminal />,
      files: () => <p>Workspace files</p>,
    }}><p>Chat</p></AgentWorkspaceCompanion>)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Files', 'Terminal', 'Preview'])
    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
    expect(mounts).not.toHaveBeenCalled()
    await user.click(screen.getByRole('tab', { name: 'Terminal' }))
    const input = screen.getByRole('textbox', { name: 'Terminal input' })
    await user.type(input, 'keep my terminal')
    await user.click(screen.getByRole('tab', { name: 'Files' }))
    await user.click(screen.getByRole('tab', { name: 'Terminal' }))
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(input)
    expect(input.getAttribute('value')).toBe('keep my terminal')
    expect(unmounts).not.toHaveBeenCalled()
  })

  it('exposes the same preset to custom tab compositions', () => {
    const renderAgent = vi.fn(() => <p>Agent settings</p>)
    const preset = createAgentWorkspaceCompanionTabs({ agent: renderAgent, files: () => <p>Files</p> })
    expect(renderAgent).not.toHaveBeenCalled()
    render(<AgentWorkspaceCompanion tabs={[...preset, { id: 'custom', label: 'Reports', renderContent: () => <p>Report</p> }]} defaultOpen><p>Chat</p></AgentWorkspaceCompanion>)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Files', 'Agent', 'Reports'])
    expect(renderAgent).not.toHaveBeenCalled()
  })

  it('keeps session navigation functional when no companion tools are available', async () => {
    const user = userEvent.setup()
    function NavigationOnly() {
      const [open, setOpen] = useState(true)
      return <AgentWorkspaceCompanion tools={{}} navigation={{ content: <nav aria-label="Session history">Saved conversation</nav>, open, onOpenChange: setOpen }} keyboardShortcuts><p>Conversation</p></AgentWorkspaceCompanion>
    }
    render(<NavigationOnly />)
    expect(screen.getByRole('navigation', { name: 'Session history' })).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open right panel' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Collapse left panel' }))
    expect(screen.queryByRole('navigation')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open left panel' }))
    expect(screen.getByRole('navigation', { name: 'Session history' })).toBeTruthy()
    await user.keyboard('{Control>}b{/Control}')
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('shows one mobile drawer with both session navigation and companion tools', async () => {
    const user = userEvent.setup()
    render(<AgentWorkspaceCompanion defaultOpen navigation={{ content: <nav aria-label="Session history">Saved conversation</nav> }} tools={{ files: () => <p>Browse workspace</p> }}><p>Conversation</p></AgentWorkspaceCompanion>)
    resize(false)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog').textContent).toContain('Browse workspace')
    await user.keyboard('{Escape}')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog').textContent).toContain('Saved conversation')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Conversation')).toBeTruthy()
  })

})
