// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ProviderLogo } from '../../src/web-react/provider-logo'

afterEach(cleanup)

it('draws the shared mark for chat providers and Studio video makers', () => {
  for (const [provider, label] of [['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['kuaishou', 'Kling'], ['runway', 'Runway'], ['bytedance', 'ByteDance'], ['lightricks', 'Lightricks'], ['x-ai', 'xAI']]) {
    const { container, unmount } = render(<ProviderLogo provider={provider} />)
    expect(container.querySelector(`[aria-label="${label}"]`), provider).not.toBeNull()
    unmount()
  }
})

it('falls back to a monogram for a provider with no bundled mark', () => {
  const { container } = render(<ProviderLogo provider="tuner" />)
  const mono = container.querySelector('svg[aria-label="tuner"]')
  expect(mono?.textContent).toBe('T')
})
