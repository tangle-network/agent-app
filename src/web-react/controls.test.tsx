// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { ModelPicker } from './controls'
import type { CatalogModel } from '../runtime/model-catalog'

function model(id: string, overrides: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, provider: 'openai', supportsTools: true, supportsReasoning: false, featured: false, ...overrides }
}

function openPicker(): void {
  fireEvent.click(screen.getByRole('button', { expanded: false }))
}

describe('ModelPicker', () => {
  it('shows the loading copy and no rows while loading', () => {
    render(<ModelPicker value="gpt" onChange={() => {}} models={[]} loading />)
    openPicker()
    expect(screen.getByText('Loading models...')).toBeTruthy()
    expect(screen.queryByText('No models available')).toBeNull()
  })

  it('names an empty catalogue explicitly rather than rendering a blank menu', () => {
    render(<ModelPicker value="gpt" onChange={() => {}} models={[]} />)
    openPicker()
    expect(screen.getByText('No models available')).toBeTruthy()
  })

  it('renders provider-grouped rows for a real catalogue', () => {
    render(<ModelPicker value="gpt-4" onChange={() => {}} models={[model('gpt-4', { name: 'GPT-4' })]} />)
    openPicker()
    expect(screen.queryByText('No models available')).toBeNull()
    expect(screen.getAllByText('GPT-4').length).toBeGreaterThan(0)
  })

  it('still distinguishes "no search matches" from "no catalogue at all"', () => {
    render(<ModelPicker value="gpt-4" onChange={() => {}} models={[model('gpt-4', { name: 'GPT-4' })]} />)
    openPicker()
    fireEvent.change(screen.getByPlaceholderText('Search models...'), { target: { value: 'nonexistent' } })
    expect(screen.getByText('No models match your search')).toBeTruthy()
    expect(screen.queryByText('No models available')).toBeNull()
  })
})
