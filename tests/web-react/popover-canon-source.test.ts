/**
 * Source-level half of the picker-canon popover invariant, plus the
 * package-wide generalization of it.
 *
 * `tests/web-react/popover-escapes-host.test.tsx` proves that the popovers
 * which exist TODAY portal out of a clipping host. It cannot see the sixth
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
 * Every non-test TSX file under web-react is scanned for the same
 * bg-popover + absolute anti-pattern. Rendered picker checks cover portal
 * behavior; this scan covers surfaces introduced after those cases.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AgentSessionControls } from '../../src/web-react/agent-session-controls'
import { POPOVER_SURFACE_ATTR } from '../../src/web-react/controls'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WEB_REACT_DIR = join(repoRoot, 'src/web-react')

function findOffenders(files: string[]): string[] {
  const offenders: string[] = []
  for (const file of files) {
    readFileSync(join(repoRoot, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (line.includes('bg-popover') && /\babsolute\b/.test(line)) offenders.push(`${file}:${i + 1}`)
      })
  }
  return offenders
}

/** Every non-test `.tsx` source file directly under `/web-react` — the whole
 *  surface a `bg-popover` panel can be authored on in this subpath. */
function webReactSourceFiles(): string[] {
  return readdirSync(WEB_REACT_DIR)
    .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
    .map((name) => join('src/web-react', name))
}

describe('web-react popovers: the anti-pattern is unrepresentable subpath-wide', () => {
  it('no `bg-popover` surface anywhere under /web-react positions itself with `absolute`', () => {
    const offenders = findOffenders(webReactSourceFiles())
    expect(
      offenders,
      'use PopoverSurface — an in-place absolute panel is what a host clips away (this check is not limited to the picker canon)',
    ).toEqual([])
  })
})

describe('picker canon: still server-renders', () => {
  // This file runs with NO DOM, which is the point: portaling brought
  // `react-dom` and viewport measurement onto a subpath every SSR product
  // renders on every request. What that buys is bounded and worth stating —
  // measured against react-dom 19.2.8, this goes red when a DOM read moves into
  // a component BODY (`window.innerWidth` in `PopoverSurface` → the render
  // throws), and it does NOT exercise the portal's own
  // `typeof document === 'undefined'` guard, which is unreachable here because
  // a picker is always closed on the server and `!open` returns first.
  it('renders the control cluster with no DOM and mounts no panel', () => {
    const html = renderToString(
        createElement(AgentSessionControls, {
          models: [
            {
              id: 'anthropic/claude-opus-4',
              name: 'Claude Opus 4',
              provider: 'anthropic',
              contextLength: 1_000_000,
              supportsTools: true,
              supportsReasoning: true,
              featured: true,
            },
          ],
          model: 'anthropic/claude-opus-4',
          onModelChange: () => {},
          harness: 'claude-code',
          onHarnessChange: () => {},
          effort: 'medium',
          onEffortChange: () => {},
        }),
    )

    expect(html).toContain('Claude Opus 4')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain(POPOVER_SURFACE_ATTR)
  })
})
