import { createElement } from 'react'
import { version as reactVersion } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { inertProps } from './inert'

/**
 * These RENDER rather than compare a returned object, because the fact under
 * test is what reaches the DOM, not what the helper decided to return. The
 * cross-major table lives in `./inert` and was measured against real React
 * 18.3.1 and 19.2.8; only the installed major can be exercised here.
 */
describe('inertProps', () => {
  const markup = (props: object) => renderToStaticMarkup(createElement('div', props, 'x'))

  it('emits nothing when the element must stay reachable', () => {
    // Not a correction — a refusal. HTML reads ANY value as inert, the string
    // "false" included, so the one shape that would be wrong is an `inert`
    // whose value reads as "not inert".
    expect(inertProps(false)).toEqual({})
    expect(markup(inertProps(false))).toBe('<div>x</div>')
  })

  it('emits an attribute the browser reads as inert, on the installed React', () => {
    expect(markup(inertProps(true))).toBe('<div inert="">x</div>')
  })

  it('needs no version detection: the value it emits is inert on both majors', () => {
    // This is the property that let the version branch go. `inert` is an HTML
    // boolean attribute, so PRESENCE is what matters, and a non-empty string is
    // present on both majors — React 18 writes it through verbatim
    // (`inert="1"`), React 19 normalises it (`inert=""`). Neither warns.
    //
    // The values that DIFFER are what the old branch turned on: `true` is
    // dropped by React 18, `''` is dropped by React 19. Either one hard-coded
    // leaves a collapsed panel focusable on the other major, which is why this
    // asserts the emitted value is a non-empty string rather than either of
    // those two.
    const props = inertProps(true) as { inert?: unknown }
    expect(typeof props.inert).toBe('string')
    expect(props.inert).not.toBe('')
    expect(props.inert).not.toBe(false)
  })

  it('does not read the React version to decide', () => {
    // The detection it replaced was `Number.parseInt(version)`, which reads 0
    // out of every `0.0.0-experimental-*` canary — half of all published React
    // versions — and routed those React 19 pre-releases to the React 18
    // spelling, dropping the attribute. A helper that consults no version
    // cannot get the version wrong, and this pins that it consults none.
    expect(inertProps.length).toBe(1)
    expect(String(inertProps)).not.toContain('version')
    expect(reactVersion).toMatch(/\d/)
  })
})
