/**
 * Makes "Save to vault is unclickable from inside the viewer" unrepresentable:
 * the path popover must sit above the viewer backdrop and below the delete
 * confirm — a real bug the design prototype hit.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function studioLayerZ(css: string, selector: string): number {
  const rule = new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`).exec(css)
  if (!rule?.[1]) throw new Error(`studio.css: missing .${selector} rule`)

  const zIndex = /\bz-index:\s*(\d+)\s*;/.exec(rule[1])
  if (!zIndex?.[1]) throw new Error(`studio.css: missing z-index in .${selector}`)
  return Number(zIndex[1])
}

function popoverSurfaceZ(source: string): number {
  const component = /export function PopoverSurface\b([\s\S]*?)(?=\nexport (?:function|interface|type|const)\b)/.exec(source)
  if (!component?.[1]) throw new Error('controls.tsx: could not locate PopoverSurface')

  const zIndex = /\bz-\[(\d+)\]/.exec(component[1])
  if (!zIndex?.[1]) {
    throw new Error('controls.tsx: missing z-[N] utility on PopoverSurface; update this gate deliberately')
  }
  return Number(zIndex[1])
}

describe('studio layer ladder', () => {
  it('keeps the viewer below popovers, confirms above popovers, and toasts above confirms', () => {
    const css = readFileSync(join(repoRoot, 'src/studio-react/studio.css'), 'utf8')
    const controls = readFileSync(join(repoRoot, 'src/web-react/controls.tsx'), 'utf8')

    const viewer = studioLayerZ(css, 'studio-layer-viewer')
    const popover = popoverSurfaceZ(controls)
    const confirm = studioLayerZ(css, 'studio-layer-confirm')
    const toasts = studioLayerZ(css, 'studio-layer-toasts')

    expect(viewer, 'viewer must stay below PopoverSurface').toBeLessThan(popover)
    expect(popover, 'PopoverSurface must stay below delete confirms').toBeLessThan(confirm)
    expect(confirm, 'delete confirms must stay below toasts').toBeLessThan(toasts)
  })
})
