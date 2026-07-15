/**
 * Exercises the exportable checkThemeContract() a CONSUMER app runs against its
 * own source (../../src/theme-contract). Fixtures under fixtures/ stand in for a
 * consumer: a controlled tokens.css that omits --popover, plus components that
 * reference defined tokens (pass), an undefined var (fail), and an undefined
 * dangerous utility (fail) — the invisible-surface incident in miniature.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { checkThemeContract } from '../../src/theme-contract/index'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')
const srcDir = join(fixtures, 'consumer-src')
const tokensCss = join(fixtures, 'tokens.css')
const extraCss = join(fixtures, 'extra-tokens.css')

describe('checkThemeContract', () => {
  it('flags an undefined var() reference and attributes it to the file', () => {
    const { ok, missing } = checkThemeContract({ srcDirs: [srcDir], tokensCss })
    expect(ok).toBe(false)
    const miss = missing.find((m) => m.varName === '--nonexistent-token')
    expect(miss, 'should report the undefined --nonexistent-token').toBeDefined()
    expect(miss!.referencedIn).toContain('BadVarComponent.tsx')
  })

  it('flags an undefined dangerous Tailwind utility and names the class', () => {
    const { missing } = checkThemeContract({ srcDirs: [srcDir], tokensCss })
    // bg-surface-container-high → --popover, which the fixture tokens.css omits.
    const miss = missing.find((m) => m.varName === '--popover')
    expect(miss, 'should report --popover behind bg-surface-container-high').toBeDefined()
    expect(miss!.referencedIn).toContain('BadUtilityComponent.tsx')
    expect(miss!.referencedIn).toContain('via bg-surface-container-high')
  })

  it('does not flag references to defined tokens (var(--card) + bg-card)', () => {
    const { missing } = checkThemeContract({ srcDirs: [srcDir], tokensCss })
    // --card is defined; neither the literal var(--card) nor bg-card should miss.
    expect(missing.some((m) => m.varName === '--card')).toBe(false)
    expect(missing.some((m) => m.referencedIn.includes('GoodComponent'))).toBe(false)
  })

  it('allowlist suppresses named tokens from the missing report', () => {
    const { ok, missing } = checkThemeContract({
      srcDirs: [srcDir],
      tokensCss,
      allowlist: ['--nonexistent-token', '--popover'],
    })
    expect(missing).toEqual([])
    expect(ok).toBe(true)
  })

  it('extra CSS files count as defined tokens', () => {
    // extra-tokens.css defines both --popover and --nonexistent-token.
    const { ok, missing } = checkThemeContract({
      srcDirs: [srcDir],
      tokensCss,
      extraTokensCss: [extraCss],
    })
    expect(missing).toEqual([])
    expect(ok).toBe(true)
  })
})
