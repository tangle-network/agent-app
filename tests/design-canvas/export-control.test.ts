// @vitest-environment jsdom
/**
 * Export control contract: the chrome renders an Export affordance only when
 * `onExport` is wired, the popover collects format + scale, and confirming
 * calls the workspace export callback (filled via `onExportRef`) with the
 * chosen options. Also asserts the panel-ownership invariant: renderWorkspace
 * is called once per render pass (no double-render regression).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DesignCanvas, type DesignCanvasFullProps } from '../../src/design-canvas-react/components/DesignCanvas'
import type { ExportTriggerOptions } from '../../src/design-canvas-react/contracts'
import type { SceneDocument } from '../../src/design-canvas/model'

afterEach(cleanup)

function makeDoc(): SceneDocument {
  return {
    schemaVersion: 1,
    title: 'Test',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        width: 1080,
        height: 1080,
        background: '#ffffff',
        bleed: null,
        guides: { vertical: [], horizontal: [] },
        elements: [],
      },
    ],
    settings: { dpi: 96 },
    metadata: {},
  }
}

function setup(overrides: Partial<DesignCanvasFullProps> = {}) {
  const renderWorkspace = vi.fn((): ReactNode => createElement('div', { 'data-testid': 'workspace' }))
  const renderThumbnail = vi.fn().mockResolvedValue(null)
  const onApplyOperations = vi.fn().mockResolvedValue({ rev: 1 })
  render(
    createElement(DesignCanvas, {
      document: makeDoc(),
      rev: 0,
      canWrite: true,
      onApplyOperations,
      renderWorkspace,
      renderThumbnail,
      ...overrides,
    } as DesignCanvasFullProps),
  )
  return { renderWorkspace }
}

describe('Export control gating', () => {
  it('renders no Export control when onExport is absent', () => {
    setup()
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull()
  })

  it('renders the Export control when onExport is provided', () => {
    setup({ onExport: vi.fn().mockResolvedValue(undefined) })
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy()
  })
})

describe('Export popover → workspace export callback', () => {
  it('passes the chosen format and scale through onExportRef', () => {
    const captured: ExportTriggerOptions[] = []
    const renderWorkspace = vi.fn((ctx: Parameters<DesignCanvasFullProps['renderWorkspace']>[0]): ReactNode => {
      // The workspace owns the stage; it fills the export ref the chrome calls.
      ctx.onExportRef.current = (opts) => captured.push(opts)
      return createElement('div', { 'data-testid': 'workspace' })
    })
    render(
      createElement(DesignCanvas, {
        document: makeDoc(),
        rev: 0,
        canWrite: true,
        onApplyOperations: vi.fn().mockResolvedValue({ rev: 1 }),
        onExport: vi.fn().mockResolvedValue(undefined),
        renderWorkspace,
        renderThumbnail: vi.fn().mockResolvedValue(null),
      } as DesignCanvasFullProps),
    )

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    // Pick JPEG + 2x, then confirm.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'JPEG' }))
      fireEvent.click(screen.getByRole('button', { name: '2x' }))
    })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Export image' }))
    })

    expect(captured).toEqual([{ format: 'jpeg', pixelRatio: 2 }])
  })

  it('defaults to PNG @ 1x when confirmed without changes', () => {
    const captured: ExportTriggerOptions[] = []
    const renderWorkspace = vi.fn((ctx: Parameters<DesignCanvasFullProps['renderWorkspace']>[0]): ReactNode => {
      ctx.onExportRef.current = (opts) => captured.push(opts)
      return createElement('div', null)
    })
    render(
      createElement(DesignCanvas, {
        document: makeDoc(),
        rev: 0,
        canWrite: true,
        onApplyOperations: vi.fn().mockResolvedValue({ rev: 1 }),
        onExport: vi.fn().mockResolvedValue(undefined),
        renderWorkspace,
        renderThumbnail: vi.fn().mockResolvedValue(null),
      } as DesignCanvasFullProps),
    )
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Export image' }))
    })
    expect(captured).toEqual([{ format: 'png', pixelRatio: 1 }])
  })
})

describe('panel-ownership invariant (no double-render)', () => {
  it('renders the workspace exactly once per render pass', () => {
    const { renderWorkspace } = setup({ onExport: vi.fn().mockResolvedValue(undefined) })
    expect(renderWorkspace).toHaveBeenCalledTimes(1)
  })
})
