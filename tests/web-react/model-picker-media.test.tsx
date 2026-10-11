// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { formatModelPrice, ModelPicker } from '../../src/web-react/controls'
import type { CatalogModel } from '../../src/runtime/model-catalog'

afterEach(cleanup)

const base = { supportsTools: false, supportsReasoning: false, featured: true }
const models: CatalogModel[] = [
  { ...base, id: 'openai/gpt-x', name: 'GPT X', provider: 'openai', supportsTools: true, pricing: { prompt: '0.000003' } },
  { ...base, id: 'fal/flux', name: 'Flux Pro', provider: 'fal', output: 'image', outputPrice: { usd: 0.04, unit: 'image' },
    previewUrl: 'https://cdn.test/flux.webp', capability: 'Photoreal stills, strong typography' },
  { ...base, id: 'google/veo', name: 'Veo 3', provider: 'google', output: 'video', outputPrice: { usd: 0.5, unit: 'second' },
    previewUrl: 'https://cdn.test/veo.jpg', capability: 'Up to 8 s with native audio' },
  { ...base, id: 'elevenlabs/v3', name: 'Eleven v3', provider: 'elevenlabs', output: 'speech', outputPrice: { usd: 0.3, unit: '1k_chars' } },
]

describe('formatModelPrice', () => {
  it('prices every model in the unit its output comes in', () => {
    expect(formatModelPrice(models[0])).toBe('$3/M')
    expect(formatModelPrice(models[1])).toBe('$0.04/image')
    expect(formatModelPrice(models[2])).toBe('$0.5/sec')
    expect(formatModelPrice(models[3])).toBe('$0.3/1K chars')
    expect(formatModelPrice({ outputPrice: { usd: 0, unit: 'image' } })).toBeUndefined()
    expect(formatModelPrice({})).toBeUndefined()
  })
})

describe('ModelPicker media rows', () => {
  it('shows a preview, the capability line and the per-output price for media models', () => {
    render(<ModelPicker value="openai/gpt-x" onChange={() => {}} models={models} />)
    fireEvent.click(screen.getByRole('button', { name: /GPT X/ }))
    const flux = screen.getByRole('button', { name: /Flux Pro/ })
    expect(flux.querySelector('[data-model-preview]')?.getAttribute('src')).toBe('https://cdn.test/flux.webp')
    expect(flux.querySelector('[data-model-capability]')?.textContent).toBe('Photoreal stills, strong typography')
    expect(flux.querySelector('[data-model-price]')?.textContent).toBe('$0.04/image')
    // Media rows never claim a text-only limitation.
    expect(flux.textContent).not.toContain('no tools')
    // Speech has no visual preview: the provider logo stays.
    const speech = screen.getByRole('button', { name: /Eleven v3/ })
    expect(speech.querySelector('[data-model-preview]')).toBeNull()
    expect(speech.querySelector('[data-model-price]')?.textContent).toBe('$0.3/1K chars')
  })
})
