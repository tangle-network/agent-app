/**
 * The join exists for one failure: an absent `className` interpolated into a
 * template leaves its separator behind. Each case here is a shape a caller
 * actually passes.
 */

import { describe, expect, it } from 'vitest'

import { joinClasses } from './class-names'

describe('joinClasses', () => {
  it('drops an absent class instead of leaving its separator behind', () => {
    expect(joinClasses('base', undefined)).toBe('base')
    expect(joinClasses('base', null)).toBe('base')
    expect(joinClasses('base', '')).toBe('base')
    // The whitespace-only case is the same defect one level in: a caller that
    // built its own class by interpolation hands the space along.
    expect(joinClasses('base', '   ')).toBe('base')
  })

  it('separates the parts it keeps with exactly one space', () => {
    expect(joinClasses('base', 'mt-2')).toBe('base mt-2')
    expect(joinClasses(' base ', ' mt-2 ')).toBe('base mt-2')
    expect(joinClasses(undefined, 'mt-2')).toBe('mt-2')
  })

  it('takes a conditional class without an empty-string fallback at the call site', () => {
    expect(joinClasses('base', false, 'end')).toBe('base end')
    expect(joinClasses('base', 1 > 0 && 'on')).toBe('base on')
  })

  it('is empty when there is nothing to say', () => {
    expect(joinClasses()).toBe('')
    expect(joinClasses(undefined, null, '')).toBe('')
  })
})
