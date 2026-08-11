import { version as reactVersion } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import { inertProps } from './inert'

/**
 * Two halves, because only one of them is observable from here.
 *
 * The first passes both majors explicitly and pins the DECISION — which
 * spelling the helper picks — against the truth table measured in `./inert`.
 * The second RENDERS, so the half of that table belonging to the installed
 * React is exercised rather than restated: it is what would go red if the
 * measurement were wrong about this major.
 */
describe('inertProps', () => {
  it('emits nothing when the element must stay reachable', () => {
    // Both majors already render `inert={false}` as no attribute at all, so
    // this branch is not correcting anything — it is refusing to emit the one
    // shape that would be wrong, an `inert` whose value says "not inert". HTML
    // reads ANY value as inert, the string "false" included.
    expect(inertProps(false, 18)).toEqual({})
    expect(inertProps(false, 19)).toEqual({})
  })

  it('emits the bare attribute in each version’s own spelling', () => {
    // React 19 knows `inert` as a boolean attribute: `true` renders `inert=""`.
    expect(inertProps(true, 19)).toEqual({ inert: true })
    // React 18 does not, and DROPS the boolean with a warning — a collapsed
    // panel would stay focusable. It writes the empty string through instead.
    expect(inertProps(true, 18)).toEqual({ inert: '' })
  })

  it('bets on the current major when the version is unreadable', () => {
    // No value is inert on both majors, so NaN has to pick one. It picks 19:
    // every published React 18 version string parses to 18, so a version that
    // does not parse is not React 18.
    expect(inertProps(true, Number.NaN)).toEqual({ inert: true })
  })

  it('renders an inert attribute on the React that is installed', () => {
    const major = Number.parseInt(reactVersion, 10)
    const markup = (props: object) => renderToStaticMarkup(createElement('div', props, 'x'))

    expect(markup(inertProps(true))).toBe('<div inert="">x</div>')
    expect(markup(inertProps(false))).toBe('<div>x</div>')

    // The two spellings are NOT interchangeable, which is the whole reason the
    // helper branches. Whichever major is installed, the OTHER major's spelling
    // renders no attribute here — so a single hard-coded spelling would leave a
    // collapsed panel focusable on one of the two.
    const otherMajor = major >= 19 ? 18 : 19
    expect(markup(inertProps(true, otherMajor))).toBe('<div>x</div>')
  })
})
