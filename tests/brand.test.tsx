import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TangleKnot as CanonicalTangleKnot } from '@tangle-network/brand'
import { Logo, TangleKnot } from '../src/brand/index'

describe('brand', () => {
  it('uses the canonical brand mark instead of maintaining a copy', () => {
    expect(TangleKnot).toBe(CanonicalTangleKnot)
  })

  it('uses unique paint resource ids for every mark on a page', () => {
    const markup = renderToStaticMarkup(
      createElement('div', null, createElement(TangleKnot), createElement(TangleKnot)),
    )
    const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!)
    const references = [...markup.matchAll(/url\(#([^)]+)\)/g)].map(
      (match) => match[1]!,
    )

    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(ids.length)
    expect(references).toHaveLength(4)
    expect(references.every((reference) => ids.includes(reference))).toBe(true)
  })

  it('defines paint resources before paths reference them', () => {
    const markup = renderToStaticMarkup(createElement(TangleKnot))

    expect(markup.indexOf('<defs>')).toBeLessThan(markup.indexOf('<path '))
  })

  it('maps the existing iconOnly option to the canonical icon variant', () => {
    expect(renderToStaticMarkup(createElement(Logo, { iconOnly: true }))).toMatch(
      /^<svg/,
    )
    expect(renderToStaticMarkup(createElement(Logo))).toMatch(/^<div/)
  })
})
