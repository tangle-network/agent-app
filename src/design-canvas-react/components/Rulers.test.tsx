// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Rulers } from './Rulers'

afterEach(() => cleanup())

const BASE_PROPS = {
  pageWidth: 1080,
  pageHeight: 1080,
  zoom: 0.5,
  scrollLeft: 140,
  scrollTop: 60,
  showRulers: true,
  onGuidesChange: vi.fn(),
}

describe('Rulers saved-guide rendering', () => {
  it('renders a persistent track marker for every saved guide at the zoom/scroll-adjusted position', () => {
    const { container } = render(
      <Rulers {...BASE_PROPS} guides={{ vertical: [540], horizontal: [270, 810] }} />,
    )

    const vMarkers = container.querySelectorAll('[data-guide-marker="vertical"]')
    const hMarkers = container.querySelectorAll('[data-guide-marker="horizontal"]')
    expect(vMarkers).toHaveLength(1)
    expect(hMarkers).toHaveLength(2)

    // 540 doc px at 50% zoom with 140 doc px scrolled off: 540*0.5 - 140*0.5 = 200
    expect((vMarkers[0] as HTMLElement).style.left).toBe('200px')
    // 270*0.5 - 60*0.5 = 105; 810*0.5 - 60*0.5 = 375
    expect((hMarkers[0] as HTMLElement).style.top).toBe('105px')
    expect((hMarkers[1] as HTMLElement).style.top).toBe('375px')
  })

  it('renders thin lines spanning the canvas that continue each track marker', () => {
    const { container } = render(
      <Rulers {...BASE_PROPS} guides={{ vertical: [540], horizontal: [270] }} />,
    )

    const vLines = container.querySelectorAll('[data-guide-line="vertical"]')
    const hLines = container.querySelectorAll('[data-guide-line="horizontal"]')
    expect(vLines).toHaveLength(1)
    expect(hLines).toHaveLength(1)

    // The overlay is inset by the 20px track size, so identical local
    // coordinates mean each line visually continues its track marker.
    expect((vLines[0] as HTMLElement).style.left).toBe('200px')
    expect((hLines[0] as HTMLElement).style.top).toBe('105px')

    // The overlay must never intercept canvas pointer events.
    const overlay = vLines[0]!.parentElement!
    expect(overlay.className).toContain('pointer-events-none')
  })

  it('renders no markers or canvas lines when the page has no saved guides', () => {
    const { container } = render(
      <Rulers {...BASE_PROPS} guides={{ vertical: [], horizontal: [] }} />,
    )
    expect(container.querySelectorAll('[data-guide-marker]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-guide-line]')).toHaveLength(0)
  })

  it('renders nothing at all when rulers are hidden', () => {
    const { container } = render(
      <Rulers {...BASE_PROPS} showRulers={false} guides={{ vertical: [540], horizontal: [270] }} />,
    )
    expect(container.firstChild).toBeNull()
  })
})
