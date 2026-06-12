import { describe, it, expect } from 'vitest'
import {
  listTemplateSlots,
  instantiateTemplate,
  validateBindings,
  applyBindingsToDocument,
} from '../../src/design-canvas/templates'
import { createEmptyDocument } from '../../src/design-canvas/model'
import type { SceneDocument, TextElement, ImageElement, RectElement, EllipseElement } from '../../src/design-canvas/model'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0
function mintId(_sourceId: string): string {
  counter++
  return `minted-${counter}`
}

function resetCounter(): void {
  counter = 0
}

function makeTemplateDoc(): SceneDocument {
  const doc = createEmptyDocument('Test Template')
  const page = doc.pages[0]!

  const textEl: TextElement = {
    id: 'el-text',
    name: 'Headline',
    kind: 'text',
    x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
    text: 'Default headline',
    width: 800,
    fontFamily: 'Inter',
    fontSize: 48,
    fontStyle: 'bold',
    fill: '#000000',
    align: 'left',
    lineHeight: 1.2,
    letterSpacing: 0,
    slot: 'headline',
  }

  const imageEl: ImageElement = {
    id: 'el-image',
    name: 'Hero image',
    kind: 'image',
    x: 0, y: 200, rotation: 0, opacity: 1, locked: false, visible: true,
    width: 1080, height: 700,
    src: 'https://example.com/placeholder.jpg',
    fit: 'cover',
    slot: 'hero_image',
  }

  const rectEl: RectElement = {
    id: 'el-rect',
    name: 'Background swatch',
    kind: 'rect',
    x: 0, y: 900, rotation: 0, opacity: 1, locked: false, visible: true,
    width: 1080, height: 180,
    fill: '#ffffff',
    slot: 'bg_color',
  }

  page.elements.push(textEl, imageEl, rectEl)
  return doc
}

// ---------------------------------------------------------------------------
// listTemplateSlots
// ---------------------------------------------------------------------------

describe('listTemplateSlots', () => {
  it('returns one slot per slotted element with correct fillKind', () => {
    const doc = makeTemplateDoc()
    const slots = listTemplateSlots(doc)
    expect(slots).toHaveLength(3)

    const headline = slots.find((s) => s.name === 'headline')!
    expect(headline.fillKind).toBe('text')
    expect(headline.elementKind).toBe('text')

    const hero = slots.find((s) => s.name === 'hero_image')!
    expect(hero.fillKind).toBe('src')
    expect(hero.elementKind).toBe('image')

    const bg = slots.find((s) => s.name === 'bg_color')!
    expect(bg.fillKind).toBe('color')
    expect(bg.elementKind).toBe('rect')
  })

  it('returns fillKind src for video elements', () => {
    const doc = createEmptyDocument('vid')
    doc.pages[0]!.elements.push({
      id: 'v1', name: 'vid', kind: 'video',
      x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
      width: 1080, height: 1080, src: 'https://example.com/v.mp4',
      slot: 'video_slot',
    })
    const slots = listTemplateSlots(doc)
    expect(slots[0]!.fillKind).toBe('src')
  })

  it('returns fillKind color for ellipse elements', () => {
    const doc = createEmptyDocument('ell')
    const ellEl: EllipseElement = {
      id: 'e1', name: 'circle', kind: 'ellipse',
      x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
      width: 200, height: 200, fill: '#ff0000',
      slot: 'accent_color',
    }
    doc.pages[0]!.elements.push(ellEl)
    const slots = listTemplateSlots(doc)
    expect(slots[0]!.fillKind).toBe('color')
  })

  it('throws on duplicate slot names', () => {
    const doc = makeTemplateDoc()
    doc.pages[0]!.elements.push({
      id: 'el-dup', name: 'Dup', kind: 'text',
      x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
      text: 'dup', width: 400, fontFamily: 'Inter', fontSize: 24,
      fontStyle: 'normal', fill: '#000', align: 'left', lineHeight: 1, letterSpacing: 0,
      slot: 'headline', // duplicate
    })
    expect(() => listTemplateSlots(doc)).toThrow(/duplicate slot/)
  })
})

