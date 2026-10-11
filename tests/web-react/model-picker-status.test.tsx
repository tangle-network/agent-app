// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModelPicker } from '../../src/web-react/controls'
import type { CatalogModel } from '../../src/runtime/model-catalog'

afterEach(cleanup)

const base = { provider: 'fal', supportsTools: false, supportsReasoning: false, featured: true, output: 'video' as const }
const ok: CatalogModel = { ...base, id: 'fal/ok', name: 'Ready Model' }
const limited: CatalogModel = { ...base, id: 'fal/limited', name: 'Limited Model', status: 'limited', statusReason: 'Up to 5 s on this plan' }
const down: CatalogModel = { ...base, id: 'fal/down', name: 'Down Model', status: 'unavailable', statusReason: 'Provider outage' }

it('marks limited and unavailable models in the warning tone and keeps them selectable', () => {
  const onChange = vi.fn()
  render(<ModelPicker value="fal/ok" onChange={onChange} models={[ok, limited, down]} />)
  fireEvent.click(screen.getByRole('button', { name: /Ready Model/ }))
  const row = (name: RegExp) => screen.getByRole('button', { name })
  expect(row(/Ready Model/).querySelector('[data-model-status]')).toBeNull()
  expect(row(/Limited Model/).querySelector('[data-model-status]')?.textContent).toBe('Limited')
  expect(row(/Down Model/).querySelector('[data-model-status]')?.textContent).toBe('Unavailable')
  // The reason fills the line under the name when the model has no capability text.
  expect(row(/Down Model/).querySelector('[data-model-capability]')?.textContent).toBe('Provider outage')
  fireEvent.click(row(/Down Model/))
  expect(onChange).toHaveBeenCalledWith('fal/down')
})
