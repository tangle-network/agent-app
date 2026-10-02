// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ModelPicker, type ModelPickerProps } from '../../src/web-react/controls'
import type { CatalogModel } from '../../src/runtime/model-catalog'

const models: CatalogModel[] = [
  { id: 'openai/first', name: 'First model', provider: 'openai', featured: true,
    supportsTools: true, supportsReasoning: true, description: 'Long-context coding' },
  { id: 'openai/second', name: 'Second model', provider: 'openai', featured: true,
    supportsTools: false, supportsReasoning: false },
  { id: 'anthropic/older', name: 'Older model', provider: 'anthropic', featured: false,
    supportsTools: true, supportsReasoning: true },
]
const defaults: ModelPickerProps = { value: 'private/saved', models, onChange: () => {} }
const search = () => screen.getByRole('textbox', { name: 'Search all models' })
const panel = () => screen.getByRole('dialog', { name: 'Choose a model' })
function open() {
  const trigger = screen.getAllByRole('button')[0]!
  fireEvent.click(trigger)
  return trigger
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ModelPicker catalogue and controlled-value contract', () => {
  it('distinguishes loading, unavailable, empty and no search matches, even with a retained query', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ModelPicker {...defaults} models={[]} loading error="Offline" onChange={onChange} />)
    open()
    expect(screen.getByRole('status').textContent).toBe('Loading models...')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(search(), { target: { value: 'missing' } })
    rerender(<ModelPicker {...defaults} models={[]} error="Offline" onChange={onChange} />)
    expect(screen.getByRole('alert').textContent).toContain('Model catalogue unavailable')
    expect(screen.getByRole('alert').textContent).toContain('Offline')
    expect(screen.queryByRole('status')).toBeNull()
    rerender(<ModelPicker {...defaults} models={[]} onChange={onChange} />)
    expect(screen.getByRole('status').textContent).toBe('No models available')
    rerender(<ModelPicker {...defaults} onChange={onChange} />)
    expect(screen.getByRole('status').textContent).toBe('No models match your search')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not offer stale catalogue rows on failure, including an empty failure message', () => {
    render(<ModelPicker {...defaults} error="" />)
    open()
    expect(screen.getByRole('alert').textContent).toContain('The catalogue could not be loaded.')
    expect(within(panel()).queryByRole('button', { name: /First model/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('leaves retry outcomes to the host and keeps focus through failure → loading → ready', () => {
    const onChange = vi.fn()
    const onRetry = vi.fn()
    const { rerender } = render(<ModelPicker {...defaults} error="Try again" onRetry={onRetry} onChange={onChange} />)
    open()
    const retry = screen.getByRole('button', { name: 'Retry' })
    retry.focus()
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledExactlyOnceWith()
    expect(document.activeElement).toBe(search())
    // Calling back is not evidence the request succeeded.
    expect(screen.getByRole('alert').textContent).toContain('Try again')
    rerender(<ModelPicker {...defaults} loading error="Try again" onRetry={onRetry} onChange={onChange} />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(document.activeElement).toBe(search())
    rerender(<ModelPicker {...defaults} onRetry={onRetry} onChange={onChange} />)
    expect(within(panel()).getByText('private/saved').textContent).toBe('private/saved')
    expect(document.activeElement).toBe(search())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('never rewrites, normalizes or fabricates a selectable row for an absent saved id', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ModelPicker {...defaults} onChange={onChange} />)
    const trigger = open()
    expect(trigger.textContent).toContain('private/saved')
    expect(within(panel()).getByText('private/saved')).toBeTruthy()
    expect(within(panel()).queryByRole('button', { name: /private\/saved/ })).toBeNull()
    rerender(<ModelPicker {...defaults} models={[]} loading onChange={onChange} />)
    rerender(<ModelPicker {...defaults} models={[]} error="Unavailable" onChange={onChange} />)
    rerender(<ModelPicker {...defaults} value="sonnet" onChange={onChange} />)
    expect(trigger.textContent).toContain('sonnet')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('announces an older selected model without substituting the featured default', () => {
    render(<ModelPicker {...defaults} value="anthropic/older" />)
    open()
    const selected = within(panel()).getByRole('button', { name: 'Older model' })
    expect(selected.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Browse all models' }))
    expect(within(panel()).getAllByRole('button', { name: 'Older model' })).toHaveLength(1)
  })

  it('filters by provider, id and description, and keeps priority rows unique', () => {
    render(<ModelPicker {...defaults} priorityGroup={{ label: 'Pinned', match: m => m.id === 'openai/first' }} />)
    open()
    expect(within(panel()).getAllByRole('button', { name: /First model/ })).toHaveLength(1)
    for (const query of ['OPENAI/FIRST', 'Long-context', '  openai  ']) {
      fireEvent.change(search(), { target: { value: query } })
      expect(within(panel()).getByRole('button', { name: /First model/ })).toBeTruthy()
    }
  })
})

describe('ModelPicker keyboard and trigger composition', () => {
  it.each(['chip', 'quiet'] as const)('selects once and restores focus for %s triggers', variant => {
    const onChange = vi.fn()
    render(<ModelPicker {...defaults} variant={variant} onChange={onChange} />)
    const trigger = open()
    fireEvent.click(within(panel()).getByRole('button', { name: 'First model' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('openai/first')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('opens with arrows, moves through native buttons, and restores focus on Escape', () => {
    const onChange = vi.fn()
    render(<ModelPicker {...defaults} onChange={onChange} />)
    const trigger = screen.getByRole('button')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(search())
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    const first = within(panel()).getByRole('button', { name: 'First model' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Browse all models' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(search())
    fireEvent.keyDown(search(), { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not intercept IME, modifier or input Home/End editing keys', () => {
    render(<ModelPicker {...defaults} />)
    open()
    const input = search()
    for (const init of [{ key: 'ArrowDown', isComposing: true }, { key: 'ArrowDown', ctrlKey: true }, { key: 'Home' }, { key: 'End' }]) {
      expect(fireEvent.keyDown(input, init)).toBe(true)
      expect(document.activeElement).toBe(input)
    }
  })

  it('returns Shift+Tab to the trigger and clears a dismissed search on reopen', () => {
    render(<ModelPicker {...defaults} />)
    const trigger = open()
    fireEvent.change(search(), { target: { value: 'unmatched' } })
    fireEvent.keyDown(search(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(trigger)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    expect((search() as HTMLInputElement).value).toBe('')
  })

  it('uses native disabled behavior, also when disabled while open', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ModelPicker {...defaults} onChange={onChange} disabled />)
    const trigger = screen.getByRole('button') as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<ModelPicker {...defaults} onChange={onChange} />)
    fireEvent.click(trigger)
    expect(panel()).toBeTruthy()
    rerender(<ModelPicker {...defaults} onChange={onChange} disabled />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('attaches form associations to the actual compact Search trigger and describes its retained value', () => {
    render(<>
      <label id="model-label" htmlFor="model-picker">Default model</label>
      <p id="model-help">Applies to new tasks.</p>
      <ModelPicker {...defaults} id="model-picker" aria-labelledby="model-label" aria-describedby="model-help"
        variant="quiet" triggerContent={<span>Search</span>} />
    </>)
    const trigger = screen.getByRole('button', { name: 'Default model' })
    expect(trigger.id).toBe('model-picker')
    expect(trigger.textContent).toBe('Search')
    const descriptions = trigger.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)!.textContent)
    expect(descriptions).toEqual(['Applies to new tasks.', 'Selected model: private/saved'])
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toBe(panel())
  })

  it('gives an unset value a usable label and preserves full long names and metadata', () => {
    const name = 'Long model name '.repeat(16)
    render(<ModelPicker {...defaults} value="" models={[{ ...models[0]!, name, contextLength: 200000, pricing: { prompt: '0.000001' } }]} />)
    open()
    const option = within(panel()).getByRole('button', { name: /Long model name/ })
    expect(option.textContent).toContain(name)
    expect(option.title).toContain('openai/first')
    expect(option.textContent).toContain('200K ctx')
    expect(option.textContent).toContain('$1/M')
  })
})
