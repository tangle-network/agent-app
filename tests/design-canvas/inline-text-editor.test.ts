// @vitest-environment jsdom
/**
 * InlineTextEditor render behavior: commit-on-blur, Meta/Ctrl+Enter commit,
 * Escape-cancel, and the container-relative positioning contract.
 *
 * The editor is a positioned <textarea> the Workspace mounts over a text
 * element. It must commit the textarea's CURRENT value on blur and on
 * mod+Enter, and cancel (no commit) on Escape. Positioning is verified at the
 * seam: the overlay's left/top are container-relative (stageRect 0/0) so they
 * equal pan + element*zoom with no double-counted viewport offset.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { InlineTextEditor } from '../../src/design-canvas-react/components/InlineTextEditor'
import type { TextElement } from '../../src/design-canvas/model'

function textEl(overrides: Partial<TextElement> = {}): TextElement {
  return {
    id: 'text-1',
    kind: 'text',
    name: 'Heading',
    x: 100,
    y: 50,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    width: 200,
    text: 'Hello',
    fontFamily: 'Inter',
    fontSize: 16,
    fontStyle: 'normal',
    fill: '#000000',
    align: 'left',
    lineHeight: 1.2,
    letterSpacing: 0,
    ...overrides,
  }
}

afterEach(() => cleanup())

describe('InlineTextEditor', () => {
  it('commits the current textarea value on blur', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const { container } = render(
      createElement(InlineTextEditor, {
        element: textEl(),
        zoom: 1,
        panX: 0,
        panY: 0,
        stageRect: { left: 0, top: 0 },
        onCommit,
        onCancel,
      }),
    )
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'Edited' } })
    fireEvent.blur(ta)
    expect(onCommit).toHaveBeenCalledWith('Edited')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('commits on Meta+Enter and Ctrl+Enter', () => {
    const onCommit = vi.fn()
    const { container } = render(
      createElement(InlineTextEditor, {
        element: textEl(),
        zoom: 1,
        panX: 0,
        panY: 0,
        stageRect: { left: 0, top: 0 },
        onCommit,
        onCancel: vi.fn(),
      }),
    )
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'Via Meta' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    expect(onCommit).toHaveBeenLastCalledWith('Via Meta')

    fireEvent.change(ta, { target: { value: 'Via Ctrl' } })
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true })
    expect(onCommit).toHaveBeenLastCalledWith('Via Ctrl')
  })

  it('cancels on Escape without committing', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const { container } = render(
      createElement(InlineTextEditor, {
        element: textEl(),
        zoom: 1,
        panX: 0,
        panY: 0,
        stageRect: { left: 0, top: 0 },
        onCommit,
        onCancel,
      }),
    )
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'discarded' } })
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('positions the overlay container-relative (no double-counted stage offset)', () => {
    // Workspace mounts the editor inside its `relative` container and passes
    // stageRect {0,0}; the overlay origin must equal pan + element*zoom so it
    // lands exactly over the text. A non-zero stageRect here would prove the
    // double-count regression.
    const { container } = render(
      createElement(InlineTextEditor, {
        element: textEl({ x: 100, y: 50, width: 200 }),
        zoom: 2,
        panX: 10,
        panY: 20,
        stageRect: { left: 0, top: 0 },
        onCommit: vi.fn(),
        onCancel: vi.fn(),
      }),
    )
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    expect(ta.style.left).toBe('210px') // 10 + 100*2
    expect(ta.style.top).toBe('120px') // 20 + 50*2
    expect(ta.style.width).toBe('400px') // 200*2
  })
})
