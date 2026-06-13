/**
 * Tests for theme packs, layout archetypes, and the MCP scaffold tools.
 *
 * Three concerns:
 *   1. Contrast: every text-role pair in every ThemePack passes WCAG 4.5:1.
 *   2. Structure: every archetype × every theme builds a valid SceneDocument
 *      with the declared slots present and all positions finite / > 0 where
 *      required.
 *   3. Lint: when lint.ts is present, every archetype × every theme produces
 *      zero ERROR-severity lint findings.
 */

import { describe, it, expect } from 'vitest'
import {
  THEME_PACKS,
  requireThemePack,
} from '../../src/design-canvas/themes'
import type { ThemePack, ThemePalette } from '../../src/design-canvas/themes'
import {
  ARCHETYPE_DESCRIPTORS,
  buildArchetype,
  requireArchetypeDescriptor,
} from '../../src/design-canvas/archetypes'
import { collectSlots } from '../../src/design-canvas/model'
import { lintSceneDocument } from '../../src/design-canvas/lint'

// ---------------------------------------------------------------------------
// WCAG contrast math (same as used to verify palette values during authoring)
// ---------------------------------------------------------------------------

function hexToLinear(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return [lin(r), lin(g), lin(b)]
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToLinear(hex)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(fg: string, bg: string): number {
  const L1 = relativeLuminance(fg)
  const L2 = relativeLuminance(bg)
  const lighter = Math.max(L1, L2)
  const darker = Math.min(L1, L2)
  return (lighter + 0.05) / (darker + 0.05)
}

// ---------------------------------------------------------------------------
// Theme catalogue sanity
// ---------------------------------------------------------------------------

describe('ThemePack catalogue', () => {
  it('exports 6 theme packs', () => {
    expect(THEME_PACKS).toHaveLength(6)
  })

  it('every theme has a unique id', () => {
    const ids = THEME_PACKS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('requireThemePack throws on unknown id', () => {
    expect(() => requireThemePack('does-not-exist')).toThrow(/unknown theme id/)
  })

  it('every theme spacingUnit is 8', () => {
    for (const theme of THEME_PACKS) {
      expect(theme.spacingUnit).toBe(8)
    }
  })

  it('every theme has a 4-element radii tuple', () => {
    for (const theme of THEME_PACKS) {
      expect(theme.radii).toHaveLength(4)
      for (const r of theme.radii) {
        expect(typeof r).toBe('number')
        expect(r).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('every theme has a non-empty doctrine', () => {
    for (const theme of THEME_PACKS) {
      expect(theme.doctrine.length).toBeGreaterThan(80)
    }
  })

  it('size scales have 5 entries', () => {
    for (const theme of THEME_PACKS) {
      expect(theme.typography.display.sizeScale).toHaveLength(5)
      expect(theme.typography.body.sizeScale).toHaveLength(5)
    }
  })
})

// ---------------------------------------------------------------------------
// WCAG contrast tests — every text-role pair ≥ 4.5:1
// ---------------------------------------------------------------------------

describe('ThemePack palette contrast', () => {
  function checkPair(label: string, fg: string, bg: string): void {
    const ratio = contrastRatio(fg, bg)
    expect(ratio, `${label}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1 (needs 4.5:1)`).toBeGreaterThanOrEqual(4.5)
  }

  for (const theme of THEME_PACKS) {
    describe(`${theme.id} (${theme.name})`, () => {
      const p: ThemePalette = theme.palette

      it('textPrimary on background ≥ 4.5:1', () => {
        checkPair('textPrimary/background', p.textPrimary, p.background)
      })

      it('textSecondary on background ≥ 4.5:1', () => {
        checkPair('textSecondary/background', p.textSecondary, p.background)
      })

      it('textPrimary on surface ≥ 4.5:1', () => {
        checkPair('textPrimary/surface', p.textPrimary, p.surface)
      })

      it('accentText on accent ≥ 4.5:1', () => {
        checkPair('accentText/accent', p.accentText, p.accent)
      })
    })
  }
})

// ---------------------------------------------------------------------------
// Archetype catalogue sanity
// ---------------------------------------------------------------------------

describe('Archetype catalogue', () => {
  it('exports 10 archetype descriptors', () => {
    expect(ARCHETYPE_DESCRIPTORS).toHaveLength(10)
  })

  it('every archetype has a unique id', () => {
    const ids = ARCHETYPE_DESCRIPTORS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('requireArchetypeDescriptor throws on unknown id', () => {
    expect(() => requireArchetypeDescriptor('no-such-archetype')).toThrow(/unknown archetype id/)
  })

  it('every archetype declares at least one slot', () => {
    for (const arch of ARCHETYPE_DESCRIPTORS) {
      expect(arch.slots.length, `${arch.id} must have ≥1 slot`).toBeGreaterThan(0)
    }
  })

  it('every archetype has positive default dimensions', () => {
    for (const arch of ARCHETYPE_DESCRIPTORS) {
      expect(arch.defaultWidth, `${arch.id} defaultWidth`).toBeGreaterThan(0)
      expect(arch.defaultHeight, `${arch.id} defaultHeight`).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// buildArchetype — structure invariants across all theme × archetype combos
// ---------------------------------------------------------------------------

// Pre-build all combinations so we can reference them in individual it() tests
// without using `continue` (not valid in a describe block body under esbuild).
type ComboKey = `${string}__${string}`
const builtDocs = new Map<ComboKey, ReturnType<typeof buildArchetype>>()
const buildErrors = new Map<ComboKey, unknown>()

for (const arch of ARCHETYPE_DESCRIPTORS) {
  for (const theme of THEME_PACKS) {
    const key: ComboKey = `${arch.id}__${theme.id}`
    try {
      builtDocs.set(key, buildArchetype(arch.id, theme.id))
    } catch (err) {
      buildErrors.set(key, err)
    }
  }
}

describe('buildArchetype — structural invariants', () => {
  for (const arch of ARCHETYPE_DESCRIPTORS) {
    for (const theme of THEME_PACKS) {
      const key: ComboKey = `${arch.id}__${theme.id}`
      const buildError = buildErrors.get(key)
      const doc = builtDocs.get(key)

      describe(`${arch.id} × ${theme.id}`, () => {
        it('builds without throwing', () => {
          if (buildError !== undefined) throw buildError
          expect(doc).toBeDefined()
        })

        it('has correct schemaVersion', () => {
          if (!doc) return
          expect(doc.schemaVersion).toBe(1)
        })

        it('has at least one page', () => {
          if (!doc) return
          expect(doc.pages.length).toBeGreaterThan(0)
        })

        it('every page has positive dimensions', () => {
          if (!doc) return
          for (const page of doc.pages) {
            expect(page.width, `page ${page.id} width`).toBeGreaterThan(0)
            expect(page.height, `page ${page.id} height`).toBeGreaterThan(0)
          }
        })

        it('every page has at least one element', () => {
          if (!doc) return
          for (const page of doc.pages) {
            expect(page.elements.length, `page ${page.id} must have elements`).toBeGreaterThan(0)
          }
        })

        it('every element has finite x/y', () => {
          if (!doc) return
          for (const page of doc.pages) {
            for (const el of page.elements) {
              expect(Number.isFinite(el.x), `${el.id} x`).toBe(true)
              expect(Number.isFinite(el.y), `${el.id} y`).toBe(true)
            }
          }
        })

        it('no text element has empty text', () => {
          if (!doc) return
          for (const page of doc.pages) {
            const walk = (elements: typeof page.elements): void => {
              for (const el of elements) {
                if (el.kind === 'text') {
                  expect(el.text.trim().length, `text element ${el.id} text must not be empty`).toBeGreaterThan(0)
                }
                if (el.kind === 'group') walk(el.children)
              }
            }
            walk(page.elements)
          }
        })

        it('declared slots are all present in the document', () => {
          if (!doc) return
          const slots = collectSlots(doc)
          for (const slotName of arch.slots) {
            expect(slots.has(slotName), `slot "${slotName}" missing from ${arch.id} × ${theme.id}`).toBe(true)
          }
        })

        it('no duplicate slot names', () => {
          if (!doc) return
          expect(() => collectSlots(doc)).not.toThrow()
        })

        it('all element positions are on an 8-px grid (± 1 for rounding)', () => {
          if (!doc) return
          for (const page of doc.pages) {
            for (const el of page.elements) {
              expect(el.x % 8, `${el.id} x=${el.x} not on 8px grid`).toBeLessThanOrEqual(1)
              expect(el.y % 8, `${el.id} y=${el.y} not on 8px grid`).toBeLessThanOrEqual(1)
            }
          }
        })

        it('zero lint ERROR findings', () => {
          if (!doc) return
          const report = lintSceneDocument(doc)
          const errors = report.pages.flatMap((p) =>
            p.findings.filter((f) => f.severity === 'error').map((f) => `${p.pageName}: [${f.rule}] ${f.message}`),
          )
          expect(errors, `lint errors in ${arch.id} × ${theme.id}:\n${errors.join('\n')}`).toHaveLength(0)
        })
      })
    }
  }
})

// ---------------------------------------------------------------------------
// buildArchetype — throws on invalid ids
// ---------------------------------------------------------------------------

describe('buildArchetype — invalid ids', () => {
  it('throws on unknown archetype id', () => {
    expect(() => buildArchetype('no-such', 'bold-editorial')).toThrow(/unknown archetype id/)
  })

  it('throws on unknown theme id', () => {
    expect(() => buildArchetype('hero-statement', 'no-such-theme')).toThrow(/unknown theme id/)
  })
})

// ---------------------------------------------------------------------------
// Slot coverage: each archetype × theme exposes exactly the declared slots
// (no extra, no missing)
// ---------------------------------------------------------------------------

describe('Slot coverage', () => {
  for (const arch of ARCHETYPE_DESCRIPTORS) {
    it(`${arch.id} slot coverage is complete (no missing, no extra undeclared)`, () => {
      const doc = buildArchetype(arch.id, 'clean-saas')
      const actualSlots = collectSlots(doc)
      const declared = new Set(arch.slots)

      // All declared slots must be present
      for (const s of declared) {
        expect(actualSlots.has(s), `declared slot "${s}" missing`).toBe(true)
      }

      // All actual slots must be declared (no hidden extras that would surprise apply_data callers)
      for (const [name] of actualSlots) {
        expect(declared.has(name), `undeclared slot "${name}" found in document`).toBe(true)
      }
    })
  }
})
