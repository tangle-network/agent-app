/**
 * The shell's type floor: nothing a product's shell, workspace listing, API
 * access panel or question card renders is smaller than 14px (`text-sm`).
 * Drew's rule for every agent product is one type scale and no tiny fonts;
 * these surfaces appear in all of them, so the floor is enforced here once.
 *
 * Scope is the source of those surfaces. A failure names the file and the
 * class; the fix is the next step up the shared scale, not a literal size.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const workspaceReact = readdirSync(join(ROOT, 'src/workspace-react'))
  .filter((name) => name.endsWith('.tsx') && !name.includes('.test.'))
  .map((name) => join(ROOT, 'src/workspace-react', name))
const FILES = [
  ...workspaceReact,
  join(ROOT, 'src/web-react/api-access-panel.tsx'),
  join(ROOT, 'src/web-react/interaction-question-card.tsx'),
  join(ROOT, 'src/web-react/workspace-switcher.tsx'),
]

/** Class tokens below 14px: Tailwind's `text-xs`, or a literal px/rem size under 14px / 0.875rem. */
function tinyTypeClasses(source: string): string[] {
  const hits: string[] = []
  for (const match of source.matchAll(/\btext-(?:xs|\[(\d+(?:\.\d+)?)(px|rem)\])/g)) {
    if (!match[1]) { hits.push(match[0]); continue }
    const px = Number(match[1]) * (match[2] === 'rem' ? 16 : 1)
    if (px < 14) hits.push(match[0])
  }
  return hits
}

describe('shell type floor', () => {
  it('detects text-xs and literal sizes under 14px, and passes the shared scale', () => {
    expect(tinyTypeClasses('a text-xs b text-[11px] c text-[0.75rem] d')).toEqual(['text-xs', 'text-[11px]', 'text-[0.75rem]'])
    expect(tinyTypeClasses('text-sm text-base text-[15px] text-[0.875rem] text-muted-foreground')).toEqual([])
  })

  for (const file of FILES) {
    it(`${relative(ROOT, file)} renders nothing under 14px`, () => {
      expect(tinyTypeClasses(readFileSync(file, 'utf8'))).toEqual([])
    })
  }
})
