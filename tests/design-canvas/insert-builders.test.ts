/**
 * Pure-builder invariants for the canvas insert panel: image fitting/centering,
 * the media-src boundary (no data: / sandbox-local), and the default template
 * set. No React, no DOM, no Konva.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INSERT_TEMPLATES,
  MAX_INSERT_DIMENSION,
  buildInsertImageOp,
  centeredPosition,
  fittedSize,
  mintElementId,
  type InsertPageGeometry,
} from '../../src/design-canvas-react/insert-builders'
import type { ImageElement, SceneElement } from '../../src/design-canvas/model'

const PAGE: InsertPageGeometry = { pageId: 'page-1', width: 1080, height: 1080 }

function elementOf(op: { type: string; element?: SceneElement }): SceneElement {
  expect(op.type).toBe('add_element')
  expect(op.element).toBeDefined()
  return op.element as SceneElement
}

describe('fittedSize', () => {
  it('caps the longest dimension at MAX_INSERT_DIMENSION (page permitting)', () => {
    const { width, height } = fittedSize(4000, 2000, 1080, 1080)
    expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_INSERT_DIMENSION)
    // aspect ratio preserved (2:1)
    expect(width / height).toBeCloseTo(2, 1)
  })

  it('never upscales past natural size', () => {
    const { width, height } = fittedSize(100, 50, 1080, 1080)
    expect(width).toBe(100)
    expect(height).toBe(50)
  })

  it('further bounds by 80% of the smaller page when the page is small', () => {
    const { width, height } = fittedSize(4000, 4000, 200, 200)
    expect(Math.max(width, height)).toBeLessThanOrEqual(Math.round(200 * 0.8))
  })

  it('falls back to the cap when natural size is unknown (0,0)', () => {
    const { width, height } = fittedSize(0, 0, 1080, 1080)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
  })
})

describe('centeredPosition', () => {
  it('centers a box on the page', () => {
    expect(centeredPosition(200, 100, 1080, 1080)).toEqual({ x: 440, y: 490 })
  })
})

describe('mintElementId', () => {
  it('produces unique non-empty ids', () => {
    const a = mintElementId()
    const b = mintElementId()
    expect(a).toBeTruthy()
    expect(a).not.toBe(b)
  })
})

describe('buildInsertImageOp', () => {
  it('builds an add_element op with a fitted, centered image', () => {
    const op = buildInsertImageOp('https://cdn.example.com/a.png', { width: 800, height: 400 }, PAGE)
    const el = elementOf(op) as ImageElement
    expect(el.kind).toBe('image')
    expect(el.src).toBe('https://cdn.example.com/a.png')
    expect(el.fit).toBe('contain')
    expect(Math.max(el.width, el.height)).toBeLessThanOrEqual(MAX_INSERT_DIMENSION)
    // centered
    expect(el.x).toBe(Math.round((PAGE.width - el.width) / 2))
    expect(el.y).toBe(Math.round((PAGE.height - el.height) / 2))
  })

  it('accepts a rooted /api/ path', () => {
    const op = buildInsertImageOp('/api/assets/x.png', { width: 100, height: 100 }, PAGE)
    expect((elementOf(op) as ImageElement).src).toBe('/api/assets/x.png')
  })

  it('rejects a data: url (media boundary)', () => {
    expect(() => buildInsertImageOp('data:image/png;base64,AAAA', { width: 10, height: 10 }, PAGE)).toThrow()
  })

  it('rejects a sandbox-local / bare path', () => {
    expect(() => buildInsertImageOp('/tmp/x.png', { width: 10, height: 10 }, PAGE)).toThrow()
    expect(() => buildInsertImageOp('file.png', { width: 10, height: 10 }, PAGE)).toThrow()
  })
})

describe('DEFAULT_INSERT_TEMPLATES', () => {
  it('exposes heading, body, rect, ellipse', () => {
    expect(DEFAULT_INSERT_TEMPLATES.map((t) => t.id)).toEqual(['heading', 'body', 'rect', 'ellipse'])
  })

  it('each template builds exactly one add_element op for the page', () => {
    for (const tpl of DEFAULT_INSERT_TEMPLATES) {
      const ops = tpl.build(PAGE)
      expect(ops).toHaveLength(1)
      const el = elementOf(ops[0]!)
      expect(el.id).toBeTruthy()
      // landed within the page bounds
      expect(el.x).toBeGreaterThanOrEqual(0)
      expect(el.y).toBeGreaterThanOrEqual(0)
    }
  })

  it('text templates carry valid text attributes', () => {
    const heading = DEFAULT_INSERT_TEMPLATES.find((t) => t.id === 'heading')!.build(PAGE)[0]!
    const el = elementOf(heading)
    expect(el.kind).toBe('text')
    if (el.kind === 'text') {
      expect(el.fontStyle).toBe('bold')
      expect(el.text.length).toBeGreaterThan(0)
    }
  })

  it('text templates choose readable fills for dark pages', () => {
    const darkPage = { ...PAGE, background: '#0f172a' }
    const heading = DEFAULT_INSERT_TEMPLATES.find((t) => t.id === 'heading')!.build(darkPage)[0]!
    const body = DEFAULT_INSERT_TEMPLATES.find((t) => t.id === 'body')!.build(darkPage)[0]!
    expect(elementOf(heading)).toMatchObject({ kind: 'text', fill: '#f8fafc' })
    expect(elementOf(body)).toMatchObject({ kind: 'text', fill: '#cbd5e1' })
  })
})
