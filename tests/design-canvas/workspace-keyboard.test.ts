// @vitest-environment jsdom
/**
 * Keyboard single-fire contract for the design-canvas workspace.
 *
 * DesignCanvasEditor mounts BOTH the WorkspaceView (per-element keydown on the
 * focused canvas div) and DesignCanvas's window-level keydown listener, on one
 * shared event stack. The window listener also handles undo/redo/delete, so
 * without stopPropagation a single Cmd+Z would undo TWICE (once per handler).
 *
 * These tests render the standalone Workspace and attach a window keydown spy.
 * The overlapping keys (undo z / redo z+shift / redo y / Delete / Backspace)
 * must NOT reach window — Workspace.handleKeyDown calls e.stopPropagation() on
 * those branches. Workspace-only keys (e.g. Cmd+A) intentionally still bubble
 * to window because the window listener does not handle them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Workspace } from '../../src/design-canvas-react/components/Workspace'
import type { DesignCanvasProps } from '../../src/design-canvas-react/contracts'
import type { SceneDocument } from '../../src/design-canvas/model'

function makeDoc(): SceneDocument {
  return {
    schemaVersion: 1,
    title: 'KB',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        width: 800,
        height: 600,
        background: '#ffffff',
        bleed: null,
        guides: { vertical: [], horizontal: [] },
        elements: [
          {
            id: 'el-1',
            kind: 'rect',
            name: 'Rect',
            x: 10,
            y: 20,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            width: 100,
            height: 50,
            fill: '#ff0000',
          },
        ],
      },
    ],
    settings: { dpi: 96 },
    metadata: {},
  }
}

function props(): DesignCanvasProps {
  return {
    document: makeDoc(),
    rev: 1,
    canWrite: true,
    onApplyOperations: vi.fn(async () => ({ rev: 2 })),
  }
}

let windowSpy: ReturnType<typeof vi.fn>

// Konva's Stage sizes a backing <canvas> on mount and Workspace observes its
// container via ResizeObserver — neither exists in jsdom. Polyfill both so the
// real component mounts; the keyboard wiring under test is DOM-level and does
// not depend on actual pixel output.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// jsdom's <canvas> has no 2D context; Konva crashes reading `ctx.scale`. A
// Proxy that returns no-op functions for any property satisfies every call
// Konva makes during mount/draw without a real rasterizer.
function stubCanvasContext(): void {
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'canvas') return document.createElement('canvas')
        if (prop === 'measureText') return () => ({ width: 0 })
        if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
        return () => undefined
      },
      set: () => true,
    },
  )
  ;(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ctx
}

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub
  stubCanvasContext()
  windowSpy = vi.fn()
  window.addEventListener('keydown', windowSpy)
})

afterEach(() => {
  window.removeEventListener('keydown', windowSpy)
  cleanup()
})

function workspaceDiv(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.design-canvas-workspace') as HTMLElement | null
  if (!el) throw new Error('workspace div not found')
  return el
}

describe('Workspace keyboard single-fire', () => {
  it('stops undo (Cmd+Z) from reaching the window-level listener', () => {
    const { container } = render(createElement(Workspace, props()))
    fireEvent.keyDown(workspaceDiv(container), { key: 'z', metaKey: true })
    expect(windowSpy).not.toHaveBeenCalled()
  })

  it('stops redo (Shift+Cmd+Z and Ctrl+Y) from reaching window', () => {
    const { container } = render(createElement(Workspace, props()))
    const div = workspaceDiv(container)
    fireEvent.keyDown(div, { key: 'z', metaKey: true, shiftKey: true })
    fireEvent.keyDown(div, { key: 'y', ctrlKey: true })
    expect(windowSpy).not.toHaveBeenCalled()
  })

  it('stops Delete/Backspace from reaching window when a selection exists', () => {
    const { container } = render(createElement(Workspace, props()))
    const div = workspaceDiv(container)
    // Select via Cmd+A first. fireEvent wraps each dispatch in act() and flushes
    // React, so the selection state is committed before the Delete keydown reads
    // selectedElementIds — without that flush the Delete branch would see an
    // empty selection and skip (a test-timing artifact, not the behavior here).
    fireEvent.keyDown(div, { key: 'a', metaKey: true })
    windowSpy.mockClear()
    fireEvent.keyDown(div, { key: 'Delete' })
    expect(windowSpy).not.toHaveBeenCalled()
  })

  it('lets Workspace-only keys (Cmd+A) bubble to window — the stop is targeted', () => {
    const { container } = render(createElement(Workspace, props()))
    fireEvent.keyDown(workspaceDiv(container), { key: 'a', metaKey: true })
    expect(windowSpy).toHaveBeenCalledTimes(1)
  })
})
