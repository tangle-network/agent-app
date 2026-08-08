/**
 * Source-level half of the picker-canon popover invariant.
 *
 * `tests/web-react/popover-escapes-host.test.tsx` proves that the popovers
 * which exist TODAY portal out of a clipping host. It cannot see the fifth
 * picker someone adds next month the old way, and the old way is what took the
 * model and thinking menus off the screen in production: an `absolute` panel
 * anchored inside its trigger's container, whose visibility is then decided by
 * whatever the host wrapped that container in (a scroll rail, a `transform`, a
 * stacking context).
 *
 * `bg-popover` is what marks an element as a floating surface in this package.
 * Declaring `absolute` on that same element is the defect, and the fix is
 * `PopoverSurface`.
 *
 * Scope is the picker canon named in AGENTS.md ("UI chrome ownership"), not all
 * of `web-react`: the surfaces outside it — the session-history kebab menu and
 * the record-grid source popover — are still in-place today and carry the same
 * latent risk, but converting them is a separate change with its own anchoring
 * decisions, so this gate does not silently claim them.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CANON_FILES = ['src/web-react/controls.tsx', 'src/web-react/agent-session-controls.tsx']

describe('picker canon: no in-place floating panel', () => {
  it('no canonical picker surface positions itself with `absolute`', () => {
    const offenders: string[] = []
    for (const file of CANON_FILES) {
      readFileSync(join(repoRoot, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.includes('bg-popover') && /\babsolute\b/.test(line)) offenders.push(`${file}:${i + 1}`)
        })
    }
    expect(offenders, 'use PopoverSurface — an in-place absolute panel is what a host clips away').toEqual([])
  })

  it('every canonical picker renders its panel through PopoverSurface', () => {
    // A panel that is not a `PopoverSurface` is not portaled, whatever else it
    // declares. Counting them pins the four the canon ships, so deleting the
    // portal from one of them cannot pass by leaving the other three intact.
    const surfaces = CANON_FILES.reduce((total, file) => {
      const source = readFileSync(join(repoRoot, file), 'utf8')
      return total + (source.match(/<PopoverSurface\b/g)?.length ?? 0)
    }, 0)
    expect(surfaces).toBe(4)
  })
})
