import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeProfileName, parseProfileSwitch } from '../src/agent-profiles/switch'
import * as barrel from '../src/agent-profiles/index'

describe('agent-profiles/switch', () => {
  it('parses a profile switch and normalizes names', () => {
    expect(parseProfileSwitch('  Switch to   Majo  ')).toEqual({ name: 'Majo' })
    expect(parseProfileSwitch('switch to')).toEqual({ invalid: true })
    expect(parseProfileSwitch('hello')).toBeNull()
    expect(normalizeProfileName('  Front   Desk ')).toBe('front desk')
  })

  it('stays importable by browser code without the profile schemas', () => {
    const source = readFileSync(new URL('../src/agent-profiles/switch.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/^import /m)
    expect(barrel.parseProfileSwitch).toBe(parseProfileSwitch)
  })
})
