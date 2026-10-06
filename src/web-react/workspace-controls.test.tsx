// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentSettingsPopover } from './agent-settings-popover'
import { AgentSessionControls } from './agent-session-controls'
import { WorkspaceInitial, WorkspaceSwitcher } from './workspace-switcher'
import { TONE_CLASSES, toneFor } from '@tangle-network/ui/primitives'
import { ModelPicker } from './controls'
import type { CatalogModel } from '../runtime/model-catalog'

const models: CatalogModel[] = [{ id: 'openai/test-model', name: 'Test model', provider: 'openai', contextLength: 1000, supportsTools: true, supportsReasoning: true, featured: true }]
const items = [{ id: 'a', name: 'Alpha team' }, { id: 'b', name: 'Beta team' }]
function Switcher({ onChange = () => {} }: { onChange?: (id: string) => void }) {
  const [value, setValue] = useState('a')
  return <WorkspaceSwitcher value={value} items={items} onChange={(id) => { setValue(id); onChange(id) }} />
}

describe('workspace identity mark', () => {
  it('renders two initials on the categorical tone derived from the name', () => {
    const { container } = render(<WorkspaceInitial name="Acme Holdings" size="lg" />)
    const tile = container.firstElementChild as HTMLElement
    expect(tile.textContent).toBe('AH')
    expect(tile.getAttribute('aria-hidden')).toBe('true')
    for (const cls of TONE_CLASSES[toneFor('Acme Holdings')].surface.split(' ')) expect(tile.className).toContain(cls)
  })
  it('falls back to a question mark for a blank name', () => {
    const { container } = render(<WorkspaceInitial name="   " />)
    expect(container.firstElementChild?.textContent).toBe('?')
  })
})

describe('shared workspace switcher', () => {
  it('opens a named dialog outside clipping hosts and focuses search', () => {
    const { container } = render(<div style={{ overflow: 'hidden' }}><Switcher /></div>)
    const trigger = screen.getByRole('button', { name: 'Switch workspace: Alpha team' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Switch workspace' })
    expect(container.contains(dialog)).toBe(false)
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id)
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search workspaces' }))
  })
  it('filters without changing selection and calls the host only on explicit selection', () => {
    const onChange = vi.fn()
    render(<Switcher onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch workspace: Alpha team' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'beta' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Beta team' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('b')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Switch workspace: Beta team' }))
  })
  it('distinguishes an empty catalog from an unmatched query', () => {
    const { rerender } = render(<WorkspaceSwitcher items={[]} value={null} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('status').textContent).toBe('No workspaces available')
    rerender(<WorkspaceSwitcher items={items} value={null} onChange={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'missing' } })
    expect(screen.getByRole('status').textContent).toContain('No matches')
  })
  it('keeps creation actions and their form under product control', () => {
    const create = vi.fn()
    render(<WorkspaceSwitcher items={[]} value={null} onChange={vi.fn()} footer={<button type="button" onClick={create}>New client</button>} />)
    fireEvent.click(screen.getByRole('button', { name: /Switch workspace/ }))
    fireEvent.click(screen.getByRole('button', { name: 'New client' }))
    expect(create).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
  it('preserves the selected ID when available items change', () => {
    const change = vi.fn()
    const { rerender } = render(<WorkspaceSwitcher items={items} value="a" onChange={change} />)
    rerender(<WorkspaceSwitcher items={[items[1]!]} value="a" onChange={change} />)
    expect(change).not.toHaveBeenCalled()
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('Select workspace')
  })
  it('names a collapsed trigger with the complete workspace name', () => {
    render(<WorkspaceSwitcher items={items} value="a" onChange={vi.fn()} collapsed />)
    expect(screen.getByRole('button', { name: 'Switch workspace: Alpha team' })).toBeTruthy()
  })
  it('Escape dismisses and restores trigger focus', () => {
    render(<Switcher />)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
  it('outside pointer dismissal does not choose a workspace', () => {
    const onChange = vi.fn()
    render(<Switcher onChange={onChange} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('Shift+Tab leaves search beside the trigger rather than the document end', () => {
    render(<Switcher />)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab', shiftKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('shared agent settings', () => {
  it('does not mount interactive children until opened', () => {
    const child = vi.fn()
    function Child() { child(); return <button type="button">Profile</button> }
    render(<AgentSettingsPopover summary="Research agent"><Child /></AgentSettingsPopover>)
    expect(child).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    expect(child).toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Profile' }))
  })
  it('supports a controlled panel and preserves host callback ownership', () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(<AgentSettingsPopover open={false} onOpenChange={onOpenChange}><button type="button">Profile</button></AgentSettingsPopover>)
    fireEvent.click(screen.getByRole('button'))
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<AgentSettingsPopover open onOpenChange={onOpenChange}><button type="button">Profile</button></AgentSettingsPopover>)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
  it('a disabled control cannot retain an open panel', () => {
    const { rerender } = render(<AgentSettingsPopover><button type="button">Profile</button></AgentSettingsPopover>)
    fireEvent.click(screen.getByRole('button'))
    rerender(<AgentSettingsPopover disabled><button type="button">Profile</button></AgentSettingsPopover>)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
  })
  it('closes the nested model picker before its parent settings', () => {
    render(<AgentSettingsPopover><ModelPicker models={models} value={models[0]!.id} onChange={vi.fn()} /></AgentSettingsPopover>)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    const settings = screen.getByRole('dialog', { name: 'Agent settings' })
    const model = within(settings).getByRole('button')
    fireEvent.click(model)
    expect(screen.getAllByRole('dialog')).toHaveLength(2)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(document.activeElement).toBe(model)
    fireEvent.keyDown(model, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('grouped controls retain the complete provided effort ladder and pinned harness', () => {
    const onHarnessChange = vi.fn()
    render(<AgentSessionControls models={models} model={models[0]!.id} onModelChange={vi.fn()} harness="opencode" onHarnessChange={onHarnessChange}
      effort="max" onEffortChange={vi.fn()} effortLevels={[{ id: 'max', label: 'Maximum' }]}
      layout="grouped" harnessLockReason="This conversation is pinned" profileControl={<button type="button">Domain profile</button>} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Agent settings' })
    expect(within(dialog).getByRole('button', { name: 'Domain profile' })).toBeTruthy()
    expect(within(dialog).getByText('Maximum')).toBeTruthy()
    const locked = within(dialog).getByRole('button', { name: /OpenCode/ })
    expect(locked.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(locked)
    expect(onHarnessChange).not.toHaveBeenCalled()
  })
  it('omits unsupported harness and reasoning controls', () => {
    render(<AgentSessionControls models={[{ ...models[0]!, supportsReasoning: false }]} model={models[0]!.id} onModelChange={vi.fn()} harness="opencode" onHarnessChange={vi.fn()} effort="auto" onEffortChange={vi.fn()} layout="grouped" showHarness={false} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.queryByText('Agent backend')).toBeNull()
  })
  it('keeps a narrow panel inside the viewport and SSR does not read browser storage', () => {
    const html = renderToString(<AgentSettingsPopover summary="Long name"><button type="button">Choose</button></AgentSettingsPopover>)
    expect(html).toContain('Agent settings')
    expect(html).not.toContain('role="dialog"')
    render(<AgentSettingsPopover><button type="button">Choose</button></AgentSettingsPopover>)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('dialog').className).toContain('max-w-[calc(100vw-2rem)]')
  })
})
