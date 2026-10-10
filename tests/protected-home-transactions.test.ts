import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('protected home transactions', () => {
  it('preserves CAS, journal recovery and trusted identity with real Git in disposable fixtures', () => {
    const result = spawnSync('python3', [resolve('tests/protected_home_transactions.py')], {
      cwd: resolve('.'), encoding: 'utf8', timeout: 60_000,
    })
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('Ran 20 tests')
  }, 65_000)
})
