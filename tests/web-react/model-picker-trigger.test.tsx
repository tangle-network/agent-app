// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModelPicker } from '../../src/web-react/controls'
import type { CatalogModel } from '../../src/runtime/model-catalog'

afterEach(cleanup)
const models: CatalogModel[] = [{ id: 'openai/model-a', name: 'Model A', provider: 'openai',
  supportsTools: true, supportsReasoning: false, featured: true }]

it('uses supplied trigger content while preserving searchable selection', () => {
  const onChange = vi.fn()
  render(<ModelPicker value="custom/model" onChange={onChange} models={models}
    variant="quiet" triggerContent={<span>Search</span>} />)
  const trigger = screen.getByRole('button', { name: /^Search$/ })
  expect(trigger.textContent).not.toContain('custom/model')
  fireEvent.click(trigger)
  fireEvent.change(screen.getByPlaceholderText('Search models...'), { target: { value: 'Model A' } })
  fireEvent.click(screen.getByRole('button', { name: /Model A/ }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith('openai/model-a')
  expect(trigger.getAttribute('data-state')).toBe('closed')
})

it('retains the selected label by default', () => {
  render(<ModelPicker value="openai/model-a" onChange={() => {}} models={models} />)
  expect(screen.getByRole('button', { name: /Model A/ }).textContent).toContain('Model A')
  expect(screen.queryByRole('button', { name: /^Search$/ })).toBeNull()
})