// ---------------------------------------------------------------------------
// validateBindings
// ---------------------------------------------------------------------------

describe('validateBindings', () => {
  it('returns empty array when all keys match slots', () => {
    const doc = makeTemplateDoc()
    const problems = validateBindings(doc, { headline: 'Hello', hero_image: 'https://x.com/img.jpg' })
    expect(problems).toEqual([])
  })

  it('reports unknown binding keys', () => {
    const doc = makeTemplateDoc()
    const problems = validateBindings(doc, { headline: 'Hi', unknown_slot: 'oops' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/unknown_slot/)
  })

  it('accepts empty bindings', () => {
    const doc = makeTemplateDoc()
    expect(validateBindings(doc, {})).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// instantiateTemplate — id re-minting
// ---------------------------------------------------------------------------

describe('instantiateTemplate — id uniqueness', () => {
  it('re-mints every page and element id', () => {
    resetCounter()
    const source = makeTemplateDoc()
    const instance = instantiateTemplate(source, { title: 'Instance 1', mintId })

    const sourceIds = new Set([
      source.pages[0]!.id,
      ...source.pages[0]!.elements.map((e) => e.id),
    ])
    const instanceIds = new Set([
      instance.pages[0]!.id,
      ...instance.pages[0]!.elements.map((e) => e.id),
    ])

    // No overlap between source and instance ids
    for (const id of instanceIds) {
      expect(sourceIds.has(id)).toBe(false)
    }

    // All instance ids are unique
    expect(instanceIds.size).toBe(instance.pages[0]!.elements.length + 1) // +1 for page
  })

  it('produces unique ids across two instantiations from the same template', () => {
    resetCounter()
    const source = makeTemplateDoc()
    const inst1 = instantiateTemplate(source, { title: 'Instance 1', mintId })
    const inst2 = instantiateTemplate(source, { title: 'Instance 2', mintId })

    const ids1 = new Set([inst1.pages[0]!.id, ...inst1.pages[0]!.elements.map((e) => e.id)])
    const ids2 = new Set([inst2.pages[0]!.id, ...inst2.pages[0]!.elements.map((e) => e.id)])

    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false)
    }
  })

  it('preserves slot names on re-minted elements', () => {
    resetCounter()
    const source = makeTemplateDoc()
    const instance = instantiateTemplate(source, { title: 'Slotted', mintId })
    const slots = listTemplateSlots(instance)
    const slotNames = slots.map((s) => s.name).sort()
    expect(slotNames).toEqual(['bg_color', 'headline', 'hero_image'])
  })
})

// ---------------------------------------------------------------------------
// instantiateTemplate — binding application
// ---------------------------------------------------------------------------

describe('instantiateTemplate — binding application', () => {
  it('applies text binding to text slot', () => {
    resetCounter()
    const source = makeTemplateDoc()
    const instance = instantiateTemplate(source, {
      title: 'Bound',
      bindings: { headline: 'Bound headline' },
      mintId,
    })
    const textEl = instance.pages[0]!.elements.find((e) => e.kind === 'text') as TextElement
    expect(textEl.text).toBe('Bound headline')
  })

  it('applies src binding to image slot', () => {
    resetCounter()
    const source = makeTemplateDoc()
    const instance = instantiateTemplate(source, {
      title: 'Bound',
      bindings: { hero_image: 'https://cdn.example.com/real.jpg' },
      mintId,
    })
    const imgEl = instance.pages[0]!.elements.find((e) => e.kind === 'image') as ImageElement
    expect(imgEl.src).toBe('https://cdn.example.com/real.jpg')
  })

  it('applies color binding to rect slot', () => {
    resetCounter()
    const source = makeTemplateDoc()
    const instance = instantiateTemplate(source, {
      title: 'Bound',
      bindings: { bg_color: '#ff5500' },
      mintId,
    })
    const rectEl = instance.pages[0]!.elements.find((e) => e.kind === 'rect') as RectElement
    expect(rectEl.fill).toBe('#ff5500')
  })

  it('applies partial bindings (unmentioned slots untouched)', () => {
    resetCounter()
    const source = makeTemplateDoc()
    const instance = instantiateTemplate(source, {
      title: 'Partial',
      bindings: { headline: 'Only headline' },
      mintId,
    })
    const imgEl = instance.pages[0]!.elements.find((e) => e.kind === 'image') as ImageElement
    expect(imgEl.src).toBe('https://example.com/placeholder.jpg') // unchanged
  })

  it('throws when bindings contain unknown keys', () => {
    resetCounter()
    const source = makeTemplateDoc()
    expect(() =>
      instantiateTemplate(source, {
        title: 'Bad',
        bindings: { nonexistent_slot: 'value' },
        mintId,
      }),
    ).toThrow(/nonexistent_slot/)
  })
})

// ---------------------------------------------------------------------------
// instantiateTemplate — metadata stamp
// ---------------------------------------------------------------------------

describe('instantiateTemplate — metadata', () => {
  it('stamps metadata.templateSourceId with the source document title', () => {
    resetCounter()
    const source = makeTemplateDoc()
    source.title = 'My Brand Template'
    const instance = instantiateTemplate(source, { title: 'Instance', mintId })
    expect(instance.metadata['templateSourceId']).toBe('My Brand Template')
  })

  it('sets the new document title', () => {
    resetCounter()
    const source = makeTemplateDoc()
    const instance = instantiateTemplate(source, { title: 'Campaign Q3', mintId })
    expect(instance.title).toBe('Campaign Q3')
  })

  it('preserves existing metadata fields alongside templateSourceId', () => {
    resetCounter()
    const source = makeTemplateDoc()
    source.metadata = { customField: 'preserved' }
    const instance = instantiateTemplate(source, { title: 'Instance', mintId })
    expect(instance.metadata['customField']).toBe('preserved')
    expect(instance.metadata['templateSourceId']).toBe(source.title)
  })
})

// ---------------------------------------------------------------------------
// instantiateTemplate — group children re-minting
// ---------------------------------------------------------------------------

describe('instantiateTemplate — group children', () => {
  it('re-mints ids for elements nested inside groups', () => {
    resetCounter()
    const doc = createEmptyDocument('Grouped template')
    const childText: TextElement = {
      id: 'child-text', name: 'child', kind: 'text',
      x: 10, y: 10, rotation: 0, opacity: 1, locked: false, visible: true,
      text: 'child', width: 200, fontFamily: 'Inter', fontSize: 16,
      fontStyle: 'normal', fill: '#000', align: 'left', lineHeight: 1.2, letterSpacing: 0,
      slot: 'group_text',
    }
    doc.pages[0]!.elements.push({
      id: 'group-1', name: 'Group', kind: 'group',
      x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
      children: [childText],
    })

    const instance = instantiateTemplate(doc, { title: 'Grouped', mintId })
    const group = instance.pages[0]!.elements[0]!
    expect(group.id).not.toBe('group-1')
    expect(group.kind).toBe('group')
    if (group.kind === 'group') {
      expect(group.children[0]!.id).not.toBe('child-text')
    }
  })
})

// ---------------------------------------------------------------------------
// applyBindingsToDocument (standalone export)
// ---------------------------------------------------------------------------

describe('applyBindingsToDocument', () => {
  it('applies bindings to an already-instantiated document', () => {
    resetCounter()
    const source = makeTemplateDoc()
    const instance = instantiateTemplate(source, { title: 'Step 1', mintId })
    const updated = applyBindingsToDocument(instance, { headline: 'Updated headline' })
    const textEl = updated.pages[0]!.elements.find((e) => e.kind === 'text') as TextElement
    expect(textEl.text).toBe('Updated headline')
  })

  it('throws for unknown binding keys', () => {
    const source = makeTemplateDoc()
    expect(() => applyBindingsToDocument(source, { no_such_slot: 'x' })).toThrow(/no_such_slot/)
  })
})
