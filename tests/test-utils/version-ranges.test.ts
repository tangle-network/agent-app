import { describe, expect, it } from 'vitest'
import { minimumVersionGte } from './version-ranges'

describe('minimumVersionGte', () => {
  it.each([
    ['0.134.1', '>=0.134.1', true],
    ['^6.1.7', '>=6.1.7', true],
    ['>=0.108.0 <0.109.0', '>=0.108.0', true],
    ['>=0.15.1', '>=0.15.2', false],
    ['1.2.3-beta.2', '>=1.2.3', false],
  ])('%s meets %s: %s', (actual, required, expected) => {
    expect(minimumVersionGte(actual, required)).toBe(expected)
  })

  it.each([
    ['not-a-range', '>=1.0.0'],
    ['>=1.0.0', 'not-a-range'],
  ])('rejects malformed ranges: %s / %s', (actual, required) => {
    expect(() => minimumVersionGte(actual, required)).toThrow('invalid semver range')
  })
})
