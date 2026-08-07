// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { HarnessGlyph } from './harness-glyphs'
import type { Harness } from '../harness'

/**
 * The picker glyph contract: every harness with a published brand mark renders
 * that mark (single-color, currentColor, so it tracks the theme); harnesses
 * without one render the honest lucide fallback the legacy picker assigned;
 * an id outside the union renders the neutral bot, never an invented logo.
 */

const BRANDED: Harness[] = ['opencode', 'claude-code', 'codex', 'amp', 'kimi-code', 'openclaw', 'hermes']

describe('HarnessGlyph', () => {
  it('renders the vendored brand mark for each branded harness', () => {
    for (const harness of BRANDED) {
      const { container, unmount } = render(<HarnessGlyph harness={harness} />)
      const svg = container.querySelector('svg')
      expect(svg?.getAttribute('data-glyph')).toBe(harness)
      expect(svg?.getAttribute('fill')).toBe('currentColor')
      expect(svg?.querySelector('path')).toBeTruthy()
      unmount()
    }
  })

  it('uses the legacy lucide fallbacks for harnesses with no published mark', () => {
    const cases: Array<[Harness, string]> = [
      ['factory-droids', 'bot'],
      ['nanoclaw', 'plug'],
      ['cli-base', 'terminal'],
    ]
    for (const [harness, kind] of cases) {
      const { container, unmount } = render(<HarnessGlyph harness={harness} />)
      expect(container.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe(kind)
      unmount()
    }
  })

  it('falls back to the neutral bot for an unknown harness id', () => {
    const { container } = render(<HarnessGlyph harness={'made-up-harness' as Harness} />)
    expect(container.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe('bot')
  })

  it('names the glyph for assistive tech with the harness id', () => {
    render(<HarnessGlyph harness="opencode" />)
    expect(screen.getByRole('img', { name: 'opencode' })).toBeTruthy()
  })
})
