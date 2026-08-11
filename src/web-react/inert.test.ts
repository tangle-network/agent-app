import { describe, expect, it } from 'vitest'

import { inertProps } from './inert'

/**
 * The whole point of the helper is the version this test env does NOT run, so
 * both majors are passed explicitly. `peerDependencies` declares `react >=18`,
 * so React 18 is a consumer we ship to and cannot observe from here.
 */
describe('inertProps', () => {
  it('emits nothing when the element must stay reachable', () => {
    // React 18 renders an unknown attribute's value verbatim, so `inert={false}`
    // becomes `inert="false"` — and HTML reads ANY value as inert. There is no
    // "not inert" value; absence is the only spelling.
    expect(inertProps(false, 18)).toEqual({})
    expect(inertProps(false, 19)).toEqual({})
  })

  it('emits the bare attribute in each version’s own spelling', () => {
    // React 19 knows `inert` as a boolean attribute: `true` renders `inert=""`.
    expect(inertProps(true, 19)).toEqual({ inert: true })
    // React 18 does not know it, so a boolean is DROPPED with a warning and the
    // panel stays focusable. An empty string is written through as `inert=""`.
    expect(inertProps(true, 18)).toEqual({ inert: '' })
  })

  it('falls back to the spelling that works on both when the version is unreadable', () => {
    // NaN >= 19 is false. The fallback has to be the React 18 string: it is
    // inert on both versions, where a boolean is inert on only one.
    expect(inertProps(true, Number.NaN)).toEqual({ inert: '' })
  })
})
